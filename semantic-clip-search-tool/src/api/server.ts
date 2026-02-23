import express from 'express';
import { resolve } from 'node:path';
import type { Config } from '../types/index.js';
import { ProgressTracker } from '../services/progress.js';
import { TimelineStore } from '../services/store.js';
import { IndexQueue } from '../services/queue.js';
import { createSearchRouter } from './routes/search.js';
import { createIndexRouter } from './routes/index.js';
import { createStatusRouter } from './routes/status.js';
import { createAdminRouter } from './routes/admin.js';

export function createApp(
  config: Config,
  tracker: ProgressTracker,
  queue: IndexQueue,
  store: TimelineStore,
): express.Application {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.use('/search', createSearchRouter(config));
  app.use('/index', createIndexRouter(config, queue, tracker, store));
  app.use('/status', createStatusRouter(config, tracker, store));
  app.use('/admin', createAdminRouter(config, tracker, store));

  return app;
}

// Entry point when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Load .env if present
  try {
    const { readFileSync } = await import('node:fs');
    const envFile = readFileSync('.env', 'utf-8');
    for (const line of envFile.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) process.env[match[1]] = match[2].trim();
    }
  } catch {
    // .env is optional
  }

  const { loadConfig } = await import('../config/config.js');
  const { TimelineWatcher } = await import('../indexer/watcher.js');

  const config = loadConfig();
  const tracker = new ProgressTracker();

  // SQLite store at data/timelines.db (relative to CWD)
  const dbPath = resolve(process.cwd(), 'data', 'timelines.db');
  const store = new TimelineStore(dbPath);

  // Detect jobs that were running when the server last died
  const interrupted = store.markInterruptedJobs();
  if (interrupted > 0) {
    console.log(`[Server] Marked ${interrupted} interrupted job(s) from previous run`);
  }

  const queue = new IndexQueue(config, tracker, store);
  const app = createApp(config, tracker, queue, store);

  app.listen(config.port, () => {
    console.log(`[Server] Listening on http://localhost:${config.port}`);
    console.log(`[Server] ChromaDB: ${config.chromaUrl}`);
    console.log(`[Server] Ollama:   ${config.ollamaUrl}`);
    console.log(`[Server] SQLite:   ${dbPath}`);
    console.log(`[Server] Progress: GET /status/progress`);
    console.log(`[Server] Jobs:     GET /status/jobs`);
  });

  // Start file watcher — passes queue for delta-aware indexing
  const watcher = new TimelineWatcher(config, queue);
  watcher.start();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    store.close();
    process.exit(0);
  });
}
