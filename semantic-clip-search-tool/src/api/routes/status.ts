import { Router, Request, Response } from 'express';
import type { Config, JobProgress } from '../../types/index.js';
import { ChromaService } from '../../services/chroma.js';
import { ProgressTracker } from '../../services/progress.js';
import { TimelineStore } from '../../services/store.js';

export function createStatusRouter(
  config: Config,
  tracker: ProgressTracker,
  store: TimelineStore,
): Router {
  const router = Router();
  const chroma = new ChromaService(config);

  // GET /status — infra health check
  router.get('/', async (_req: Request, res: Response) => {
    const [chromaOk, ollamaOk] = await Promise.all([
      chroma.ping(),
      pingOllama(config.ollamaUrl),
    ]);

    res.json({
      chromaOk,
      ollamaOk,
      chromaUrl: config.chromaUrl,
      ollamaUrl: config.ollamaUrl,
      embedModel: config.ollamaEmbedModel,
      llmModel: config.ollamaLlmModel,
    });
  });

  // GET /status/progress — all live jobs (running + recent, in-memory only)
  router.get('/progress', (_req: Request, res: Response) => {
    const jobs = tracker.getAllJobs();
    const running = jobs.filter((j) => j.state === 'running');

    res.json({
      activeJobs: running.length,
      jobs: jobs.map(summarise),
    });
  });

  // GET /status/progress/:jobId — single job; live tracker first, then SQLite
  router.get('/progress/:jobId', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const liveJob = tracker.getJob(jobId);

    if (liveJob) {
      const clipsTotal = liveJob.totalClips;
      const clipsCompleted = liveJob.completedClips;
      const chunksPct = liveJob.totalChunks > 0
        ? Math.round((liveJob.embeddedChunks / liveJob.totalChunks) * 100)
        : 0;

      res.json({
        ...liveJob,
        source: 'live',
        percentComplete: clipsTotal > 0
          ? Math.round((clipsCompleted / clipsTotal) * 100)
          : 0,
        chunksPercentComplete: chunksPct,
        elapsedMs: liveJob.durationMs ?? (Date.now() - new Date(liveJob.startedAt).getTime()),
      });
      return;
    }

    // Fall back to SQLite for historical jobs
    const row = store.getJob(jobId);
    if (!row) {
      res.status(404).json({ error: 'Job not found', jobId });
      return;
    }

    res.json({ ...row, source: 'db' });
  });

  // GET /status/jobs — historical jobs from SQLite (last 100)
  router.get('/jobs', (_req: Request, res: Response) => {
    const jobs = store.getAllJobs(100);
    res.json({ total: jobs.length, jobs });
  });

  // GET /status/jobs/:jobId — single historical job; tracker first, fallback SQLite
  router.get('/jobs/:jobId', (req: Request, res: Response) => {
    const { jobId } = req.params;
    const liveJob = tracker.getJob(jobId);
    if (liveJob) {
      res.json({ ...liveJob, source: 'live' });
      return;
    }

    const row = store.getJob(jobId);
    if (!row) {
      res.status(404).json({ error: 'Job not found', jobId });
      return;
    }

    res.json({ ...row, source: 'db' });
  });

  // GET /status/interrupted — jobs that were mid-flight when server last died
  router.get('/interrupted', (_req: Request, res: Response) => {
    const all = store.getAllJobs(200);
    const interrupted = all.filter((j) => j.state === 'interrupted');
    res.json({ total: interrupted.length, jobs: interrupted });
  });

  return router;
}

// Summary shape for the list endpoint (omits full clip array)
function summarise(job: JobProgress) {
  const { clips, ...rest } = job;
  const elapsedMs = job.durationMs ?? (Date.now() - new Date(job.startedAt).getTime());
  return {
    ...rest,
    elapsedMs,
    percentComplete: job.totalClips > 0
      ? Math.round((job.completedClips / job.totalClips) * 100)
      : 0,
  };
}

async function pingOllama(ollamaUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}
