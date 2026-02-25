// All shared TypeScript interfaces for premiere-semantic-search

export interface PremiereClip {
  clipId: string;
  filePath: string;
  timelineStart: number;   // seconds
  timelineEnd: number;     // seconds
  duration: number;
  hasAudio: boolean;
  name?: string;
}

export interface PremiereTimeline {
  projectId: string;
  projectName: string;
  sequenceName?: string;
  exportedAt: string;
  clips: PremiereClip[];
}

// Raw Premiere JSON export format (sequences-based)
export interface PremierRawClip {
  id: string;
  name: string;
  filePath: string | null;
  trackType: 'video' | 'audio';
  trackIndex: number;
  timelineStart: number;
  timelineEnd: number;
  inPoint: number;
  outPoint: number;
  duration: number;
  startTicks: string;
  endTicks: string;
  hasAudio?: boolean;
}

export interface PremiereRawSequence {
  sequenceName: string;
  totalClips: number;
  videoClips: number;
  audioClips: number;
  totalDuration: number;
  clips: PremierRawClip[];
}

export interface PremiereRawExport {
  sequences: PremiereRawSequence[];
  projectPath: string;
  timestamp: string;
}

export interface ChunkMetadata {
  clipId: string;
  chunkIndex: number;
  filePath: string;
  // Clip-level absolute Premiere timeline positions (seconds)
  timelineStart: number;
  timelineEnd: number;
  projectId: string;
  // Per-chunk position within the clip (milliseconds from clip start)
  chunkStartMs: number;
  chunkEndMs: number;
  // Absolute Premiere timeline position for this chunk (seconds)
  absoluteStart: number;
  absoluteEnd: number;
}

export interface TextChunk {
  text: string;
  chunkIndex: number;
  metadata: ChunkMetadata;
}

export interface IndexedChunk {
  id: string;              // unique: `${clipId}_chunk_${chunkIndex}`
  embedding: number[];
  document: string;        // chunk text
  metadata: ChunkMetadata;
}

export interface IndexEvent {
  filePath: string;
  timeline: PremiereTimeline;
}

export interface IndexStatus {
  projectId: string;
  totalClips: number;
  indexedClips: number;
  totalChunks: number;
  failedClips: Array<{ clipId: string; error: string }>;
  durationMs: number;
}

export type ClipStage = 'pending' | 'transcribing' | 'chunking' | 'embedding' | 'storing' | 'done' | 'error';

export interface ClipProgress {
  clipId: string;
  name: string;
  stage: ClipStage;
  totalChunks: number;
  embeddedChunks: number;
  error?: string;
}

export type JobState = 'running' | 'done' | 'error' | 'interrupted';

export interface Changeset {
  newClips: PremiereClip[];
  updatedClips: PremiereClip[];
  removedClips: PremiereClip[];
  isNewProject: boolean;
}

export interface TimedSegment {
  text: string;
  startMs: number;
  endMs: number;
}

export interface PipelineItem {
  jobId: string;
  projectId: string;
  clip: PremiereClip;
  segments?: TimedSegment[];
  textChunks?: TextChunk[];
  embeddings?: number[][];
}

export interface JobProgress {
  jobId: string;
  projectId: string;
  projectName: string;
  sequenceName?: string;
  state: JobState;
  totalClips: number;
  completedClips: number;
  totalChunks: number;
  embeddedChunks: number;
  clips: ClipProgress[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export interface SearchRequest {
  query: string;
  topK?: number;           // default 10
  expandQuery?: boolean;   // default true (CLaRa)
  projectId?: string;      // optional filter
}

export interface TimelineHit {
  rank: number;
  score: number;
  clipId: string;
  filePath: string;
  // Clip-level Premiere timeline bounds (seconds)
  timelineStart: number;
  timelineEnd: number;
  chunkText: string;
  chunkIndex: number;
  // Per-chunk position within the clip (milliseconds from clip start)
  chunkStartMs: number;
  chunkEndMs: number;
  // Absolute Premiere timeline position for this chunk (seconds)
  absoluteStart: number;
  absoluteEnd: number;
}

export interface SearchResponse {
  query: string;
  expandedQueries?: string[];
  hits: TimelineHit[];
  durationMs: number;
}

export interface Config {
  whisperBin: string;
  whisperModel: string;
  whisperThreads: number;
  whisperConcurrency: number;
  ollamaUrl: string;
  ollamaEmbedModel: string;
  ollamaLlmModel: string;
  chromaUrl: string;
  port: number;
  serverUrl: string;
  timelineWatchGlob: string;
  claraNHypotheses: number;
}
