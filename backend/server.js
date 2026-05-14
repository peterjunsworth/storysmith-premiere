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
    console.log('\n' + '='.repeat(80));
    console.log('📨 /transcripts endpoint called');
    console.log('='.repeat(80));

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

    // Debug: Log incoming request
    console.log('\n🔍 DEBUG /transcripts request:');
    console.log('  projectPath:', projectPath);
    console.log('  projectGuid:', projectGuid);
    console.log('  filePaths:', filePaths);
    console.log('  clipNames:', clipNames ? clipNames.slice(0, 5) : null, clipNames && clipNames.length > 5 ? `... (${clipNames.length} total)` : '');

    // Query all databases for completed transcripts
    let allTranscripts = [];

    for (const mediaCacheDb of mediaCacheDbs) {
      try {
        console.log(`\n🔍 Querying database: ${path.basename(mediaCacheDb)}`);
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
            else {
              console.log(`   Found ${rows.length} completed transcripts`);
              resolve(rows);
            }
          });
        });

        // Also query for files without transcript status (like video files)
        // but only if we have specific clip names to search for
        if (clipNames && clipNames.length > 0) {
          console.log(`   Searching for ${clipNames.length} specific clip names...`);
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
              else {
                console.log(`   Found ${rows.length} total files in database`);
                resolve(rows);
              }
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
      console.log('\n⚠️  No transcripts found in any database');
      return res.json({
        success: false,
        transcripts: [],
        message: 'No completed transcripts found in Media Cache',
        searchedDatabases: mediaCacheDbs.length
      });
    }

    console.log(`\n✅ Total transcripts found across all databases: ${allTranscripts.length}`);
    console.log(`📋 Filtering for ${clipNames ? clipNames.length : 0} clip names`);

    // Try to find actual transcript files
    const transcriptsWithData = [];

    for (const transcript of allTranscripts) {
      // Debug: Show what we're processing
      console.log(`\n🔍 Processing: ${transcript.columnintrinsicfilename}`);

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
            if (dbName === searchName) {
              console.log(`   ✅ Matched by direct name: "${searchName}"`);
              return true;
            }

            // Match with dots replaced by spaces (podcast.wav -> podcast wav)
            const searchNameWithSpaces = searchName.replace(/\./g, ' ');
            if (dbName === searchNameWithSpaces) {
              console.log(`   ✅ Matched by spaces: "${searchNameWithSpaces}"`);
              return true;
            }

            // Match with extension removed (podcast.wav -> podcast)
            const nameWithoutExt = searchName.replace(/\.[^.]+$/, '').trim();
            if (dbName === nameWithoutExt || dbName.startsWith(nameWithoutExt + ' ')) {
              console.log(`   ✅ Matched by name without ext: "${nameWithoutExt}"`);
              return true;
            }

            return false;
          });
        }

        if (!matches) {
          console.log(`   ❌ No match found, skipping`);
          continue;
        }
      }

      console.log(`   🎯 Processing matched clip...`);

      const transcriptData = {
        clipName: transcript.columnintrinsicfilename,
        filePath: fixFilePath(transcript.columnintrinsicfilepath),
        status: transcript.columnintrinsictranscriptstatus,
        audioInfo: transcript.columnintrinsicaudioinfo,
        transcriptText: null,
        source: 'status_only'
      };

      // Debug: Log path transformation
      console.log(`\n📂 Clip: ${transcriptData.clipName}`);
      console.log(`   DB STRING: "${transcript.columnintrinsicfilepath}"`);
      console.log(`   CONVERTED: "${transcriptData.filePath}"`);
      console.log('');

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
/**
 * Helper function to find the longest existing path prefix by working backwards
 */
function findLongestValidPrefix(parts, basePrefix, startIdx) {
  // Try progressively shorter paths from full length down to startIdx
  for (let endIdx = parts.length; endIdx >= startIdx; endIdx--) {
    const pathParts = parts.slice(startIdx, endIdx);
    if (pathParts.length === 0) continue;

    const testPath = basePrefix + '/' + pathParts.join('/');
    if (fs.existsSync(testPath)) {
      return {
        validPrefix: testPath,
        remainingIdx: endIdx
      };
    }
  }

  // No valid prefix found, start from base
  return {
    validPrefix: basePrefix,
    remainingIdx: startIdx
  };
}

/**
 * Generate candidate path combinations with different separators
 * Returns array sorted by length (longest first) to maximize greedy matching
 *
 * Handles special characters like colons that appear in macOS folder names.
 * Example: "Penny Van:Hiking" or "02:17:2024"
 */
function generateCandidates(basePath, parts, idx) {
  const candidates = [];
  const remainingWords = parts.length - idx;

  // Try progressively longer multi-word combinations with various separators
  // Start from longest possible (up to 10 words) down to 1 word
  const maxWords = Math.min(10, remainingWords);

  for (let wordCount = maxWords; wordCount >= 1; wordCount--) {
    if (idx + wordCount - 1 < parts.length) {
      const words = parts.slice(idx, idx + wordCount);

      // Strategy 1: Multi-word with spaces (highest priority for longer combinations)
      const spacePath = basePath + '/' + words.join(' ');
      candidates.push({
        length: wordCount,
        path: spacePath,
        priority: wordCount * 10,
        separator: 'space'
      });

      // Strategy 2: Try all possible combinations of colons and spaces for multi-word
      // Example: "Penny Van Hiking" could be "Penny Van:Hiking" or "Penny Van Hiking"
      if (wordCount >= 2 && wordCount <= 5) {
        // Generate all possible colon/space combinations
        const separatorCombinations = generateSeparatorCombinations(wordCount - 1);

        for (const separators of separatorCombinations) {
          let combinedPath = basePath + '/' + words[0];
          for (let i = 1; i < words.length; i++) {
            combinedPath += separators[i - 1] + words[i];
          }

          candidates.push({
            length: wordCount,
            path: combinedPath,
            priority: wordCount * 10 + 1, // Slightly higher priority than space-only
            separator: 'mixed'
          });
        }
      }

      // Strategy 5: File extensions - HIGHEST PRIORITY for last 2 words
      // Detect if this looks like a file name + extension pattern
      if (wordCount === 2 && idx + 2 === parts.length) {
        const possibleExtension = parts[idx + 1].toLowerCase();
        const commonExtensions = ['mov', 'mp4', 'wav', 'mp3', 'aac', 'm4a', 'avi', 'mkv', 'mxf',
                                  'aiff', 'flac', 'jpg', 'png', 'pdf', 'txt', 'prproj', 'aep'];

        if (commonExtensions.includes(possibleExtension) || possibleExtension.length <= 4) {
          // This looks like a file extension - prioritize dot separator
          candidates.push({
            length: 2,
            path: basePath + '/' + parts[idx] + '.' + parts[idx+1],
            priority: 100, // VERY HIGH PRIORITY for file extensions
            separator: 'file-extension'
          });
        }
      }

      // Strategy 6: Other 2-character separators
      if (wordCount === 2) {
        const twoWordSeparators = [':', '-', '_', '/'];
        for (const sep of twoWordSeparators) {
          candidates.push({
            length: 2,
            path: basePath + '/' + parts[idx] + sep + parts[idx+1],
            priority: sep === ':' ? 5 : 2,
            separator: sep === ':' ? 'colon' : sep === '/' ? 'slash' : sep
          });
        }
      }

      // Strategy 7: Triple-character patterns for dates/times
      if (wordCount === 3) {
        const triplePatterns = [
          { sep: ':', name: 'triple-colon', priority: 8 },    // 02:17:2024
          { sep: '/', name: 'triple-slash', priority: 8 },    // 02/17/2024
          { sep: '-', name: 'triple-hyphen', priority: 7 }    // 02-17-2024
        ];

        for (const pattern of triplePatterns) {
          candidates.push({
            length: 3,
            path: basePath + '/' + parts[idx] + pattern.sep + parts[idx+1] + pattern.sep + parts[idx+2],
            priority: pattern.priority,
            separator: pattern.name
          });
        }
      }
    }
  }

  // Sort by priority (higher first), then by length (longer first)
  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.length - a.length;
  });
}

/**
 * Generate all combinations of separators for n positions
 * Separators include: space, colon, slash (for dates), hyphen, underscore, period
 * Returns array of arrays, where each inner array contains n separators
 */
function generateSeparatorCombinations(n) {
  if (n === 0) return [[]];
  if (n === 1) return [[' '], [':'], ['-'], ['_'], ['.'], ['/']];

  const combinations = [];

  // Limit combinations to avoid explosion
  if (n > 3) {
    // For longer paths, only try key patterns
    return [
      Array(n).fill(' '),           // All spaces
      Array(n).fill(':'),           // All colons (e.g., "12:30:45")
      [' ', ...Array(n-1).fill(':')], // Space first, rest colons
      [...Array(n-1).fill(' '), ':'],  // Spaces first, last colon
      Array(n).fill('-'),           // All hyphens
      Array(n).fill('_'),           // All underscores
      Array(n).fill('/'),           // All slashes (for dates like 02/17/2024)
    ];
  }

  // For 2-3 positions, try common patterns
  const commonPatterns = [
    Array(n).fill(' '),           // All spaces
    Array(n).fill(':'),           // All colons
    Array(n).fill('-'),           // All hyphens
    Array(n).fill('_'),           // All underscores
    Array(n).fill('/'),           // All slashes
    [' ', ':'],                   // Space then colon
    [':', ' '],                   // Colon then space
    [' ', '-'],                   // Space then hyphen
    ['-', ' '],                   // Hyphen then space
  ];

  // Only return patterns that match the required length
  return commonPatterns.filter(p => p.length === n);
}

/**
 * Reconstruct path from remaining parts using prioritized multi-word strategies
 */
function reconstructPath(basePrefix, parts, startIdx) {
  let currentPath = basePrefix;
  let idx = startIdx;

  while (idx < parts.length) {
    const candidates = generateCandidates(currentPath, parts, idx);
    let matched = false;

    // Try each candidate in priority order
    for (const candidate of candidates) {
      if (fs.existsSync(candidate.path)) {
        currentPath = candidate.path;
        idx += candidate.length;
        matched = true;
        break;
      }
    }

    // If nothing matched, append single word and continue
    if (!matched) {
      currentPath += '/' + parts[idx];
      idx++;
    }
  }

  return currentPath;
}

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

    // Handle multi-word volume names by trying to find the longest valid volume path
    if (idx < parts.length) {
      // Try up to 5 words for volume name (e.g., "My External Drive Name")
      let volumeFound = false;
      for (let wordCount = Math.min(5, parts.length - idx); wordCount >= 1; wordCount--) {
        const volumeNameParts = parts.slice(idx, idx + wordCount);
        const testVolumePath = currentPath + '/' + volumeNameParts.join(' ');

        if (fs.existsSync(testVolumePath)) {
          currentPath = testVolumePath;
          idx += wordCount;
          volumeFound = true;
          break;
        }
      }

      // Fallback: single word volume
      if (!volumeFound) {
        currentPath += '/' + parts[idx];
        idx++;
      }
    }

    // Phase 1: Find longest valid prefix by working backwards
    const { validPrefix, remainingIdx } = findLongestValidPrefix(parts, currentPath, idx);

    // Phase 2: Reconstruct remaining path with prioritized strategies
    const finalPath = reconstructPath(validPrefix, parts, remainingIdx);

    return finalPath;
  }

  // For non-Volumes paths, start from root
  let currentPath = '';
  let idx = 0;

  // Skip leading slash if present
  if (parts[0] === '' || parts[0] === '/') {
    idx++;
  }

  // Phase 1: Find longest valid prefix
  const { validPrefix, remainingIdx } = findLongestValidPrefix(parts, currentPath, idx);

  // Phase 2: Reconstruct remaining path
  return reconstructPath(validPrefix, parts, remainingIdx);
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
