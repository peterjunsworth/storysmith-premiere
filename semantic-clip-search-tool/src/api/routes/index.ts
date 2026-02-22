import { Router, Request, Response } from 'express';
import type { Config } from '../../types/index.js';
import { parseRawExport } from '../../services/pipeline.js';
import { ChromaService } from '../../services/chroma.js';
import { IndexQueue } from '../../services/queue.js';
import { ProgressTracker } from '../../services/progress.js';
import { TimelineStore } from '../../services/store.js';

export function createIndexRouter(
  config: Config,
  queue: IndexQueue,
  tracker: ProgressTracker,
  store: TimelineStore,
): Router {
  const router = Router();
  const chroma = new ChromaService(config);

  // POST /index — accept raw Premiere JSON and queue delta-indexed processing
  router.post('/', async (req: Request, res: Response) => {
    if (!req.body?.sequences) {
      res.status(400).json({ error: 'Invalid body: expected Premiere export JSON with "sequences" field' });
      return;
    }

    let timeline;
    try {
      timeline = parseRawExport(req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: 'Failed to parse timeline JSON', message });
      return;
    }

    try {
      const result = await queue.queueTimeline(timeline);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Index API] queueTimeline failed: ${message}`);
      res.status(500).json({ error: 'Failed to queue timeline', message });
    }
  });

  // DELETE /index/:projectId — remove all state for a project:
  //   • ChromaDB embeddings
  //   • SQLite snapshot (timelines table) + all job rows (jobs table)
  //   • In-memory ProgressTracker jobs
  router.delete('/:projectId', async (req: Request, res: Response) => {
    const { projectId } = req.params;
    try {
      await chroma.deleteByProjectId(projectId);
      const dbResult = store.deleteProject(projectId);
      const trackerRemoved = tracker.deleteProject(projectId);
      res.json({
        deleted: true,
        projectId,
        snapshotDeleted: dbResult.snapshotDeleted,
        jobsDeleted: dbResult.jobsDeleted,
        liveJobsRemoved: trackerRemoved,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: 'Delete failed', message });
    }
  });

  return router;
}
