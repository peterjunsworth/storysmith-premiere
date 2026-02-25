import { Router, Request, Response } from 'express';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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
        res.json({
          success: false,
          clips: [],
          message: 'No clip records found in Media Cache',
          searchedDatabases: mediaCacheDbs.length
        });
        return;
      }

      // Process clip records and resolve file paths
      const clipsWithPaths: any[] = [];

      for (const clipRecord of allClipRecords) {
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

              const dbName = (clipRecord.columnintrinsicfilename || '').toLowerCase().trim();
              const searchName = (name || '').toLowerCase().trim();

              if (dbName === searchName) return true;

              const searchNameWithSpaces = searchName.replace(/\./g, ' ');
              if (dbName === searchNameWithSpaces) return true;

              const nameWithoutExt = searchName.replace(/\.[^.]+$/, '').trim();
              if (dbName === nameWithoutExt || dbName.startsWith(nameWithoutExt + ' ')) {
                return true;
              }

              return false;
            });
          }

          if (!matches) continue;
        }

        const clipData = {
          clipName: clipRecord.columnintrinsicfilename,
          filePath: fixFilePath(clipRecord.columnintrinsicfilepath),
          status: clipRecord.columnintrinsictranscriptstatus,
          audioInfo: clipRecord.columnintrinsicaudioinfo,
          transcriptText: null,
          source: 'media_cache'
        };

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
    const { createReadStream } = require('node:fs');
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

    while (idx < parts.length) {
      let found = false;

      let testPath = currentPath + '/' + parts[idx];
      if (existsSync(testPath)) {
        currentPath = testPath;
        idx++;
        found = true;
      } else {
        if (idx + 1 < parts.length) {
          testPath = currentPath + '/' + parts[idx] + '-' + parts[idx + 1];
          if (existsSync(testPath)) {
            currentPath = testPath;
            idx += 2;
            found = true;
          }
        }

        if (!found && idx + 1 < parts.length) {
          testPath = currentPath + '/' + parts[idx] + '.' + parts[idx + 1];
          if (existsSync(testPath)) {
            currentPath = testPath;
            idx += 2;
            found = true;
          }
        }

        if (!found) {
          currentPath += '/' + parts[idx];
          idx++;
        }
      }
    }

    return currentPath;
  }

  // For non-Volumes paths
  let currentPath = '';
  let idx = 0;

  if (parts[0] === '' || parts[0] === '/') {
    idx++;
  }

  while (idx < parts.length) {
    let found = false;

    let testPath = currentPath + '/' + parts[idx];
    if (existsSync(testPath)) {
      currentPath = testPath;
      idx++;
      found = true;
    } else {
      if (idx + 1 < parts.length) {
        testPath = currentPath + '/' + parts[idx] + '-' + parts[idx + 1];
        if (existsSync(testPath)) {
          currentPath = testPath;
          idx += 2;
          found = true;
        }
      }

      if (!found && idx + 1 < parts.length) {
        testPath = currentPath + '/' + parts[idx] + '.' + parts[idx + 1];
        if (existsSync(testPath)) {
          currentPath = testPath;
          idx += 2;
          found = true;
        }
      }

      if (!found) {
        currentPath += '/' + parts[idx];
        idx++;
      }
    }
  }

  return currentPath;
}
