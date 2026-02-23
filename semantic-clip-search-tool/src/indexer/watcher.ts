import chokidar from 'chokidar';
import { promises as fs } from 'node:fs';
import type { Config } from '../types/index.js';
import { parseRawExport } from '../services/pipeline.js';
import { IndexQueue } from '../services/queue.js';

export class TimelineWatcher {
  private config: Config;
  private queue: IndexQueue;

  constructor(config: Config, queue: IndexQueue) {
    this.config = config;
    this.queue = queue;
  }

  start(): void {
    const watcher = chokidar.watch(this.config.timelineWatchGlob, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 1500,
        pollInterval: 200,
      },
    });

    watcher.on('add', (filePath) => {
      console.log(`[Watcher] File added: ${filePath}`);
      void this.handleFile(filePath);
    });

    watcher.on('change', (filePath) => {
      console.log(`[Watcher] File changed: ${filePath}`);
      void this.handleFile(filePath);
    });

    watcher.on('error', (err) => {
      console.error('[Watcher] Error:', err);
    });

    console.log(`[Watcher] Watching: ${this.config.timelineWatchGlob}`);
  }

  private async handleFile(filePath: string): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      const timeline = parseRawExport(raw);
      const result = await this.queue.queueTimeline(timeline);

      const { changeset, isNewProject, jobId } = result;
      console.log(
        `[Watcher] Queued "${timeline.projectName}" job=${jobId} ` +
        `${isNewProject ? '(new project)' : '(delta)'} — ` +
        `new=${changeset.newClips} updated=${changeset.updatedClips} removed=${changeset.removedClips}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Watcher] Failed to process ${filePath}: ${message}`);
    }
  }
}
