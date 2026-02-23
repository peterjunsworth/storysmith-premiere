import Database from 'better-sqlite3';
import type { PremiereTimeline, PremiereClip, Changeset, JobState } from '../types/index.js';

export interface JobRow {
  jobId: string;
  projectId: string;
  projectName: string;
  state: JobState;
  totalClips: number;
  completedClips: number;
  totalChunks: number;
  embeddedChunks: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export class TimelineStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timelines (
        projectId    TEXT PRIMARY KEY,
        projectName  TEXT NOT NULL,
        snapshotJson TEXT NOT NULL,
        updatedAt    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        jobId          TEXT PRIMARY KEY,
        projectId      TEXT NOT NULL,
        projectName    TEXT NOT NULL,
        state          TEXT NOT NULL,
        totalClips     INTEGER NOT NULL DEFAULT 0,
        completedClips INTEGER NOT NULL DEFAULT 0,
        totalChunks    INTEGER NOT NULL DEFAULT 0,
        embeddedChunks INTEGER NOT NULL DEFAULT 0,
        startedAt      TEXT NOT NULL,
        completedAt    TEXT,
        durationMs     INTEGER
      );
    `);
  }

  computeChangeset(incoming: PremiereTimeline): Changeset {
    const row = this.db
      .prepare('SELECT snapshotJson FROM timelines WHERE projectId = ?')
      .get(incoming.projectId) as { snapshotJson: string } | undefined;

    if (!row) {
      return {
        newClips: incoming.clips,
        updatedClips: [],
        removedClips: [],
        isNewProject: true,
      };
    }

    const previous: PremiereTimeline = JSON.parse(row.snapshotJson);
    const prevMap = new Map<string, PremiereClip>(
      previous.clips.map((c) => [c.clipId, c]),
    );
    const incomingMap = new Map<string, PremiereClip>(
      incoming.clips.map((c) => [c.clipId, c]),
    );

    const newClips: PremiereClip[] = [];
    const updatedClips: PremiereClip[] = [];
    const removedClips: PremiereClip[] = [];

    for (const clip of incoming.clips) {
      const prev = prevMap.get(clip.clipId);
      if (!prev) {
        newClips.push(clip);
      } else {
        // Fingerprint: filePath + duration
        const prevFp = `${prev.filePath}:${prev.duration}`;
        const newFp = `${clip.filePath}:${clip.duration}`;
        if (prevFp !== newFp) {
          updatedClips.push(clip);
        }
      }
    }

    for (const clip of previous.clips) {
      if (!incomingMap.has(clip.clipId)) {
        removedClips.push(clip);
      }
    }

    return { newClips, updatedClips, removedClips, isNewProject: false };
  }

  saveSnapshot(timeline: PremiereTimeline): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO timelines (projectId, projectName, snapshotJson, updatedAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        timeline.projectId,
        timeline.projectName,
        JSON.stringify(timeline),
        new Date().toISOString(),
      );
  }

  createJob(
    jobId: string,
    projectId: string,
    projectName: string,
    totalClips: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO jobs
           (jobId, projectId, projectName, state, totalClips, completedClips,
            totalChunks, embeddedChunks, startedAt)
         VALUES (?, ?, ?, 'running', ?, 0, 0, 0, ?)`,
      )
      .run(jobId, projectId, projectName, totalClips, new Date().toISOString());
  }

  updateJobProgress(
    jobId: string,
    completedClips: number,
    totalChunks: number,
    embeddedChunks: number,
  ): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET completedClips = ?, totalChunks = ?, embeddedChunks = ?
         WHERE jobId = ?`,
      )
      .run(completedClips, totalChunks, embeddedChunks, jobId);
  }

  finishJob(jobId: string, state: JobState, completedAt: string, durationMs: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET state = ?, completedAt = ?, durationMs = ? WHERE jobId = ?`,
      )
      .run(state, completedAt, durationMs, jobId);
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db
      .prepare('SELECT * FROM jobs WHERE jobId = ?')
      .get(jobId) as JobRow | undefined;
  }

  getAllJobs(limit = 50): JobRow[] {
    return this.db
      .prepare('SELECT * FROM jobs ORDER BY startedAt DESC LIMIT ?')
      .all(limit) as JobRow[];
  }

  /** Mark all jobs that were still 'running' at last shutdown as 'interrupted'. */
  markInterruptedJobs(): number {
    const result = this.db
      .prepare(`UPDATE jobs SET state = 'interrupted' WHERE state = 'running'`)
      .run();
    return result.changes;
  }

  /**
   * Wipe ALL project snapshots and job history.
   * Called when the ChromaDB collection is recreated from scratch.
   */
  resetAll(): { snapshotsDeleted: number; jobsDeleted: number } {
    const snaps = this.db.prepare('DELETE FROM timelines').run();
    const jobs  = this.db.prepare('DELETE FROM jobs').run();
    return { snapshotsDeleted: snaps.changes, jobsDeleted: jobs.changes };
  }

  /**
   * Delete all state for a project: removes the snapshot row from `timelines`
   * and ALL job rows for that projectId from `jobs`.
   * Returns the number of job rows deleted.
   */
  deleteProject(projectId: string): { snapshotDeleted: boolean; jobsDeleted: number } {
    const snap = this.db
      .prepare('DELETE FROM timelines WHERE projectId = ?')
      .run(projectId);
    const jobs = this.db
      .prepare('DELETE FROM jobs WHERE projectId = ?')
      .run(projectId);
    return { snapshotDeleted: snap.changes > 0, jobsDeleted: jobs.changes };
  }

  close(): void {
    this.db.close();
  }
}
