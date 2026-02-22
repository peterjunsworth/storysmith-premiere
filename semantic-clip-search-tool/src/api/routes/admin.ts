import { Router, Request, Response } from 'express';
import type { Config } from '../../types/index.js';
import { ChromaService } from '../../services/chroma.js';
import { ProgressTracker } from '../../services/progress.js';
import { TimelineStore } from '../../services/store.js';

export function createAdminRouter(
  config: Config,
  tracker: ProgressTracker,
  store: TimelineStore,
): Router {
  const router = Router();
  const chroma = new ChromaService(config);

  /**
   * POST /admin/reset-all
   *
   * Atomically resets ALL state:
   *   1. Drop + recreate the ChromaDB collection (all vectors gone)
   *   2. Wipe all rows from SQLite `timelines` table (all snapshots gone)
   *   3. Wipe all rows from SQLite `jobs` table (all job history gone)
   *   4. Clear in-memory ProgressTracker (all live jobs gone)
   *
   * After this call, every project will be treated as a fresh import on the
   * next POST /index.  Use when you want a completely clean slate.
   */
  router.post('/reset-all', async (_req: Request, res: Response) => {
    try {
      await chroma.resetCollection();
      const dbResult  = store.resetAll();
      const liveCleared = tracker.resetAll();

      res.json({
        ok: true,
        chromaReset: true,
        snapshotsDeleted: dbResult.snapshotsDeleted,
        jobsDeleted: dbResult.jobsDeleted,
        liveJobsCleared: liveCleared,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Admin] reset-all failed: ${message}`);
      res.status(500).json({ ok: false, error: message });
    }
  });

  return router;
}
