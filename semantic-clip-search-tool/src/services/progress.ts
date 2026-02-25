import { EventEmitter } from 'node:events';
import type { JobProgress, ClipProgress, ClipStage, JobState } from '../types/index.js';

// Events emitted:
//   'clip'  (jobId: string, clip: ClipProgress)
//   'job'   (job: JobProgress)

export class ProgressTracker extends EventEmitter {
  private jobs = new Map<string, JobProgress>();

  startJob(jobId: string, projectId: string, projectName: string, clips: Array<{ clipId: string; name: string }>, sequenceName?: string): JobProgress {
    const job: JobProgress = {
      jobId,
      projectId,
      projectName,
      sequenceName,
      state: 'running',
      totalClips: clips.length,
      completedClips: 0,
      totalChunks: 0,
      embeddedChunks: 0,
      clips: clips.map((c) => ({
        clipId: c.clipId,
        name: c.name,
        stage: 'pending',
        totalChunks: 0,
        embeddedChunks: 0,
      })),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    this.emit('job', job);
    return job;
  }

  setClipStage(jobId: string, clipId: string, stage: ClipStage, extra?: Partial<ClipProgress>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const clip = job.clips.find((c) => c.clipId === clipId);
    if (!clip) return;

    clip.stage = stage;
    if (extra) Object.assign(clip, extra);

    if (stage === 'done' || stage === 'error') {
      job.completedClips = job.clips.filter((c) => c.stage === 'done' || c.stage === 'error').length;
    }

    this.emit('clip', jobId, clip);
    this.emit('job', job);
  }

  setChunkProgress(jobId: string, clipId: string, totalChunks: number, embeddedChunks: number): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const clip = job.clips.find((c) => c.clipId === clipId);
    if (!clip) return;

    const prevTotal = clip.totalChunks;
    const prevEmbedded = clip.embeddedChunks;

    clip.totalChunks = totalChunks;
    clip.embeddedChunks = embeddedChunks;

    job.totalChunks += totalChunks - prevTotal;
    job.embeddedChunks += embeddedChunks - prevEmbedded;

    this.emit('clip', jobId, clip);
    this.emit('job', job);
  }

  finishJob(jobId: string, state: JobState): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.state = state;
    job.completedAt = new Date().toISOString();
    job.durationMs = Date.now() - new Date(job.startedAt).getTime();
    this.emit('job', job);
  }

  getJob(jobId: string): JobProgress | undefined {
    return this.jobs.get(jobId);
  }

  // All jobs, most recent first
  getAllJobs(): JobProgress[] {
    return [...this.jobs.values()].reverse();
  }

  // Running jobs only
  getRunningJobs(): JobProgress[] {
    return [...this.jobs.values()].filter((j) => j.state === 'running');
  }

  /** Remove all in-memory jobs for a project (called on project delete). */
  deleteProject(projectId: string): number {
    let removed = 0;
    for (const [jobId, job] of this.jobs) {
      if (job.projectId === projectId) {
        this.jobs.delete(jobId);
        removed++;
      }
    }
    return removed;
  }

  /** Wipe all in-memory jobs (called on full reset). */
  resetAll(): number {
    const count = this.jobs.size;
    this.jobs.clear();
    return count;
  }
}
