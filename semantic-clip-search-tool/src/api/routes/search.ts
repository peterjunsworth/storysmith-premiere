import { Router, Request, Response } from 'express';
import type { Config, SearchRequest, SearchResponse, TimelineHit } from '../../types/index.js';
import { QueryExpander } from '../../services/clara.js';
import { OllamaEmbedService } from '../../services/embedder.js';
import { ChromaService } from '../../services/chroma.js';

export function createSearchRouter(config: Config): Router {
  const router = Router();
  const expander = new QueryExpander(config);
  const embedder = new OllamaEmbedService(config);
  const chroma = new ChromaService(config);

  router.post('/', async (req: Request, res: Response) => {
    const start = Date.now();
    const body = req.body as SearchRequest;

    if (!body.query || typeof body.query !== 'string') {
      res.status(400).json({ error: 'Missing required field: query' });
      return;
    }

    const topK = body.topK ?? 10;
    const expandQuery = body.expandQuery !== false;
    const whereFilter = body.projectId ? { projectId: body.projectId } : undefined;

    try {
      let hits: TimelineHit[];
      let expandedQueries: string[] | undefined;

      if (expandQuery) {
        const result = await expander.expand(
          body.query,
          (vec, k) => chroma.query(vec, k, whereFilter),
          topK,
        );
        // Use merged two-branch hits; fall back to legacy single-vector if empty
        hits = result.mergedHits.length > 0
          ? result.mergedHits
          : await chroma.query(result.avgEmbedding, topK, whereFilter);
        expandedQueries = [
          ...result.hypotheses.map((h) => `[CLaRa] ${h}`),
          ...result.keywordPhrases.map((k) => `[kw] ${k}`),
        ];
      } else {
        const queryVector = await embedder.embed(body.query);
        hits = await chroma.query(queryVector, topK, whereFilter);
      }

      const response: SearchResponse = {
        query: body.query,
        expandedQueries,
        hits,
        durationMs: Date.now() - start,
      };

      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[Search] Error:', message);
      res.status(500).json({ error: 'Search failed', message });
    }
  });

  return router;
}
