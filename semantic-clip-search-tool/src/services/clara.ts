import type { Config, TimelineHit } from '../types/index.js';
import { OllamaEmbedService } from './embedder.js';

interface OllamaGenerateResponse {
  response: string;
}

/**
 * Result from a full two-branch CLaRa expansion.
 *
 * Branch A — CLaRa:     hypothetical spoken excerpts (narrative / dialogue style)
 * Branch B — Keywords:  short lexical phrase variants for direct matching
 *
 * When chromaQuery is provided at call time, mergedHits contains deduplicated
 * results from both branches ranked by best cosine score.
 */
export interface CLaRaResult {
  // Branch A
  hypotheses: string[];
  claraEmbedding: number[];

  // Branch B
  keywordPhrases: string[];
  keywordEmbedding: number[];

  // Merged (only populated when expandWithSearch() is used)
  mergedHits: TimelineHit[];

  // Legacy: average of all texts including original query (for single-vector callers)
  avgEmbedding: number[];
}

// ── Prompt templates ──────────────────────────────────────────────────────────

/**
 * CLaRa Branch A prompt.
 *
 * Goal: produce spoken-word excerpts that sound like they come from the actual
 * audio transcript at the moment being searched. For a small model (llama3.2:1b)
 * the prompt must be:
 *   - Extremely directive (no room to invent meta-commentary)
 *   - Anchored to the entities/concepts in the query
 *   - Explicit about the spoken-word format (narrator prose OR dialogue)
 *
 * Design principles drawn from CLaRa paper + pretrain data analysis:
 *   1. Use named entities from the query verbatim — they are the retrieval anchor
 *   2. Cover different surface forms: narration sentence, then dialogue exchange
 *   3. Vary sentence structure to spread the embedding across the semantic region
 *   4. Keep each excerpt to 1-2 sentences — longer drifts away from the chunk boundary
 *   5. No question marks, no meta-text ("This is about…"), no numbering prose
 */
function buildClaraPrompt(query: string, n: number): string {
  return `You are helping retrieve a specific moment from an audio transcript.
The transcript may be narration (a narrator describing events) or dialogue (characters speaking to each other).

Search query: "${query}"

Write ${n} short transcript excerpts (1-2 sentences each) that would appear at the EXACT moment in the audio this query refers to.
Rules:
- Write as actual spoken or narrated words, NOT as a description or question
- Use the specific names, places, and concepts from the query directly in the text
- Vary the style: some as narration ("He stood there watching…"), some as direct speech ("I never done nothin to a ghost…")
- Each excerpt must be different — cover different phrasings and angles of the same moment
- No intro text, no numbering, no labels. Output ONLY the excerpts, one per line.

Excerpts:`;
}

/**
 * CLaRa Branch B prompt.
 *
 * Goal: produce a flat list of short lexical phrases — synonyms, name variants,
 * paraphrases — that maximise recall when the hypothetical excerpt approach
 * misses because the chunk uses slightly different wording.
 *
 * Design: keep it ultra-short so the small model doesn't hallucinate structure.
 * Output is intentionally terse: keyword clusters, not sentences.
 */
function buildKeywordPrompt(query: string): string {
  return `Search query: "${query}"

List 5 short keyword phrases (2-6 words each) that someone might say in audio about this topic.
Include: synonyms, alternative phrasings, partial quotes, related terms.
Output ONLY the phrases, one per line. No numbers, no punctuation at end, no extra text.

Phrases:`;
}

// ── QueryExpander ─────────────────────────────────────────────────────────────

export class QueryExpander {
  private config: Config;
  private embedder: OllamaEmbedService;

  constructor(config: Config) {
    this.config = config;
    this.embedder = new OllamaEmbedService(config);
  }

  /**
   * Full two-branch expansion.
   * Returns both branch embeddings plus a merged hit list if chromaQuery is provided.
   *
   * @param query       Raw user search query
   * @param chromaQuery Optional function to run a vector search — if provided,
   *                    both branch vectors are searched and results are merged.
   *                    Signature: (vec: number[], topK: number) => Promise<TimelineHit[]>
   * @param topK        How many hits per branch (default 10)
   */
  async expand(
    query: string,
    chromaQuery?: (vec: number[], topK: number) => Promise<TimelineHit[]>,
    topK = 10,
  ): Promise<CLaRaResult> {
    const n = this.config.claraNHypotheses;

    // Run both generation branches in parallel
    const [hypotheses, keywordPhrases] = await Promise.all([
      this.generateHypotheses(query, n),
      this.generateKeywords(query),
    ]);

    // Embed all texts: query + each branch independently
    const allTexts = [query, ...hypotheses, ...keywordPhrases];
    const allEmbeddings = await this.embedder.embedBatch(allTexts);

    // Slice back into per-branch groups
    const queryVec       = allEmbeddings[0];
    const claraVecs      = allEmbeddings.slice(1, 1 + hypotheses.length);
    const keywordVecs    = allEmbeddings.slice(1 + hypotheses.length);

    // Branch embeddings: average within each branch
    const claraEmbedding   = averageVectors([queryVec, ...claraVecs]);
    const keywordEmbedding = averageVectors([queryVec, ...keywordVecs]);

    // Legacy single-vector: average across ALL texts (unchanged behaviour)
    const avgEmbedding = averageVectors(allEmbeddings);

    // Run both branch searches in parallel if chromaQuery is provided
    let mergedHits: TimelineHit[] = [];
    if (chromaQuery) {
      const [claraHits, keywordHits] = await Promise.all([
        chromaQuery(claraEmbedding, topK),
        chromaQuery(keywordEmbedding, topK),
      ]);
      mergedHits = mergeHits(claraHits, keywordHits, topK);
    }

    return {
      hypotheses,
      claraEmbedding,
      keywordPhrases,
      keywordEmbedding,
      mergedHits,
      avgEmbedding,
    };
  }

  // ── Private generation methods ──────────────────────────────────────────────

  private async generateHypotheses(query: string, n: number): Promise<string[]> {
    const prompt = buildClaraPrompt(query, n);
    const raw = await this.ollamaGenerate(prompt);
    const lines = parseLines(raw, n);
    // Fallback: if the model returned nothing useful, use the query itself
    return lines.length > 0 ? lines : [query];
  }

  private async generateKeywords(query: string): Promise<string[]> {
    const prompt = buildKeywordPrompt(query);
    const raw = await this.ollamaGenerate(prompt);
    const lines = parseLines(raw, 6);
    return lines.length > 0 ? lines : [query];
  }

  private async ollamaGenerate(prompt: string): Promise<string> {
    const url = `${this.config.ollamaUrl}/api/generate`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.config.ollamaLlmModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          // Keep outputs short — small model drifts with long generation
          num_predict: 300,
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama generate failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    return data.response ?? '';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a raw LLM response into clean non-empty lines.
 * Strips numbered list prefixes (1. / 1) / - / •), trims whitespace,
 * and drops any line that looks like meta-commentary from the model.
 */
function parseLines(text: string, max: number): string[] {
  return text
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*[\d]+[.)]\s*/, '')   // "1. " or "1) "
        .replace(/^\s*[-•*]\s*/, '')        // "- " or "• "
        .trim(),
    )
    .filter((l) => {
      if (l.length < 4) return false;
      // Drop lines that are clearly model preamble, not content
      const lower = l.toLowerCase();
      if (lower.startsWith('here are')) return false;
      if (lower.startsWith('excerpts:')) return false;
      if (lower.startsWith('phrases:')) return false;
      if (lower.startsWith('sure,')) return false;
      if (lower.startsWith('of course')) return false;
      return true;
    })
    .slice(0, max);
}

/**
 * Average a list of equal-dimension vectors.
 */
function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += vec[i];
  }
  return sum.map((v) => v / vectors.length);
}

/**
 * Merge two hit lists, deduplicate by chunk id, keep best score per chunk,
 * sort descending by score, return top-K.
 */
function mergeHits(a: TimelineHit[], b: TimelineHit[], topK: number): TimelineHit[] {
  const best = new Map<string, TimelineHit>();

  for (const hit of [...a, ...b]) {
    const key = `${hit.clipId}:${hit.chunkIndex}`;
    const existing = best.get(key);
    if (!existing || hit.score > existing.score) {
      best.set(key, hit);
    }
  }

  return [...best.values()]
    .sort((x, y) => y.score - x.score)
    .slice(0, topK)
    .map((h, i) => ({ ...h, rank: i + 1 }));
}
