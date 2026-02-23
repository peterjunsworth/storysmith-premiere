#!/usr/bin/env tsx
/**
 * run-eval.ts — End-to-end benchmark evaluation
 *
 * Usage:
 *   tsx test/run-eval.ts [--skip-index]
 *
 * --skip-index   Skip re-indexing (reuse existing ChromaDB data)
 *
 * Requires: ChromaDB and Ollama running. Run `tsx test/prepare.ts` first.
 *
 * Outputs:
 *   test/report/report.json     — full machine-readable report
 *   test/report/report.md       — human-readable summary
 */

import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/config.js';
import { EmbeddingPipeline, parseRawExport } from '../src/services/pipeline.js';
import { ProgressTracker } from '../src/services/progress.js';
import { OllamaEmbedService } from '../src/services/embedder.js';
import { ChromaService } from '../src/services/chroma.js';
import { scenarios } from './scenarios.js';
import type { BenchmarkReport, ScenarioResult, TranscriptComparisonResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const REPORT_DIR = resolve(__dirname, 'report');
const TIMELINE_PATH = resolve(FIXTURES, 'timeline.json');
const TRANSCRIPTS_DIR = resolve(FIXTURES, 'transcripts');

const { values } = parseArgs({
  options: { 'skip-index': { type: 'boolean', default: false } },
  allowPositionals: false,
});
const skipIndex = values['skip-index'] as boolean;

const config = loadConfig();
const chroma = new ChromaService(config);
const embedder = new OllamaEmbedService(config);

// ── WER helpers ───────────────────────────────────────────────────────────────

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Simple word-level edit distance (Levenshtein) on token arrays
function editDistance(a: string[], b: string[]): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function computeWer(reference: string, hypothesis: string): number {
  const ref = tokenise(reference);
  const hyp = tokenise(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return Math.min(editDistance(ref, hyp) / ref.length, 1);
}

// ── Load generated transcript from ChromaDB ───────────────────────────────────

async function fetchGeneratedTranscript(clipId: string): Promise<string> {
  const col = await chroma.getCollection();
  const result = await col.get({
    where: { clipId },
    include: ['documents'] as any,
  });
  const docs = (result.documents ?? []) as string[];
  return docs.join(' ');
}

// ── Compare reference vs generated transcript ─────────────────────────────────

async function compareTranscript(
  clipId: string,
  referenceFile: string,
): Promise<TranscriptComparisonResult> {
  const referenceRaw = await fs.readFile(referenceFile, 'utf-8');
  // Strip header/comments (lines starting with --- or The Adventures...)
  const reference = referenceRaw
    .split('\n')
    .filter((l) => !l.startsWith('---') && !l.startsWith('The Adventures') && !l.startsWith('Read by') && !l.startsWith('Source') && !l.startsWith('[SCENE'))
    .join(' ')
    .trim();

  const generated = await fetchGeneratedTranscript(clipId);

  const refTokens = tokenise(reference);
  const genTokens = tokenise(generated);

  // Unique-word overlap: |unique(ref) ∩ unique(gen)| / |unique(ref)|
  // Counts each ref word at most once, regardless of how many times it appears in gen.
  const refSet = new Set(refTokens);
  const genSet = new Set(genTokens);
  const overlap = [...refSet].filter((w) => genSet.has(w)).length;
  const commonWordsRatio = refSet.size > 0 ? overlap / refSet.size : 0;

  const wer = computeWer(reference, generated);

  return {
    clipId,
    referenceWordCount: refTokens.length,
    generatedWordCount: genTokens.length,
    wer,
    werPercent: `${(wer * 100).toFixed(1)}%`,
    commonWordsRatio: parseFloat(commonWordsRatio.toFixed(3)),
    sampleReference: reference.slice(0, 200),
    sampleGenerated: generated.slice(0, 200),
  };
}

// ── Run a single search scenario ──────────────────────────────────────────────

async function runScenario(
  scenario: (typeof scenarios)[0],
  clipTimelineOffsets: Record<string, number>,
): Promise<ScenarioResult> {
  const queryVec = await embedder.embed(scenario.query);
  const hits = await chroma.query(queryVec, 3);

  const top = hits[0] ?? null;
  const top3ClipIds = hits.map((h) => h.clipId);

  const clipOffset = clipTimelineOffsets[scenario.clipId] ?? 0;

  // absoluteStart is the Premiere timeline position stored in ChromaDB metadata.
  // clipRelativeStart = absoluteStart - clip's timelineStart = seconds from clip audio start.
  const absoluteStart = top?.absoluteStart ?? null;
  const clipRelativeStart = absoluteStart !== null
    ? absoluteStart - (clipTimelineOffsets[top!.clipId] ?? 0)
    : null;

  const hitInCorrectClip = top?.clipId === scenario.clipId;
  const hitInTimeWindow = hitInCorrectClip && clipRelativeStart !== null
    ? clipRelativeStart >= scenario.windowStart && clipRelativeStart <= scenario.windowEnd
    : false;

  const chunkTextLower = (top?.chunkText ?? '').toLowerCase();
  const keyPhraseMatched = hitInCorrectClip
    ? scenario.keyPhrases.some((p) => chunkTextLower.includes(p.toLowerCase()))
    : false;

  const top3InCorrectClip = top3ClipIds.includes(scenario.clipId);
  const passed = hitInCorrectClip && hitInTimeWindow && keyPhraseMatched;

  return {
    scenarioId: scenario.id,
    description: scenario.description,
    query: scenario.query,
    expectedClipId: scenario.clipId,
    topHitClipId: top?.clipId ?? null,
    topHitScore: top ? parseFloat(top.score.toFixed(4)) : null,
    absoluteStart: absoluteStart !== null ? parseFloat(absoluteStart.toFixed(2)) : null,
    absoluteEnd: top?.absoluteEnd != null ? parseFloat(top.absoluteEnd.toFixed(2)) : null,
    clipRelativeStart: clipRelativeStart !== null ? parseFloat(clipRelativeStart.toFixed(1)) : null,
    clipTimelineOffset: clipOffset,
    chunkStartMs: top?.chunkStartMs ?? null,
    chunkEndMs: top?.chunkEndMs ?? null,
    hitInCorrectClip,
    hitInTimeWindow,
    keyPhraseMatched,
    chunkText: top?.chunkText ?? '',
    top3ClipIds,
    top3InCorrectClip,
    passed,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const startMs = Date.now();
await fs.mkdir(REPORT_DIR, { recursive: true });

// 1. Load timeline
console.log('[eval] Loading timeline...');
const rawTimeline = JSON.parse(await fs.readFile(TIMELINE_PATH, 'utf-8'));
const timeline = parseRawExport(rawTimeline);

// Build clip → timelineStart offset map
const clipOffsets: Record<string, number> = {};
for (const seq of rawTimeline.sequences ?? []) {
  for (const c of seq.clips ?? []) {
    clipOffsets[c.id] = c.timelineStart ?? 0;
  }
}

// 2. Index (unless skipped)
if (!skipIndex) {
  console.log('[eval] Starting indexing pipeline...');
  const tracker = new ProgressTracker();
  const pipeline = new EmbeddingPipeline(config, tracker);

  tracker.on('job', (job: any) => {
    const pct = job.totalClips > 0
      ? Math.round((job.completedClips / job.totalClips) * 100)
      : 0;
    process.stdout.write(`\r[eval] Indexing... ${job.completedClips}/${job.totalClips} clips (${pct}%) — ${job.embeddedChunks} chunks embedded`);
  });

  const status = await pipeline.indexTimeline(timeline);
  process.stdout.write('\n');

  if (status.failedClips.length > 0) {
    console.warn(`[eval] Warning: ${status.failedClips.length} clips failed:`);
    for (const f of status.failedClips) console.warn(`  ${f.clipId}: ${f.error}`);
  }
  console.log(`[eval] Indexed ${status.indexedClips} clips, ${status.totalChunks} chunks in ${(status.durationMs / 1000).toFixed(1)}s`);
} else {
  console.log('[eval] Skipping indexing (--skip-index)');
}

// 3. Verify ChromaDB metadata completeness
console.log('\n[eval] Verifying ChromaDB metadata...');
const metaErrors: string[] = [];
{
  const col = await chroma.getCollection();
  const sample = await col.get({
    limit: 20,
    include: ['metadatas'] as any,
  });
  const metas = (sample.metadatas ?? []) as Array<Record<string, unknown>>;
  const requiredFields = [
    'clipId', 'chunkIndex', 'filePath',
    'timelineStart', 'timelineEnd',
    'chunkStartMs', 'chunkEndMs',
    'absoluteStart', 'absoluteEnd',
    'projectId',
  ];
  for (const [idx, meta] of metas.entries()) {
    for (const field of requiredFields) {
      if (meta[field] == null) {
        metaErrors.push(`chunk[${idx}]: missing field "${field}"`);
      }
    }
    // Sanity: absoluteStart should be >= timelineStart
    const ts = meta['timelineStart'] as number;
    const abs = meta['absoluteStart'] as number;
    if (typeof ts === 'number' && typeof abs === 'number' && abs < ts - 0.001) {
      metaErrors.push(`chunk[${idx}] clipId=${meta['clipId']}: absoluteStart(${abs}) < timelineStart(${ts})`);
    }
  }
  if (metaErrors.length === 0) {
    console.log(`  ✓ All ${metas.length} sampled chunks have required timestamp fields`);
    // Show a sample
    const first = metas[0];
    if (first) {
      console.log(`  Sample chunk[0]: clipId=${first['clipId']} chunkIndex=${first['chunkIndex']}`);
      console.log(`    timelineStart=${first['timelineStart']}s  absoluteStart=${first['absoluteStart']}s`);
      console.log(`    chunkStartMs=${first['chunkStartMs']}ms  chunkEndMs=${first['chunkEndMs']}ms`);
    }
  } else {
    console.error(`  ✗ ${metaErrors.length} metadata errors:`);
    for (const e of metaErrors.slice(0, 10)) console.error(`    ${e}`);
    if (metaErrors.length > 10) console.error(`    ... and ${metaErrors.length - 10} more`);
    process.exit(1);
  }
}

// 4. Transcript comparison
console.log('\n[eval] Comparing transcripts...');
const transcriptFiles: Record<string, string> = {
  clip_bench_ch08: resolve(TRANSCRIPTS_DIR, 'clip-ch08-reference.txt'),
  clip_bench_ch18: resolve(TRANSCRIPTS_DIR, 'clip-ch18-reference.txt'),
  clip_bench_ch29: resolve(TRANSCRIPTS_DIR, 'clip-ch29-reference.txt'),
};

const transcriptComparisons: TranscriptComparisonResult[] = [];
for (const [clipId, refFile] of Object.entries(transcriptFiles)) {
  process.stdout.write(`  ${clipId}...`);
  try {
    const result = await compareTranscript(clipId, refFile);
    transcriptComparisons.push(result);
    console.log(` WER=${result.werPercent}  overlap=${(result.commonWordsRatio * 100).toFixed(0)}%`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(` FAILED: ${msg}`);
    transcriptComparisons.push({
      clipId,
      referenceWordCount: 0,
      generatedWordCount: 0,
      wer: 1,
      werPercent: 'N/A',
      commonWordsRatio: 0,
      sampleReference: '',
      sampleGenerated: `ERROR: ${msg}`,
    });
  }
}

// 5. Search scenarios
console.log('\n[eval] Running search scenarios...');
const scenarioResults: ScenarioResult[] = [];
for (const scenario of scenarios) {
  process.stdout.write(`  [${scenario.id}] ${scenario.description.slice(0, 50)}...`);
  const result = await runScenario(scenario, clipOffsets);
  scenarioResults.push(result);
  const mark = result.passed ? '✓' : result.hitInCorrectClip ? '~' : '✗';
  console.log(` ${mark} score=${result.topHitScore ?? 'N/A'} clip=${result.topHitClipId ?? 'none'}`);
}

// 6. Build report
const passed = scenarioResults.filter((r) => r.passed).length;
const hitAt1 = scenarioResults.filter((r) => r.hitInCorrectClip).length;
const hitAt3 = scenarioResults.filter((r) => r.top3InCorrectClip).length;
const windowHits = scenarioResults.filter((r) => r.hitInCorrectClip && r.hitInTimeWindow);
const phraseMatched = scenarioResults.filter((r) => r.keyPhraseMatched).length;
const avgScore = scenarioResults
  .filter((r) => r.topHitScore !== null)
  .reduce((s, r) => s + (r.topHitScore ?? 0), 0) / (scenarioResults.length || 1);
const avgWer = transcriptComparisons.reduce((s, r) => s + r.wer, 0) / (transcriptComparisons.length || 1);

const report: BenchmarkReport = {
  runAt: new Date().toISOString(),
  durationMs: Date.now() - startMs,
  transcriptComparisons,
  scenarios: scenarioResults,
  summary: {
    totalScenarios: scenarios.length,
    passed,
    hitAt1,
    hitAt3,
    windowAccuracy: hitAt1 > 0 ? parseFloat((windowHits.length / hitAt1).toFixed(3)) : 0,
    phraseMatchRate: parseFloat((phraseMatched / scenarios.length).toFixed(3)),
    avgTopScore: parseFloat(avgScore.toFixed(4)),
    avgWer: parseFloat(avgWer.toFixed(4)),
  },
};

// 7. Write JSON report
const jsonPath = resolve(REPORT_DIR, 'report.json');
await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));

// 7. Write Markdown report
const md = buildMarkdown(report);
const mdPath = resolve(REPORT_DIR, 'report.md');
await fs.writeFile(mdPath, md);

console.log('\n=== Benchmark Complete ===');
console.log(`Passed:         ${passed}/${scenarios.length}`);
console.log(`Hit@1:          ${hitAt1}/${scenarios.length} (${Math.round(hitAt1 / scenarios.length * 100)}%)`);
console.log(`Hit@3:          ${hitAt3}/${scenarios.length} (${Math.round(hitAt3 / scenarios.length * 100)}%)`);
console.log(`Window acc.:    ${(report.summary.windowAccuracy * 100).toFixed(0)}%`);
console.log(`Phrase match:   ${(report.summary.phraseMatchRate * 100).toFixed(0)}%`);
console.log(`Avg WER:        ${(avgWer * 100).toFixed(1)}%`);
console.log(`Avg score:      ${avgScore.toFixed(4)}`);
console.log(`\nReports saved to ${REPORT_DIR}/`);

// ── Markdown builder ──────────────────────────────────────────────────────────

function buildMarkdown(r: BenchmarkReport): string {
  const s = r.summary;
  const lines: string[] = [];

  lines.push('# Semantic Search Benchmark Report');
  lines.push('');
  lines.push(`**Run:** ${r.runAt}  `);
  lines.push(`**Duration:** ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Scenarios passed (all 3 criteria) | ${s.passed}/${s.totalScenarios} |`);
  lines.push(`| Hit@1 (correct clip in top-1) | ${s.hitAt1}/${s.totalScenarios} (${Math.round(s.hitAt1/s.totalScenarios*100)}%) |`);
  lines.push(`| Hit@3 (correct clip in top-3) | ${s.hitAt3}/${s.totalScenarios} (${Math.round(s.hitAt3/s.totalScenarios*100)}%) |`);
  lines.push(`| Timestamp window accuracy | ${(s.windowAccuracy * 100).toFixed(0)}% |`);
  lines.push(`| Key-phrase match rate | ${(s.phraseMatchRate * 100).toFixed(0)}% |`);
  lines.push(`| Avg cosine similarity score | ${s.avgTopScore} |`);
  lines.push(`| Avg transcript WER | ${(s.avgWer * 100).toFixed(1)}% |`);
  lines.push('');

  lines.push('## Transcript Accuracy');
  lines.push('');
  lines.push('> Compares whisper.cpp output (stored in ChromaDB) against the reference Gutenberg text for key passages.');
  lines.push('');
  lines.push('| Clip | Ref words | Gen words | WER | Overlap |');
  lines.push('|------|-----------|-----------|-----|---------|');
  for (const t of r.transcriptComparisons) {
    lines.push(`| ${t.clipId} | ${t.referenceWordCount} | ${t.generatedWordCount} | ${t.werPercent} | ${(t.commonWordsRatio * 100).toFixed(0)}% |`);
  }
  lines.push('');

  // Sample comparison for first clip
  if (r.transcriptComparisons.length > 0) {
    const t = r.transcriptComparisons[0];
    lines.push('<details>');
    lines.push(`<summary>Sample text comparison — ${t.clipId}</summary>`);
    lines.push('');
    lines.push('**Reference:**');
    lines.push('```');
    lines.push(t.sampleReference);
    lines.push('```');
    lines.push('');
    lines.push('**Generated (whisper.cpp):**');
    lines.push('```');
    lines.push(t.sampleGenerated);
    lines.push('```');
    lines.push('</details>');
    lines.push('');
  }

  lines.push('## Search Scenarios');
  lines.push('');

  for (const sc of r.scenarios) {
    const status = sc.passed ? '✅ PASS' : sc.hitInCorrectClip ? '⚠️  PARTIAL' : '❌ FAIL';
    lines.push(`### [${sc.scenarioId}] ${sc.description}`);
    lines.push('');
    lines.push(`**Status:** ${status}`);
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| Query | \`${sc.query}\` |`);
    lines.push(`| Expected clip | \`${sc.expectedClipId}\` |`);
    lines.push(`| Top-1 clip | \`${sc.topHitClipId ?? 'none'}\` |`);
    lines.push(`| Cosine score | ${sc.topHitScore ?? 'N/A'} |`);
    lines.push(`| Chunk in clip (ms) | ${sc.chunkStartMs != null ? `${sc.chunkStartMs}–${sc.chunkEndMs}ms` : 'N/A'} |`);
    lines.push(`| Clip-relative position | ${sc.clipRelativeStart !== null ? formatTime(sc.clipRelativeStart) : 'N/A'} |`);
    lines.push(`| Absolute Premiere position | ${sc.absoluteStart !== null ? formatTime(sc.absoluteStart) : 'N/A'} |`);
    lines.push(`| Clip timeline offset | ${formatTime(sc.clipTimelineOffset)} |`);
    lines.push(`| In correct clip | ${sc.hitInCorrectClip ? '✓' : '✗'} |`);
    lines.push(`| In time window | ${sc.hitInTimeWindow ? '✓' : '✗'} |`);
    lines.push(`| Key phrase matched | ${sc.keyPhraseMatched ? '✓' : '✗'} |`);
    lines.push(`| Top-3 clip IDs | ${sc.top3ClipIds.join(', ')} |`);
    lines.push('');
    if (sc.chunkText) {
      lines.push('**Matched chunk:**');
      lines.push('```');
      lines.push(sc.chunkText.slice(0, 400) + (sc.chunkText.length > 400 ? '...' : ''));
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')} (${seconds.toFixed(0)}s)`;
}
