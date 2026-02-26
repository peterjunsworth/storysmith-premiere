/**
 * StorySmith Transcript Extraction Backend
 *
 * This Node.js server provides file system access for the UXP plugin
 * to extract transcripts from Premiere Pro's cache directories.
 *
 * Run: node server.js
 * Access: http://localhost:3000
 */

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'StorySmith Transcript Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

/**
 * Extract project GUID from .prproj file
 * POST /project-info
 * Body: { projectPath: "/path/to/project.prproj" }
 */
app.post('/project-info', async (req, res) => {
  try {
    const { projectPath } = req.body;

    if (!projectPath) {
      return res.status(400).json({ error: 'projectPath is required' });
    }

    if (!fs.existsSync(projectPath)) {
      return res.status(404).json({ error: 'Project file not found' });
    }

    // Decompress .prproj (gzip-compressed XML)
    const xmlContent = await decompressGzip(projectPath);

    // Extract GUID
    const guidMatch = xmlContent.match(/MZ\.Project\.GUID['"]\s*value=['"]([^'"]+)['"]/);
    const projectGuid = guidMatch ? guidMatch[1] : null;

    // Extract project name
    const nameMatch = xmlContent.match(/<name>([^<]+)<\/name>/i);
    const projectName = nameMatch ? nameMatch[1] : path.basename(projectPath, '.prproj');

    res.json({
      success: true,
      projectPath,
      projectName,
      projectGuid,
      xmlSize: xmlContent.length
    });

  } catch (error) {
    console.error('Error extracting project info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Extract transcripts from Media Cache database
 * POST /transcripts
 * Body: {
 *   projectGuid: "xxx-xxx-xxx" (optional),
 *   projectPath: "/path/to/project.prproj" (optional),
 *   filePaths: [...] (optional - filter by file paths),
 *   clipNames: [...] (optional - filter by clip names from sequences)
 * }
 */
app.post('/transcripts', async (req, res) => {
  try {
    let { projectGuid, projectPath, filePaths, clipNames } = req.body;

    // If projectPath provided and looks like a full path (not just a name), extract GUID first
    if (projectPath && !projectGuid && projectPath.includes('/')) {
      try {
        const xmlContent = await decompressGzip(projectPath);
        const guidMatch = xmlContent.match(/MZ\.Project\.GUID['"]\s*value=['"]([^'"]+)['"]/);
        projectGuid = guidMatch ? guidMatch[1] : null;
      } catch (err) {
        console.warn('Could not extract GUID from project path:', err.message);
      }
    }

    // Get list of Media Cache databases to search
    let mediaCacheDbs = [];

    if (projectGuid) {
      // Search specific project database
      const mediaCacheDb = getMediaCachePath(projectGuid);
      if (fs.existsSync(mediaCacheDb)) {
        mediaCacheDbs.push(mediaCacheDb);
      }
    } else {
      // No project GUID - search ALL Media Cache databases (UXP fallback)
      console.log('No project GUID available - searching all Media Cache databases');
      const platform = os.platform();
      const home = os.homedir();

      let basePath;
      if (platform === 'darwin') {
        basePath = path.join(home, 'Library/Application Support/Adobe/Common/Media Cache Files');
      } else if (platform === 'win32') {
        basePath = path.join(process.env.LOCALAPPDATA, 'Adobe/Common/Media Cache Files');
      } else {
        basePath = path.join(home, '.config/Adobe/Common/Media Cache Files');
      }

      if (fs.existsSync(basePath)) {
        const files = fs.readdirSync(basePath);
        mediaCacheDbs = files
          .filter(f => f.endsWith('.prmdc2'))
          .map(f => path.join(basePath, f));
        console.log(`Found ${mediaCacheDbs.length} Media Cache database(s) to search`);
      }
    }

    if (mediaCacheDbs.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No Media Cache databases found',
        suggestion: 'Project may not have been opened in Premiere Pro yet'
      });
    }

    // Query all databases for completed transcripts
    let allTranscripts = [];

    for (const mediaCacheDb of mediaCacheDbs) {
      try {
        const db = new sqlite3.Database(mediaCacheDb, sqlite3.OPEN_READONLY);

        // Query for files with completed transcripts
        const transcripts = await new Promise((resolve, reject) => {
          db.all(`
            SELECT
              columnintrinsicfilename,
              columnintrinsictranscriptstatus,
              columnintrinsicfilepath,
              columnintrinsicaudioinfo
            FROM StringTable
            WHERE columnintrinsictranscriptstatus LIKE '%omplete%'
          `, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });

        // Also query for files without transcript status (like video files)
        // but only if we have specific clip names to search for
        if (clipNames && clipNames.length > 0) {
          const filesWithoutTranscripts = await new Promise((resolve, reject) => {
            db.all(`
              SELECT DISTINCT
                columnintrinsicfilename,
                columnintrinsictranscriptstatus,
                columnintrinsicfilepath,
                columnintrinsicaudioinfo
              FROM StringTable
              WHERE columnintrinsicfilepath IS NOT NULL
                AND columnintrinsicfilename IS NOT NULL
            `, (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            });
          });

          // Merge the results, avoiding duplicates
          const existingPaths = new Set(transcripts.map(t => t.columnintrinsicfilepath));
          for (const file of filesWithoutTranscripts) {
            if (!existingPaths.has(file.columnintrinsicfilepath)) {
              transcripts.push(file);
            }
          }
        }

        db.close();
        allTranscripts = allTranscripts.concat(transcripts);
      } catch (err) {
        console.error(`Error querying ${mediaCacheDb}:`, err.message);
        // Continue with other databases
      }
    }

    if (allTranscripts.length === 0) {
      return res.json({
        success: false,
        transcripts: [],
        message: 'No completed transcripts found in Media Cache',
        searchedDatabases: mediaCacheDbs.length
      });
    }

    // Try to find actual transcript files
    const transcriptsWithData = [];

    for (const transcript of allTranscripts) {
      // Filter by file paths or clip names if provided
      if ((filePaths && filePaths.length > 0) || (clipNames && clipNames.length > 0)) {
        let matches = false;

        // Try to match by file path
        if (filePaths && filePaths.length > 0) {
          matches = filePaths.some(fp =>
            transcript.columnintrinsicfilepath &&
            (transcript.columnintrinsicfilepath === fp ||
             transcript.columnintrinsicfilepath.endsWith(fp) ||
             fp.endsWith(transcript.columnintrinsicfilename))
          );
        }

        // If no file path match, try to match by clip name
        if (!matches && clipNames && clipNames.length > 0) {
          matches = clipNames.some(name => {
            if (!transcript.columnintrinsicfilename) return false;

            const dbName = (transcript.columnintrinsicfilename || '').toLowerCase().trim();
            const searchName = (name || '').toLowerCase().trim();

            // Direct match
            if (dbName === searchName) return true;

            // Match with dots replaced by spaces (podcast.wav -> podcast wav)
            const searchNameWithSpaces = searchName.replace(/\./g, ' ');
            if (dbName === searchNameWithSpaces) return true;

            // Match with extension removed (podcast.wav -> podcast)
            const nameWithoutExt = searchName.replace(/\.[^.]+$/, '').trim();
            if (dbName === nameWithoutExt || dbName.startsWith(nameWithoutExt + ' ')) {
              return true;
            }

            return false;
          });
        }

        if (!matches) continue;
      }

      const transcriptData = {
        clipName: transcript.columnintrinsicfilename,
        filePath: fixFilePath(transcript.columnintrinsicfilepath),
        status: transcript.columnintrinsictranscriptstatus,
        audioInfo: transcript.columnintrinsicaudioinfo,
        transcriptText: null,
        source: 'status_only'
      };

      // Try to find transcript file in MetadataIndexer
      const transcriptFile = await findTranscriptFile(transcript.columnintrinsicfilepath);
      if (transcriptFile) {
        transcriptData.transcriptText = transcriptFile.text;
        transcriptData.segments = transcriptFile.segments;
        transcriptData.source = 'cache_file';
      }

      transcriptsWithData.push(transcriptData);
    }

    res.json({
      success: true,
      projectGuid,
      searchedDatabases: mediaCacheDbs.length,
      transcripts: transcriptsWithData,
      totalFound: transcriptsWithData.length
    });

  } catch (error) {
    console.error('Error extracting transcripts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Fix file path from Media Cache database
 * The database stores paths with ALL separators converted to spaces
 * Example: " Volumes Macintosh HD Users foo Documents storysmith premiere podcast wav "
 *       -> "/Volumes/Macintosh HD/Users/foo/Documents/storysmith-premiere/podcast.wav"
 *
 * Strategy: Use filesystem to reconstruct the actual path by checking what exists
 */
function fixFilePath(dbPath) {
  if (!dbPath) return '';

  // Remove leading/trailing spaces and normalize
  const parts = dbPath.trim().split(/\s+/).filter(p => p.length > 0);

  if (parts.length === 0) return '';

  // Handle macOS /Volumes paths
  if (parts[0] === 'Volumes' || parts[0] === '/Volumes') {
    let idx = 0;

    // Start with /Volumes
    let currentPath = '/Volumes';

    // Skip the "Volumes" part if present
    if (parts[idx] === 'Volumes' || parts[idx] === '/Volumes') {
      idx++;
    }

    // Handle multi-word volume names (e.g., "Macintosh HD")
    if (idx < parts.length) {
      const volumeName = parts[idx];
      idx++;

      // Check for "Macintosh HD" or similar multi-word volumes
      if (volumeName === 'Macintosh' && idx < parts.length && parts[idx] === 'HD') {
        currentPath += '/Macintosh HD';
        idx++;
      } else {
        currentPath += '/' + volumeName;
      }
    }

    // Now reconstruct the rest of the path
    // Try to match parts with filesystem, considering that:
    // - "storysmith-premiere" became "storysmith premiere"
    // - "podcast.wav" became "podcast wav"

    while (idx < parts.length) {
      // Try progressively longer combinations
      let found = false;

      // Try single part first
      let testPath = currentPath + '/' + parts[idx];
      if (fs.existsSync(testPath)) {
        currentPath = testPath;
        idx++;
        found = true;
      } else {
        // Try with hyphen (for names like "storysmith-premiere")
        if (idx + 1 < parts.length) {
          testPath = currentPath + '/' + parts[idx] + '-' + parts[idx + 1];
          if (fs.existsSync(testPath)) {
            currentPath = testPath;
            idx += 2;
            found = true;
          }
        }

        // Try with dot (for file extensions like "podcast.wav")
        if (!found && idx + 1 < parts.length) {
          testPath = currentPath + '/' + parts[idx] + '.' + parts[idx + 1];
          if (fs.existsSync(testPath)) {
            currentPath = testPath;
            idx += 2;
            found = true;
          }
        }

        // If nothing worked, just append with slash
        if (!found) {
          currentPath += '/' + parts[idx];
          idx++;
        }
      }
    }

    return currentPath;
  }

  // For non-Volumes paths, start from root
  let currentPath = '';
  let idx = 0;

  // Skip leading slash if present
  if (parts[0] === '' || parts[0] === '/') {
    idx++;
  }

  while (idx < parts.length) {
    let found = false;

    // Try single part
    let testPath = currentPath + '/' + parts[idx];
    if (fs.existsSync(testPath)) {
      currentPath = testPath;
      idx++;
      found = true;
    } else {
      // Try with hyphen
      if (idx + 1 < parts.length) {
        testPath = currentPath + '/' + parts[idx] + '-' + parts[idx + 1];
        if (fs.existsSync(testPath)) {
          currentPath = testPath;
          idx += 2;
          found = true;
        }
      }

      // Try with dot
      if (!found && idx + 1 < parts.length) {
        testPath = currentPath + '/' + parts[idx] + '.' + parts[idx + 1];
        if (fs.existsSync(testPath)) {
          currentPath = testPath;
          idx += 2;
          found = true;
        }
      }

      // Just append
      if (!found) {
        currentPath += '/' + parts[idx];
        idx++;
      }
    }
  }

  return currentPath;
}

/**
 * Get platform-specific Media Cache path
 */
function getMediaCachePath(projectGuid) {
  const platform = os.platform();
  const home = os.homedir();

  let basePath;

  if (platform === 'darwin') {
    basePath = path.join(home, 'Library/Application Support/Adobe/Common/Media Cache Files');
  } else if (platform === 'win32') {
    basePath = path.join(process.env.LOCALAPPDATA, 'Adobe/Common/Media Cache Files');
  } else {
    // Linux
    basePath = path.join(home, '.config/Adobe/Common/Media Cache Files');
  }

  // Find database file matching GUID
  if (fs.existsSync(basePath)) {
    const files = fs.readdirSync(basePath);
    const dbFile = files.find(f => f.includes(projectGuid) && f.endsWith('.prmdc2'));
    if (dbFile) {
      return path.join(basePath, dbFile);
    }
  }

  // Fallback: construct expected path
  return path.join(basePath, `StorySmith${projectGuid}.prmdc2`);
}

/**
 * Find transcript file in MetadataIndexer directories
 */
async function findTranscriptFile(mediaFilePath) {
  const platform = os.platform();
  const home = os.homedir();

  let transcriptBase;

  if (platform === 'darwin') {
    transcriptBase = path.join(home, 'Library/Application Support/Adobe/Common/MetadataIndexer/Transcripts-1');
  } else if (platform === 'win32') {
    transcriptBase = path.join(process.env.APPDATA, 'Adobe/Common/MetadataIndexer/Transcripts-1');
  } else {
    transcriptBase = path.join(home, '.config/Adobe/Common/MetadataIndexer/Transcripts-1');
  }

  if (!fs.existsSync(transcriptBase)) {
    return null;
  }

  // Get all GUID directories
  const guidDirs = fs.readdirSync(transcriptBase);

  // Search for non-empty directories
  for (const guid of guidDirs) {
    const guidPath = path.join(transcriptBase, guid);
    const stats = fs.statSync(guidPath);

    if (stats.isDirectory()) {
      const files = fs.readdirSync(guidPath);

      if (files.length > 0) {
        // Found a transcript file!
        const transcriptFile = path.join(guidPath, files[0]);
        const content = fs.readFileSync(transcriptFile, 'utf8');

        // Try to parse (format is unknown until we see a real file)
        try {
          const parsed = JSON.parse(content);
          return {
            text: JSON.stringify(parsed, null, 2),
            segments: parsed.segments || parsed.captions || []
          };
        } catch (e) {
          // Not JSON, return as plain text
          return {
            text: content,
            segments: []
          };
        }
      }
    }
  }

  return null;
}

/**
 * Decompress gzip file
 */
function decompressGzip(filePath) {
  return new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    let data = '';

    readStream.pipe(gunzip)
      .on('data', (chunk) => {
        data += chunk.toString('utf-8');
      })
      .on('end', () => {
        resolve(data);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

/**
 * Webhook proxy endpoint
 * POST /webhook-proxy
 * Body: { webhookUrl: "https://...", data: {...} }
 */
app.post('/webhook-proxy', async (req, res) => {
  try {
    const { webhookUrl, data } = req.body;

    if (!webhookUrl || !data) {
      return res.status(400).json({ error: 'webhookUrl and data are required' });
    }

    console.log(`\n📤 Proxying webhook request to: ${webhookUrl}`);
    console.log(`📦 Data size: ${JSON.stringify(data).length} bytes`);

    // Forward the request to the webhook using native fetch (Node.js 18+)
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    const responseText = await response.text();

    console.log(`✅ Webhook responded: ${response.status} ${response.statusText}`);

    res.json({
      success: true,
      status: response.status,
      statusText: response.statusText,
      response: responseText
    });

  } catch (error) {
    console.error('❌ Webhook proxy error:', error);
    res.status(500).json({
      error: 'Failed to forward webhook request',
      message: error.message
    });
  }
});

/**
 * Proxy to semantic-clip-search-tool server
 * These endpoints forward requests to the indexing/search service on port 3100
 */
const SEARCH_SERVER = 'http://localhost:3100';

// POST /index - Queue timeline for indexing
app.post('/index', async (req, res) => {
  try {
    const response = await fetch(`${SEARCH_SERVER}/index`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error (/index):', error.message);
    res.status(503).json({
      error: 'Search service unavailable',
      message: 'Make sure the semantic-clip-search-tool server is running on port 3100'
    });
  }
});

// GET /status/progress - Get overall system status
app.get('/status/progress', async (req, res) => {
  try {
    const response = await fetch(`${SEARCH_SERVER}/status/progress`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error (/status/progress):', error.message);
    res.status(503).json({
      error: 'Search service unavailable',
      chromaOk: false,
      ollamaOk: false
    });
  }
});

// GET /status/progress/:jobId - Get job progress
app.get('/status/progress/:jobId', async (req, res) => {
  try {
    const response = await fetch(`${SEARCH_SERVER}/status/progress/${encodeURIComponent(req.params.jobId)}`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error(`Proxy error (/status/progress/${req.params.jobId}):`, error.message);
    res.status(503).json({
      error: 'Search service unavailable'
    });
  }
});

// POST /search - Semantic search
app.post('/search', async (req, res) => {
  try {
    const response = await fetch(`${SEARCH_SERVER}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Proxy error (/search):', error.message);
    res.status(503).json({
      error: 'Search service unavailable',
      message: 'Make sure the semantic-clip-search-tool server is running on port 3100'
    });
  }
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log('━'.repeat(60));
  console.log('✅ StorySmith Transcript Backend Server');
  console.log('━'.repeat(60));
  console.log(`🌐 Server running on http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Platform: ${os.platform()}`);
  console.log(`🏠 Home directory: ${os.homedir()}`);
  console.log('');
  console.log('📡 Available endpoints:');
  console.log('  GET  /health                   - Check server status');
  console.log('  POST /project-info             - Extract project GUID');
  console.log('  POST /transcripts              - Extract transcripts from cache');
  console.log('  POST /webhook-proxy            - Forward data to external webhook');
  console.log('  POST /index                    - Queue timeline for indexing (proxied)');
  console.log('  GET  /status/progress          - Get system status (proxied)');
  console.log('  GET  /status/progress/:jobId   - Get job progress (proxied)');
  console.log('  POST /search                   - Semantic search (proxied)');
  console.log('');
  console.log(`⚙️  Proxying search/indexing requests to: ${SEARCH_SERVER}`);
  console.log('');
  console.log('💡 Keep this terminal open while using the StorySmith UXP plugin');
  console.log('━'.repeat(60));
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down server...');
  process.exit(0);
});
