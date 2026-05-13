import { Router, Request, Response } from 'express';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { homedir, platform } from 'node:os';
import type { Config } from '../../types/index.js';

export function createClipPathsRouter(_config: Config): Router {
  const router = Router();

  // POST /clip-paths — resolve file paths for clips from Adobe Media Cache
  // This endpoint queries Premiere Pro's Media Cache database to find the actual
  // file system paths for clips used in sequences
  router.post('/', async (req: Request, res: Response) => {
    console.log('\n' + '='.repeat(80));
    console.log('📨 POST /clip-paths called');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('='.repeat(80));

    try {
      let { projectGuid, projectPath, filePaths, clipNames } = req.body;

      // If projectPath provided, extract GUID first
      if (projectPath && !projectGuid && projectPath.includes('/')) {
        try {
          const xmlContent = await decompressGzip(projectPath);
          const guidMatch = xmlContent.match(/MZ\.Project\.GUID['"]\s*value=['"]([^'"]+)['"]/);
          projectGuid = guidMatch ? guidMatch[1] : null;
        } catch (err) {
          console.warn('Could not extract GUID from project path:', (err as Error).message);
        }
      }

      // Get list of Media Cache databases to search
      let mediaCacheDbs: string[] = [];

      if (projectGuid) {
        const mediaCacheDb = getMediaCachePath(projectGuid);
        if (existsSync(mediaCacheDb)) {
          mediaCacheDbs.push(mediaCacheDb);
        }
      } else {
        console.log('No project GUID available - searching all Media Cache databases');
        const basePath = getMediaCacheBasePath();
        if (existsSync(basePath)) {
          const files = readdirSync(basePath);
          mediaCacheDbs = files
            .filter(f => f.endsWith('.prmdc2'))
            .map(f => join(basePath, f));
          console.log(`Found ${mediaCacheDbs.length} Media Cache database(s) to search`);
        }
      }

      if (mediaCacheDbs.length === 0) {
        res.status(404).json({
          success: false,
          error: 'No Media Cache databases found',
          suggestion: 'Project may not have been opened in Premiere Pro yet'
        });
        return;
      }

      // Query all databases for clip file paths
      let allClipRecords: any[] = [];

      for (const mediaCacheDb of mediaCacheDbs) {
        try {
          // Use better-sqlite3 (sync API)
          const Database = (await import('better-sqlite3')).default;
          const db = new Database(mediaCacheDb, { readonly: true });

          // Query for files with completed speech-to-text transcription
          // (columnintrinsictranscriptstatus is Adobe's field for transcript status)
          const clipsWithTranscripts = db.prepare(`
            SELECT
              columnintrinsicfilename,
              columnintrinsictranscriptstatus,
              columnintrinsicfilepath,
              columnintrinsicaudioinfo
            FROM StringTable
            WHERE columnintrinsictranscriptstatus LIKE '%omplete%'
          `).all();

          // Also query for files without transcript status (like video files)
          if (clipNames && clipNames.length > 0) {
            const allFiles = db.prepare(`
              SELECT DISTINCT
                columnintrinsicfilename,
                columnintrinsictranscriptstatus,
                columnintrinsicfilepath,
                columnintrinsicaudioinfo
              FROM StringTable
              WHERE columnintrinsicfilepath IS NOT NULL
                AND columnintrinsicfilename IS NOT NULL
            `).all();

            const existingPaths = new Set(clipsWithTranscripts.map((t: any) => t.columnintrinsicfilepath));
            for (const file of allFiles) {
              if (!existingPaths.has((file as any).columnintrinsicfilepath)) {
                clipsWithTranscripts.push(file);
              }
            }
          }

          db.close();
          allClipRecords = allClipRecords.concat(clipsWithTranscripts);
        } catch (err) {
          console.error(`Error querying ${mediaCacheDb}:`, (err as Error).message);
        }
      }

      if (allClipRecords.length === 0) {
        console.log('❌ No clip records found in any Media Cache database');
        res.json({
          success: false,
          clips: [],
          message: 'No clip records found in Media Cache',
          searchedDatabases: mediaCacheDbs.length
        });
        return;
      }

      console.log(`Found ${allClipRecords.length} total clip records in databases`);
      console.log(`Filtering by clipNames:`, clipNames);

      // Process clip records and resolve file paths
      const clipsWithPaths: any[] = [];

      for (const clipRecord of allClipRecords) {
        const dbClipName = (clipRecord.columnintrinsicfilename || '').toLowerCase().trim();

        // Filter by file paths or clip names if provided
        if ((filePaths && filePaths.length > 0) || (clipNames && clipNames.length > 0)) {
          let matches = false;

          if (filePaths && filePaths.length > 0) {
            matches = filePaths.some((fp: string) =>
              clipRecord.columnintrinsicfilepath &&
              (clipRecord.columnintrinsicfilepath === fp ||
               clipRecord.columnintrinsicfilepath.endsWith(fp) ||
               fp.endsWith(clipRecord.columnintrinsicfilename))
            );
          }

          if (!matches && clipNames && clipNames.length > 0) {
            matches = clipNames.some((name: string) => {
              if (!clipRecord.columnintrinsicfilename) return false;

              // Normalize both names for comparison
              const normalizeForMatch = (str: string) => {
                const normalized = str
                  .toLowerCase()
                  .trim()
                  .replace(/%20/g, ' ')           // Decode URL-encoded spaces
                  .replace(/%/g, ' ')             // Decode any remaining % as space
                  .replace(/^[-–—]\s+/, '')       // Remove leading dash/hyphen
                  .replace(/\s+/g, ' ')           // Normalize multiple spaces
                  .replace(/\.[^.]+$/, '');       // Remove file extension with dot (e.g., ".mp4")

                // Also remove last word if it's a common extension without dot (e.g., "mp4" "wav")
                const parts = normalized.split(' ');
                const lastWord = parts[parts.length - 1];
                const commonExtensions = ['mp4', 'mov', 'wav', 'mp3', 'aac', 'm4a', 'avi', 'mkv', 'mxf',
                                          'aiff', 'flac', 'jpg', 'jpeg', 'png', 'gif', 'pdf', 'txt'];
                if (commonExtensions.includes(lastWord)) {
                  parts.pop();
                  return parts.join(' ');
                }

                return normalized;
              };

              const dbName = normalizeForMatch(clipRecord.columnintrinsicfilename);
              const searchName = normalizeForMatch(name);

              // Debug: Log first comparison for "the secret" clip
              if (dbName.includes('secret')) {
                console.log(`  [DEBUG] Comparing:`);
                console.log(`    DB raw: "${clipRecord.columnintrinsicfilename}"`);
                console.log(`    DB normalized: "${dbName}"`);
                console.log(`    Search raw: "${name}"`);
                console.log(`    Search normalized: "${searchName}"`);
                console.log(`    Match: ${dbName === searchName}`);
              }

              // Direct match after normalization
              if (dbName === searchName) {
                console.log(`  ✓ Match: "${clipRecord.columnintrinsicfilename}" === "${name}"`);
                return true;
              }

              return false;
            });
          }

          if (!matches) {
            console.log(`  ✗ No match for: "${dbClipName}"`);
            continue;
          }
        }

        const reconstructedPath = fixFilePath(clipRecord.columnintrinsicfilepath);

        // The filename from the database may have lost special characters
        // Try to find the actual file on disk by searching the directory
        let actualFilePath = reconstructedPath;

        try {
          const dirPath = reconstructedPath.substring(0, reconstructedPath.lastIndexOf('/'));
          const dbFilename = reconstructedPath.substring(reconstructedPath.lastIndexOf('/') + 1);

          if (existsSync(dirPath)) {
            const filesInDir = readdirSync(dirPath);

            // Normalize for comparison (remove special chars, lowercase, no extension)
            const normalizeFilename = (name: string) => {
              return name.toLowerCase()
                .replace(/[-–—_%]/g, ' ')  // Replace dashes, underscores, % with space
                .replace(/\s+/g, ' ')       // Normalize spaces
                .replace(/\.[^.]+$/, '')    // Remove extension
                .trim();
            };

            const normalizedDbName = normalizeFilename(dbFilename);

            // Find a file that matches after normalization
            const matchingFile = filesInDir.find(f => {
              const normalized = normalizeFilename(f);
              return normalized === normalizedDbName;
            });

            if (matchingFile) {
              actualFilePath = dirPath + '/' + matchingFile;
              console.log(`   ACTUAL FILE: "${matchingFile}" (found in directory)`);
            }
          }
        } catch (err) {
          // Failed to search directory - use reconstructed path as-is
        }

        const clipData = {
          clipName: clipRecord.columnintrinsicfilename,
          filePath: actualFilePath,
          status: clipRecord.columnintrinsictranscriptstatus,
          audioInfo: clipRecord.columnintrinsicaudioinfo,
          transcriptText: null,
          source: 'media_cache'
        };

        console.log(`\n📂 ${clipData.clipName}`);
        console.log(`   DB: "${clipRecord.columnintrinsicfilepath}"`);
        console.log(`   FIXED: "${clipData.filePath}"`);

        clipsWithPaths.push(clipData);
      }

      res.json({
        success: true,
        projectGuid,
        searchedDatabases: mediaCacheDbs.length,
        transcripts: clipsWithPaths, // Keep 'transcripts' key for backward compatibility
        clips: clipsWithPaths,
        totalFound: clipsWithPaths.length
      });

      console.log(`\n✅ Returning ${clipsWithPaths.length} clips to client`);
      console.log('='.repeat(80) + '\n');

    } catch (error) {
      console.error('Error extracting transcripts:', error);
      res.status(500).json({
        success: false,
        error: (error as Error).message
      });
    }
  });

  return router;
}

// Helper functions

function decompressGzip(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(filePath);
    const gunzip = createGunzip();
    let data = '';

    readStream.pipe(gunzip)
      .on('data', (chunk: Buffer) => {
        data += chunk.toString('utf-8');
      })
      .on('end', () => {
        resolve(data);
      })
      .on('error', (error: Error) => {
        reject(error);
      });
  });
}

function getMediaCacheBasePath(): string {
  const plat = platform();
  const home = homedir();

  if (plat === 'darwin') {
    return join(home, 'Library/Application Support/Adobe/Common/Media Cache Files');
  } else if (plat === 'win32') {
    return join(process.env.LOCALAPPDATA || '', 'Adobe/Common/Media Cache Files');
  } else {
    return join(home, '.config/Adobe/Common/Media Cache Files');
  }
}

function getMediaCachePath(projectGuid: string): string {
  const basePath = getMediaCacheBasePath();

  if (existsSync(basePath)) {
    const files = readdirSync(basePath);
    const dbFile = files.find(f => f.includes(projectGuid) && f.endsWith('.prmdc2'));
    if (dbFile) {
      return join(basePath, dbFile);
    }
  }

  return join(basePath, `StorySmith${projectGuid}.prmdc2`);
}

/**
 * Helper function to find the longest existing path prefix by working backwards
 */
function findLongestValidPrefix(
  parts: string[],
  basePrefix: string,
  startIdx: number
): { validPrefix: string; remainingIdx: number } {
  // Try progressively shorter paths from full length down to startIdx
  for (let endIdx = parts.length; endIdx >= startIdx; endIdx--) {
    const pathParts = parts.slice(startIdx, endIdx);
    if (pathParts.length === 0) continue;

    const testPath = basePrefix + '/' + pathParts.join('/');
    if (existsSync(testPath)) {
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
 * Returns array sorted by priority (longest matches first)
 */
function generateCandidates(
  basePath: string,
  parts: string[],
  idx: number
): Array<{ length: number; path: string; priority: number }> {
  const candidates = [];
  const remainingWords = parts.length - idx;

  // HIGHEST PRIORITY: File extension detection for last 2 words
  if (remainingWords === 2) {
    const possibleExtension = parts[idx + 1].toLowerCase();
    const commonExtensions = ['mov', 'mp4', 'wav', 'mp3', 'aac', 'm4a', 'avi', 'mkv', 'mxf',
                              'aiff', 'flac', 'jpg', 'png', 'pdf', 'txt', 'prproj', 'aep'];

    console.log(`[EXT CHECK] remainingWords=${remainingWords}, idx=${idx}, parts.length=${parts.length}, ext="${possibleExtension}"`);

    if (commonExtensions.includes(possibleExtension) || possibleExtension.length <= 4) {
      // This is a file extension - use dot separator with HIGHEST priority
      const extPath = basePath + '/' + parts[idx] + '.' + parts[idx+1];
      console.log(`[EXT MATCH] Adding candidate with priority 100: "${extPath}"`);
      candidates.push({
        length: 2,
        path: extPath,
        priority: 100
      });
    }
  }

  // Strategy 1: Single word (as-is)
  if (idx < parts.length) {
    candidates.push({
      length: 1,
      path: basePath + '/' + parts[idx],
      priority: 1
    });
  }

  // Strategy 2: Four words with spaces (e.g., "My Project v2 Final")
  if (idx + 3 < parts.length) {
    candidates.push({
      length: 4,
      path: basePath + '/' + [parts[idx], parts[idx+1], parts[idx+2], parts[idx+3]].join(' '),
      priority: 5
    });
  }

  // Strategy 3: Three words with spaces (e.g., "My Project v2")
  if (idx + 2 < parts.length) {
    candidates.push({
      length: 3,
      path: basePath + '/' + [parts[idx], parts[idx+1], parts[idx+2]].join(' '),
      priority: 4
    });
  }

  // Strategy 4: Two words with space (e.g., "Card 1")
  if (idx + 1 < parts.length) {
    candidates.push({
      length: 2,
      path: basePath + '/' + parts[idx] + ' ' + parts[idx+1],
      priority: 3
    });
  }

  // Strategy 5: Two words with hyphen (e.g., "storysmith-premiere")
  if (idx + 1 < parts.length) {
    candidates.push({
      length: 2,
      path: basePath + '/' + parts[idx] + '-' + parts[idx+1],
      priority: 2
    });
  }

  // Strategy 6: Two words with dot (for non-extension cases)
  if (idx + 1 < parts.length && remainingWords > 2) {
    candidates.push({
      length: 2,
      path: basePath + '/' + parts[idx] + '.' + parts[idx+1],
      priority: 2
    });
  }

  // Sort by priority (higher first), then by length (longer first)
  return candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.length - a.length;
  });
}

/**
 * Reconstruct path from remaining parts using prioritized multi-word strategies
 */
function reconstructPath(
  basePrefix: string,
  parts: string[],
  startIdx: number
): string {
  let currentPath = basePrefix;
  let idx = startIdx;

  while (idx < parts.length) {
    const candidates = generateCandidates(currentPath, parts, idx);
    let matched = false;

    // Check if we're at the last 2 words (likely filename + extension)
    const remainingWords = parts.length - idx;
    const isLikelyFilename = remainingWords === 2;

    // Try each candidate in priority order
    for (const candidate of candidates) {
      // For likely filenames (last 2 words), accept high-priority extension candidates without existsSync
      // because the file might not exist yet or might be offline
      const shouldAcceptWithoutCheck = isLikelyFilename && candidate.priority >= 100;

      if (shouldAcceptWithoutCheck || existsSync(candidate.path)) {
        currentPath = candidate.path;
        idx += candidate.length;
        matched = true;
        console.log(`[PATH MATCH] Used candidate: "${candidate.path}" (priority=${candidate.priority}, exists=${existsSync(candidate.path)})`);
        break;
      }
    }

    // If nothing matched, we might have reached the filename
    // Check if none of the candidates exist - this likely means we're at the filename portion
    if (!matched) {
      const allCandidatesFailed = candidates.every(c => !existsSync(c.path));

      // If all candidates failed and we have multiple words remaining, treat rest as filename
      if (allCandidatesFailed && remainingWords >= 3) {
        // Remaining words are the filename - combine them with spaces and add extension
        const commonExtensions = ['mp4', 'mov', 'wav', 'mp3', 'aac', 'm4a', 'avi', 'mkv', 'mxf',
                                  'aiff', 'flac', 'jpg', 'jpeg', 'png', 'gif', 'pdf', 'txt'];
        const lastWord = parts[parts.length - 1];
        const isExtension = commonExtensions.includes(lastWord.toLowerCase());

        if (isExtension) {
          // Last word is extension - combine all middle words as filename
          const filenameParts = parts.slice(idx, parts.length - 1);
          const filename = filenameParts.join(' ');
          currentPath += '/' + filename + '.' + lastWord;
          console.log(`[FILENAME] Treating remaining ${filenameParts.length} words as filename: "${filename}.${lastWord}"`);
          break; // Done - we've built the complete path
        }
      }

      // Otherwise, append single word and continue
      currentPath += '/' + parts[idx];
      idx++;
    }
  }

  return currentPath;
}

function fixFilePath(dbPath: string): string {
  if (!dbPath) return '';

  const parts = dbPath.trim().split(/\s+/).filter(p => p.length > 0);
  if (parts.length === 0) return '';

  // Handle macOS /Volumes paths
  if (parts[0] === 'Volumes' || parts[0] === '/Volumes') {
    let idx = 0;
    let currentPath = '/Volumes';

    if (parts[idx] === 'Volumes' || parts[idx] === '/Volumes') {
      idx++;
    }

    if (idx < parts.length) {
      const volumeName = parts[idx];
      idx++;

      if (volumeName === 'Macintosh' && idx < parts.length && parts[idx] === 'HD') {
        currentPath += '/Macintosh HD';
        idx++;
      } else {
        currentPath += '/' + volumeName;
      }
    }

    // Phase 1: Find longest valid prefix by working backwards
    const { validPrefix, remainingIdx } = findLongestValidPrefix(parts, currentPath, idx);

    // Phase 2: Reconstruct remaining path with prioritized strategies
    return reconstructPath(validPrefix, parts, remainingIdx);
  }

  // For non-Volumes paths
  let currentPath = '';
  let idx = 0;

  if (parts[0] === '' || parts[0] === '/') {
    idx++;
  }

  // Phase 1: Find longest valid prefix
  const { validPrefix, remainingIdx } = findLongestValidPrefix(parts, currentPath, idx);

  // Phase 2: Reconstruct remaining path
  return reconstructPath(validPrefix, parts, remainingIdx);
}
