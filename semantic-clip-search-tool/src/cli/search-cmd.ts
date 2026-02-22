#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/config.js';
import { checkDeps } from '../services/health.js';
import { QueryExpander } from '../services/clara.js';
import { OllamaEmbedService } from '../services/embedder.js';
import { ChromaService } from '../services/chroma.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'no-expand': { type: 'boolean', default: false },
    'top-k': { type: 'string', default: '10' },
  },
});

const query = positionals[0];

if (!query) {
  console.error('Usage: tsx src/cli/search-cmd.ts "query" [--no-expand] [--top-k 5]');
  process.exit(1);
}

const noExpand = values['no-expand'] as boolean;
const topK = parseInt(values['top-k'] as string, 10);

const config = loadConfig();
await checkDeps(config);

const expander = new QueryExpander(config);
const embedder = new OllamaEmbedService(config);
const chroma = new ChromaService(config);

const start = Date.now();
console.log(`[search-cmd] Query: "${query}" (expand=${!noExpand}, topK=${topK})`);

let queryVector: number[];
let hypotheses: string[] | undefined;

if (!noExpand) {
  console.log('[search-cmd] Generating hypotheses via CLaRa...');
  const result = await expander.expand(query);
  queryVector = result.avgEmbedding;
  hypotheses = result.hypotheses;

  console.log('\nExpanded queries:');
  hypotheses.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));
} else {
  queryVector = await embedder.embed(query);
}

const hits = await chroma.query(queryVector, topK);
const durationMs = Date.now() - start;

console.log(`\n=== Top ${hits.length} Results (${durationMs}ms) ===\n`);

if (hits.length === 0) {
  console.log('No results found. Have you indexed any timelines?');
  process.exit(0);
}

for (const hit of hits) {
  const start = formatTime(hit.timelineStart);
  const end = formatTime(hit.timelineEnd);
  console.log(`[${hit.rank}] score=${hit.score.toFixed(4)}  ${start} – ${end}`);
  console.log(`    clip: ${hit.clipId}`);
  console.log(`    file: ${hit.filePath}`);
  console.log(`    text: ${hit.chunkText.slice(0, 120)}${hit.chunkText.length > 120 ? '...' : ''}`);
  console.log('');
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
