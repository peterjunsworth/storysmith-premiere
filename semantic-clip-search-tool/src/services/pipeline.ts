import { randomUUID } from 'node:crypto';
import type {
  Config,
  PremiereTimeline,
  PremiereClip,
  TextChunk,
  IndexedChunk,
  IndexStatus,
  PipelineItem,
} from '../types/index.js';
import { WhisperService } from './whisper.js';
import { ChunkService } from './chunker.js';
import { OllamaEmbedService } from './embedder.js';
import { ChromaService } from './chroma.js';
import { ProgressTracker } from './progress.js';

export class EmbeddingPipeline {
  private whisper: WhisperService;
  private chunker: ChunkService;
  private embedder: OllamaEmbedService;
  private chroma: ChromaService;
  private tracker: ProgressTracker | null;

  constructor(config: Config, tracker?: ProgressTracker) {
    this.whisper = new WhisperService(config);
    this.chunker = new ChunkService();
    this.embedder = new OllamaEmbedService(config);
    this.chroma = new ChromaService(config);
    this.tracker = tracker ?? null;
  }

  async indexTimeline(timeline: PremiereTimeline): Promise<IndexStatus> {
    const startTime = Date.now();
    const audioClips = timeline.clips.filter((c) => c.hasAudio && c.filePath);

    const jobId = randomUUID();
    this.tracker?.startJob(
      jobId,
      timeline.projectId,
      timeline.projectName,
      audioClips.map((c) => ({ clipId: c.clipId, name: c.name ?? c.clipId })),
    );

    const status: IndexStatus = {
      projectId: timeline.projectId,
      totalClips: audioClips.length,
      indexedClips: 0,
      totalChunks: 0,
      failedClips: [],
      durationMs: 0,
    };

    for (const clip of audioClips) {
      try {
        const chunks = await this.indexClip(clip, timeline.projectId, jobId);
        status.indexedClips++;
        status.totalChunks += chunks;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.failedClips.push({ clipId: clip.clipId, error: message });
        this.tracker?.setClipStage(jobId, clip.clipId, 'error', { error: message });
      }
    }

    status.durationMs = Date.now() - startTime;
    this.tracker?.finishJob(jobId, status.failedClips.length === status.totalClips && status.totalClips > 0 ? 'error' : 'done');
    return status;
  }

  private async indexClip(clip: PremiereClip, projectId: string, jobId: string): Promise<number> {
    this.tracker?.setClipStage(jobId, clip.clipId, 'transcribing');
    const segments = await this.whisper.transcribe(clip.filePath);

    if (segments.length === 0 || segments.every((s) => !s.text.trim())) {
      this.tracker?.setClipStage(jobId, clip.clipId, 'done');
      return 0;
    }

    this.tracker?.setClipStage(jobId, clip.clipId, 'chunking');
    const rawChunks = this.chunker.chunk(segments);

    const textChunks: TextChunk[] = rawChunks.map((chunk) => ({
      text: chunk.text,
      chunkIndex: chunk.chunkIndex,
      metadata: {
        clipId: clip.clipId,
        chunkIndex: chunk.chunkIndex,
        filePath: clip.filePath,
        timelineStart: clip.timelineStart,
        timelineEnd: clip.timelineEnd,
        projectId,
        // Per-chunk timing: milliseconds from clip audio start
        chunkStartMs: chunk.startMs,
        chunkEndMs: chunk.endMs,
        // Absolute Premiere timeline position (seconds)
        absoluteStart: clip.timelineStart + chunk.startMs / 1000,
        absoluteEnd: clip.timelineStart + chunk.endMs / 1000,
      },
    }));

    this.tracker?.setClipStage(jobId, clip.clipId, 'embedding');
    this.tracker?.setChunkProgress(jobId, clip.clipId, textChunks.length, 0);

    const embeddings = await this.embedder.embedBatch(
      textChunks.map((c) => c.text),
      (done) => this.tracker?.setChunkProgress(jobId, clip.clipId, textChunks.length, done),
    );

    this.tracker?.setClipStage(jobId, clip.clipId, 'storing');
    const indexedChunks: IndexedChunk[] = textChunks.map((chunk, i) => ({
      id: `${chunk.metadata.clipId}_chunk_${chunk.chunkIndex}`,
      embedding: embeddings[i],
      document: chunk.text,
      metadata: chunk.metadata,
    }));

    await this.chroma.upsertChunks(indexedChunks);

    this.tracker?.setClipStage(jobId, clip.clipId, 'done', {
      totalChunks: indexedChunks.length,
      embeddedChunks: indexedChunks.length,
    });

    return indexedChunks.length;
  }
}

// ── Pipeline-item function for IndexQueue ─────────────────────────────────────

/**
 * Transcribe a clip and build text chunks.
 * Used by IndexQueue's pipelined transcribeStage.
 */
export async function transcribeClip(
  item: PipelineItem,
  whisper: WhisperService,
  chunker: ChunkService,
): Promise<PipelineItem> {
  const { clip, projectId } = item;
  const segments = await whisper.transcribe(clip.filePath);

  if (segments.length === 0 || segments.every((s) => !s.text.trim())) {
    return { ...item, segments: [], textChunks: [] };
  }

  const rawChunks = chunker.chunk(segments);
  const textChunks: TextChunk[] = rawChunks.map((chunk) => ({
    text: chunk.text,
    chunkIndex: chunk.chunkIndex,
    metadata: {
      clipId: clip.clipId,
      chunkIndex: chunk.chunkIndex,
      filePath: clip.filePath,
      timelineStart: clip.timelineStart,
      timelineEnd: clip.timelineEnd,
      projectId,
      chunkStartMs: chunk.startMs,
      chunkEndMs: chunk.endMs,
      absoluteStart: clip.timelineStart + chunk.startMs / 1000,
      absoluteEnd: clip.timelineStart + chunk.endMs / 1000,
    },
  }));

  return { ...item, segments, textChunks };
}

// Parse raw Premiere export format → normalized PremiereTimeline
export function parseRawExport(raw: unknown): PremiereTimeline {
  const data = raw as {
    sequences?: Array<{
      clips?: Array<{
        id: string;
        name: string;
        filePath: string | null;
        timelineStart: number;
        timelineEnd: number;
        duration: number;
        hasAudio?: boolean;
      }>;
    }>;
    projectPath?: string;
    timestamp?: string;
  };

  const projectPath = data.projectPath ?? 'unknown';
  const projectId = projectPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-40);
  const projectName = projectPath.split('/').pop() ?? 'unknown';

  const clips: PremiereClip[] = [];

  for (const seq of data.sequences ?? []) {
    for (const clip of seq.clips ?? []) {
      if (clip.hasAudio && clip.filePath) {
        clips.push({
          clipId: clip.id,
          filePath: clip.filePath,
          timelineStart: clip.timelineStart,
          timelineEnd: clip.timelineEnd,
          duration: clip.duration,
          hasAudio: true,
          name: clip.name,
        });
      }
    }
  }

  return {
    projectId,
    projectName,
    exportedAt: data.timestamp ?? new Date().toISOString(),
    clips,
  };
}
