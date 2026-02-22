import { ChromaClient, Collection } from 'chromadb';
import type { Config, IndexedChunk, ChunkMetadata, TimelineHit } from '../types/index.js';

const COLLECTION_NAME = 'premiere_clips';

export class ChromaService {
  private client: ChromaClient;
  private collection: Collection | null = null;

  constructor(config: Config) {
    this.client = new ChromaClient({ path: config.chromaUrl });
  }

  async getCollection(): Promise<Collection> {
    if (this.collection) return this.collection;

    this.collection = await this.client.getOrCreateCollection({
      name: COLLECTION_NAME,
      metadata: { 'hnsw:space': 'cosine' },
    });

    return this.collection;
  }

  async upsertChunks(chunks: IndexedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const col = await this.getCollection();

    await col.upsert({
      ids: chunks.map((c) => c.id),
      embeddings: chunks.map((c) => c.embedding),
      documents: chunks.map((c) => c.document),
      metadatas: chunks.map((c) => c.metadata as unknown as Record<string, string | number>),
    });
  }

  async query(
    queryEmbedding: number[],
    nResults: number,
    whereFilter?: Record<string, string | number>,
  ): Promise<TimelineHit[]> {
    const col = await this.getCollection();

    const queryParams: Parameters<Collection['query']>[0] = {
      queryEmbeddings: [queryEmbedding],
      nResults,
      include: ['documents', 'metadatas', 'distances'] as any,
    };

    if (whereFilter && Object.keys(whereFilter).length > 0) {
      queryParams.where = whereFilter;
    }

    const result = await col.query(queryParams);

    const hits: TimelineHit[] = [];
    const ids = result.ids[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const documents = result.documents[0] ?? [];
    const metadatas = result.metadatas[0] ?? [];

    for (let i = 0; i < ids.length; i++) {
      const meta = metadatas[i] as unknown as ChunkMetadata;
      hits.push({
        rank: i + 1,
        score: 1 - (distances[i] ?? 0),   // cosine similarity from distance
        clipId: meta.clipId,
        filePath: meta.filePath,
        timelineStart: meta.timelineStart,
        timelineEnd: meta.timelineEnd,
        chunkText: documents[i] ?? '',
        chunkIndex: meta.chunkIndex,
        chunkStartMs: meta.chunkStartMs,
        chunkEndMs: meta.chunkEndMs,
        absoluteStart: meta.absoluteStart,
        absoluteEnd: meta.absoluteEnd,
      });
    }

    return hits;
  }

  async deleteByProjectId(projectId: string): Promise<void> {
    const col = await this.getCollection();
    await col.delete({ where: { projectId } });
  }

  async deleteByClipId(clipId: string): Promise<void> {
    const col = await this.getCollection();
    await col.delete({ where: { clipId } });
  }

  /**
   * Drop the entire collection and recreate it empty.
   * Invalidates the cached collection reference.
   */
  async resetCollection(): Promise<void> {
    try {
      await this.client.deleteCollection({ name: COLLECTION_NAME });
    } catch {
      // collection may not exist yet — safe to ignore
    }
    this.collection = null;
    await this.getCollection(); // recreates with cosine metadata
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.heartbeat();
      return true;
    } catch {
      return false;
    }
  }
}
