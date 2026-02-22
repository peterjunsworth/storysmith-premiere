import type { Config } from '../types/index.js';

interface OllamaEmbeddingResponse {
  embedding: number[];
}

export class OllamaEmbedService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async embed(text: string): Promise<number[]> {
    const url = `${this.config.ollamaUrl}/api/embeddings`;
    const body = {
      model: this.config.ollamaEmbedModel,
      prompt: text,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama embed failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as OllamaEmbeddingResponse;
    return data.embedding;
  }

  // Sequential calls — Ollama Metal GPU handles one request at a time efficiently
  // onChunkDone(completedCount) is called after each chunk for progress reporting
  async embedBatch(texts: string[], onChunkDone?: (done: number) => void): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const text of texts) {
      embeddings.push(await this.embed(text));
      onChunkDone?.(embeddings.length);
    }
    return embeddings;
  }
}
