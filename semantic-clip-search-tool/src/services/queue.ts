import { randomUUID } from 'node:crypto';
import type {
  Config,
  PremiereTimeline,
  PremiereClip,
  PipelineItem,
  TextChunk,
  IndexedChunk,
  Changeset,
} from '../types/index.js';
import { WhisperService } from './whisper.js';
import { ChunkService } from './chunker.js';
import { OllamaEmbedService } from './embedder.js';
import { ChromaService } from './chroma.js';
import { ProgressTracker } from './progress.js';
import { TimelineStore } from './store.js';
import { transcribeClip } from './pipeline.js';

// ── PipelineStage ─────────────────────────────────────────────────────────────

class PipelineStage<In, Out> {
  private queue: In[] = [];
  private activeCount = 0;
  private readonly concurrency: number;
  private readonly processor: (item: In) => Promise<Out>;
  private readonly onOutput?: (out: Out) => void;
  private readonly onError?: (err: unknown, item: In) => void;
  private drainResolvers: Array<() => void> = [];

  constructor(opts: {
    concurrency: number;
    processor: (item: In) => Promise<Out>;
    onOutput?: (out: Out) => void;
    onError?: (err: unknown, item: In) => void;
  }) {
    this.concurrency = opts.concurrency;
    this.processor = opts.processor;
    this.onOutput = opts.onOutput;
    this.onError = opts.onError;
  }

  push(item: In): void {
    this.queue.push(item);
    this.tick();
  }

  get backlog(): number {
    return this.queue.length + this.activeCount;
  }

  drain(): Promise<void> {
    if (this.backlog === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  private tick(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.activeCount++;

      this.processor(item)
        .then((out) => {
          this.onOutput?.(out);
        })
        .catch((err) => {
          this.onError?.(err, item);
        })
        .finally(() => {
          this.activeCount--;
          this.tick();
          if (this.backlog === 0) {
            const resolvers = this.drainResolvers.splice(0);
            for (const r of resolvers) r();
          }
        });
    }
  }
}

// ── Back-pressure helper ──────────────────────────────────────────────────────

async function waitForCapacity(stage: PipelineStage<unknown, unknown>, limit: number): Promise<void> {
  while (stage.backlog >= limit) {
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

// ── Module-level stage processors ────────────────────────────────────────────

async function embedItem(
  item: PipelineItem,
  embedder: OllamaEmbedService,
): Promise<PipelineItem> {
  const textChunks = item.textChunks ?? [];
  if (textChunks.length === 0) return { ...item, embeddings: [] };

  const embeddings = await embedder.embedBatch(textChunks.map((c) => c.text));
  return { ...item, embeddings };
}

async function storeItem(
  item: PipelineItem,
  chroma: ChromaService,
): Promise<PipelineItem> {
  const textChunks = item.textChunks ?? [];
  const embeddings = item.embeddings ?? [];

  if (textChunks.length === 0) return item;

  // Delete-then-reindex: remove old vectors for this clip
  await chroma.deleteByClipId(item.clip.clipId);

  const indexedChunks: IndexedChunk[] = textChunks.map((chunk: TextChunk, i: number) => ({
    id: `${chunk.metadata.clipId}_chunk_${chunk.chunkIndex}`,
    embedding: embeddings[i],
    document: chunk.text,
    metadata: chunk.metadata,
  }));

  await chroma.upsertChunks(indexedChunks);
  return item;
}

// ── QueueAcceptResult ─────────────────────────────────────────────────────────

export interface QueueAcceptResult {
  accepted: boolean;
  jobId: string;
  projectId: string;
  projectName: string;
  isNewProject: boolean;
  changeset: {
    newClips: number;
    updatedClips: number;
    removedClips: number;
  };
}

// ── IndexQueue ────────────────────────────────────────────────────────────────

export class IndexQueue {
  private whisper: WhisperService;
  private chunker: ChunkService;
  private embedder: OllamaEmbedService;
  private chroma: ChromaService;
  private tracker: ProgressTracker;
  private store: TimelineStore;

  private transcribeStage: PipelineStage<PipelineItem, PipelineItem>;
  private embedStage: PipelineStage<PipelineItem, PipelineItem>;
  private storeStage: PipelineStage<PipelineItem, PipelineItem>;

  constructor(config: Config, tracker: ProgressTracker, store: TimelineStore) {
    this.whisper = new WhisperService(config);
    this.chunker = new ChunkService();
    this.embedder = new OllamaEmbedService(config);
    this.chroma = new ChromaService(config);
    this.tracker = tracker;
    this.store = store;

    // Wire stages: transcribe → embed → store
    this.storeStage = new PipelineStage({
      concurrency: 3,
      processor: (item) => storeItem(item, this.chroma),
      onOutput: (item) => this.onClipStored(item),
      onError: (err, item) => {
        console.error(`[Queue] Store failed for clip ${item.clip.clipId}:`, err);
        this.tracker.setClipStage(item.jobId, item.clip.clipId, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

    this.embedStage = new PipelineStage({
      concurrency: 1,
      processor: (item) => embedItem(item, this.embedder),
      onOutput: (item) => {
        this.tracker.setClipStage(item.jobId, item.clip.clipId, 'storing');
        this.storeStage.push(item);
      },
      onError: (err, item) => {
        console.error(`[Queue] Embed failed for clip ${item.clip.clipId}:`, err);
        this.tracker.setClipStage(item.jobId, item.clip.clipId, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

    this.transcribeStage = new PipelineStage({
      concurrency: config.whisperConcurrency,
      processor: (item) => transcribeClip(item, this.whisper, this.chunker),
      onOutput: (item) => {
        const chunkCount = item.textChunks?.length ?? 0;
        this.tracker.setClipStage(item.jobId, item.clip.clipId, 'embedding');
        this.tracker.setChunkProgress(item.jobId, item.clip.clipId, chunkCount, 0);
        this.embedStage.push(item);
      },
      onError: (err, item) => {
        console.error(`[Queue] Transcribe failed for clip ${item.clip.clipId}:`, err);
        this.tracker.setClipStage(item.jobId, item.clip.clipId, 'error', {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });
  }

  async queueTimeline(timeline: PremiereTimeline): Promise<QueueAcceptResult> {
    const changeset: Changeset = this.store.computeChangeset(timeline);
    const { newClips, updatedClips, removedClips, isNewProject } = changeset;

    // Delete removed clips from ChromaDB immediately (sync-ish, fire-and-forget)
    for (const clip of removedClips) {
      this.chroma.deleteByClipId(clip.clipId).catch((err) => {
        console.error(`[Queue] Failed to delete removed clip ${clip.clipId}:`, err);
      });
    }

    const clipsToProcess = [...newClips, ...updatedClips];
    const jobId = randomUUID();

    // Register job in tracker
    this.tracker.startJob(
      jobId,
      timeline.projectId,
      timeline.projectName,
      clipsToProcess.map((c) => ({ clipId: c.clipId, name: c.name ?? c.clipId })),
      timeline.sequenceName,
    );

    // Register job in SQLite
    this.store.createJob(jobId, timeline.projectId, timeline.projectName, clipsToProcess.length, timeline.sequenceName);

    // Save snapshot before processing — if server crashes mid-job, next POST
    // with the same JSON will see changeset = 0 (conservative but avoids duplicates)
    this.store.saveSnapshot(timeline);

    // Fire-and-forget processing loop
    void this.runPipeline(jobId, timeline.projectId, clipsToProcess);

    return {
      accepted: true,
      jobId,
      projectId: timeline.projectId,
      projectName: timeline.projectName,
      isNewProject,
      changeset: {
        newClips: newClips.length,
        updatedClips: updatedClips.length,
        removedClips: removedClips.length,
      },
    };
  }

  private async runPipeline(
    jobId: string,
    projectId: string,
    clips: PremiereClip[],
  ): Promise<void> {
    const startedAt = Date.now();

    try {
      for (const clip of clips) {
        // Back-pressure: don't let embedStage queue grow unbounded
        await waitForCapacity(this.embedStage as PipelineStage<unknown, unknown>, 50);

        this.tracker.setClipStage(jobId, clip.clipId, 'transcribing');
        this.transcribeStage.push({ jobId, projectId, clip });
      }

      // Drain all stages in order
      await this.transcribeStage.drain();
      await this.embedStage.drain();
      await this.storeStage.drain();

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAt;

      this.tracker.finishJob(jobId, 'done');
      this.store.finishJob(jobId, 'done', completedAt, durationMs);

      console.log(`[Queue] Job ${jobId} done — ${clips.length} clips in ${durationMs}ms`);
    } catch (err) {
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);

      console.error(`[Queue] Job ${jobId} failed:`, message);
      this.tracker.finishJob(jobId, 'error');
      this.store.finishJob(jobId, 'error', completedAt, durationMs);
    }
  }

  private onClipStored(item: PipelineItem): void {
    const chunkCount = item.textChunks?.length ?? 0;
    this.tracker.setClipStage(item.jobId, item.clip.clipId, 'done', {
      totalChunks: chunkCount,
      embeddedChunks: chunkCount,
    });

    // Update SQLite progress counts
    const job = this.tracker.getJob(item.jobId);
    if (job) {
      this.store.updateJobProgress(
        item.jobId,
        job.completedClips,
        job.totalChunks,
        job.embeddedChunks,
      );
    }
  }
}
