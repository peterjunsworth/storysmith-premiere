/**
 * Regenerates test/report/timeline.html from:
 *   - test/report/report.json   (scenario results + summary)
 *   - ChromaDB                  (all chunk metadata for timeline bars)
 *
 * Usage:
 *   npx tsx test/report/build-html.ts
 *   (or via:  npm run report:html)
 */

import { ChromaClient } from 'chromadb';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { BenchmarkReport } from '../types.js';
import { scenarios as scenarioDefs } from '../scenarios.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_JSON = resolve(__dirname, 'report.json');
const OUT_HTML    = resolve(__dirname, 'timeline.html');
const CHROMA_URL  = process.env.CHROMA_URL ?? 'http://localhost:8000';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtMs(ms: number): string {
  return ms.toLocaleString() + 'ms';
}

// ── Fetch all chunk metadata from ChromaDB ────────────────────────────────────

interface ChunkMeta {
  i: number;     // chunkIndex
  s: number;     // chunkStartMs
  e: number;     // chunkEndMs
  as: number;    // absoluteStart (s)
  ae: number;    // absoluteEnd (s)
}

async function fetchChunks(): Promise<Record<string, ChunkMeta[]>> {
  const client = new ChromaClient({ path: CHROMA_URL });
  const col = await client.getCollection({ name: 'premiere_clips' });
  const total = await col.count();

  const result = await col.get({
    limit: total,
    include: ['metadatas'] as any,
  });

  const metadatas = (result.metadatas ?? []) as Record<string, unknown>[];
  const byClip: Record<string, ChunkMeta[]> = {};

  for (const meta of metadatas) {
    const clipId  = meta['clipId']  as string;
    const shortId = clipId.replace('clip_bench_', '');
    if (!byClip[shortId]) byClip[shortId] = [];
    byClip[shortId].push({
      i:  meta['chunkIndex']   as number,
      s:  meta['chunkStartMs'] as number,
      e:  meta['chunkEndMs']   as number,
      as: meta['absoluteStart'] as number,
      ae: meta['absoluteEnd']   as number,
    });
  }

  for (const key of Object.keys(byClip)) {
    byClip[key].sort((a, b) => a.i - b.i);
  }

  return byClip;
}

// ── Compute clip timeline bounds from chunk data ──────────────────────────────

interface ClipInfo {
  id: string;       // e.g. clip_bench_ch08
  short: string;    // ch08
  start: number;    // absoluteStart of clip (s)
  end: number;      // absoluteEnd of clip (s)
  dur: number;      // duration (s)
  color: string;
  count: number;
  label: string;
}

const CLIP_COLORS: Record<string, string> = {
  ch08: '#3b82f6',
  ch18: '#a855f7',
  ch29: '#f97316',
};

const CLIP_LABELS: Record<string, string> = {
  ch08: 'Chapter 8',
  ch18: 'Chapter 18',
  ch29: 'Chapter 29',
};

const CLIP_FILES: Record<string, string> = {
  ch08: 'huckfinn_08_twain_apc.wav',
  ch18: 'huckfinn_18_twain_apc.wav',
  ch29: 'huckfinn_29_twain_apc.wav',
};

function deriveClips(chunks: Record<string, ChunkMeta[]>): ClipInfo[] {
  return Object.entries(chunks).map(([short, list]) => {
    const start = Math.min(...list.map(c => c.as));
    const end   = Math.max(...list.map(c => c.ae));
    return {
      id:    `clip_bench_${short}`,
      short,
      start,
      end,
      dur:   end - start,
      color: CLIP_COLORS[short] ?? '#888',
      count: list.length,
      label: CLIP_LABELS[short] ?? short,
    };
  }).sort((a, b) => a.start - b.start);
}

// ── Build HTML string ─────────────────────────────────────────────────────────

function buildHtml(
  report: BenchmarkReport,
  chunks: Record<string, ChunkMeta[]>,
  clips: ClipInfo[],
): string {
  const totalDur = Math.max(...clips.map(c => c.end));
  const totalChunks = Object.values(chunks).reduce((s, a) => s + a.length, 0);

  const { summary, scenarios: results, transcriptComparisons, runAt } = report;

  // Map scenarioId → result
  const resultMap = new Map(results.map(r => [r.scenarioId, r]));

  // Map clipId → timelineStart offset
  const clipOffsets = Object.fromEntries(clips.map(c => [c.id, c.start]));

  // Map scenarioDef id → window bounds
  const windowMap = new Map(scenarioDefs.map(s => [s.id, { start: s.windowStart, end: s.windowEnd }]));

  // ── Summary card colour ──────────────────────────────────────────────────────
  function cardColor(pct: number, invert = false): string {
    const good = invert ? pct < 0.4 : pct >= 0.7;
    const mid  = invert ? pct < 0.7 : pct >= 0.4;
    return good ? 'green' : mid ? 'yellow' : 'red';
  }

  const passedPct    = summary.passed / summary.totalScenarios;
  const hitAt1Pct    = summary.hitAt1 / summary.totalScenarios;
  const hitAt3Pct    = summary.hitAt3 / summary.totalScenarios;
  const windowPct    = summary.windowAccuracy;
  const phrasePct    = summary.phraseMatchRate;
  const avgScore     = summary.avgTopScore;

  // ── Scenario JS data ─────────────────────────────────────────────────────────
  const scenarioJs = results.map(r => {
    const clip = clips.find(c => c.id === r.topHitClipId);
    const short = clip?.short ?? r.topHitClipId?.replace('clip_bench_', '') ?? 'unknown';
    return `  { id:'${r.scenarioId}', absStart:${r.absoluteStart ?? 0}, clipId:'${short}', passed:${r.passed}, clipOk:${r.hitInCorrectClip}, windowOk:${r.hitInTimeWindow}, phraseOk:${r.keyPhraseMatched} }`;
  }).join(',\n');

  // ── Chunks JS data ───────────────────────────────────────────────────────────
  const chunksJs = Object.entries(chunks).map(([short, list]) => {
    const arr = list.map(c => `{"i":${c.i},"s":${c.s},"e":${c.e},"as":${c.as},"ae":${c.ae}}`).join(',');
    return `  ${short}: [${arr}]`;
  }).join(',\n');

  // ── Clips JS data ────────────────────────────────────────────────────────────
  const clipsJs = clips.map(c =>
    `  ${c.short}: { id:'${c.id}', start:${c.start}, end:${c.end}, dur:${c.dur}, color:'${c.color}', count:${c.count} }`
  ).join(',\n');

  // ── Per-clip stat cards HTML ─────────────────────────────────────────────────
  function clipCardHtml(clip: ClipInfo): string {
    const tc = transcriptComparisons.find(t => t.clipId === clip.id);
    const overlapPct = tc ? (tc.commonWordsRatio * 100).toFixed(1) + '%' : 'N/A';
    const genWords = tc ? tc.generatedWordCount.toLocaleString() : 'N/A';
    const avgChunkLen = clip.count > 0 ? (clip.dur / clip.count).toFixed(1) : 'N/A';

    // Which scenarios target this clip
    const targeting = scenarioDefs
      .filter(s => s.clipId === clip.id)
      .map(s => s.id).join(', ');
    const passed = results
      .filter(r => r.expectedClipId === clip.id && r.passed).length;
    const total  = results
      .filter(r => r.expectedClipId === clip.id).length;

    return `
  <div class="clip-card">
    <div class="clip-card-title" style="color:${clip.color}">${clip.id}</div>
    <div class="clip-card-sub">${CLIP_FILES[clip.short] ?? ''} — ${clip.label}</div>
    <div class="clip-stat">Timeline position <span>${fmt(clip.start)} → ${fmt(clip.end)}</span></div>
    <div class="clip-stat">Duration <span>${clip.dur.toFixed(1)}s</span></div>
    <div class="clip-stat">Chunks indexed <span>${clip.count}</span></div>
    <div class="clip-stat">Avg chunk length <span>~${avgChunkLen}s</span></div>
    <div class="clip-stat">Transcript words <span>~${genWords}</span></div>
    <div class="clip-stat">Word overlap vs ref <span>${overlapPct}</span></div>
    <div class="clip-stat">Scenarios targeting <span>${targeting}</span></div>
    <div class="clip-stat">Scenarios passed <span>${passed} of ${total}</span></div>
    <div class="chunk-mini-bar" id="mini-${clip.short}"></div>
  </div>`;
  }

  // ── Scenario table rows HTML ─────────────────────────────────────────────────
  function scenarioRow(r: BenchmarkReport['scenarios'][0]): string {
    const expClip  = clips.find(c => c.id === r.expectedClipId);
    const hitClip  = clips.find(c => c.id === (r.topHitClipId ?? ''));
    const expColor = expClip?.color ?? '#888';
    const hitColor = hitClip?.color ?? '#888';
    const expShort = r.expectedClipId.replace('clip_bench_', '');
    const hitShort = (r.topHitClipId ?? '').replace('clip_bench_', '');
    const score    = r.topHitScore ?? 0;
    const clipRel  = r.clipRelativeStart !== null ? fmt(r.clipRelativeStart) : '—';
    const absTime  = r.absoluteStart !== null ? fmt(r.absoluteStart) : '—';

    const badge = r.passed
      ? '<span class="badge badge-pass">PASS</span>'
      : (r.hitInCorrectClip
        ? '<span class="badge badge-partial">PARTIAL</span>'
        : '<span class="badge badge-fail">FAIL</span>');

    const ck = (v: boolean) => v ? '<td class="check">✓</td>' : '<td class="cross">✗</td>';
    const wk = r.hitInTimeWindow
      ? '<td class="check">✓</td>'
      : (r.hitInCorrectClip ? '<td class="cross warn">✗</td>' : '<td class="cross">✗</td>');

    return `
      <tr>
        <td class="mono">${r.scenarioId}</td>
        <td>${r.description}</td>
        <td><span style="color:${expColor}">${expShort}</span></td>
        <td><span style="color:${hitColor}">${hitShort}</span></td>
        <td>
          <div class="score-bar">
            <div class="score-fill" style="width:${(score * 100).toFixed(1)}px"></div>
            <span>${score.toFixed(3)}</span>
          </div>
        </td>
        <td class="mono">${clipRel}</td>
        <td class="mono">${absTime}</td>
        ${ck(r.hitInCorrectClip)}
        ${wk}
        ${ck(r.keyPhraseMatched)}
        <td>${badge}</td>
      </tr>`;
  }

  // ── Window detail rows HTML ──────────────────────────────────────────────────
  function windowRow(r: BenchmarkReport['scenarios'][0]): string {
    const w = windowMap.get(r.scenarioId);
    const windowStr = w ? `${fmt(w.start)}–${fmt(w.end)}` : '—';
    const hitClip   = clips.find(c => c.id === (r.topHitClipId ?? ''));
    const hitColor  = hitClip?.color ?? '#888';
    const hitShort  = (r.topHitClipId ?? '').replace('clip_bench_', '');
    const isWrongClip = !r.hitInCorrectClip;

    const matchedStr = r.clipRelativeStart !== null
      ? `${fmt(r.clipRelativeStart)}${isWrongClip ? ` <span style="color:${hitColor}">(${hitShort})</span>` : ''}`
      : '—';
    const msRange = r.chunkStartMs !== null && r.chunkEndMs !== null
      ? `${fmtMs(r.chunkStartMs)}–${fmtMs(r.chunkEndMs)}`
      : '—';

    let note = '';
    if (isWrongClip) {
      note = `Wrong clip — ${hitShort} returned instead of ${r.expectedClipId.replace('clip_bench_', '')}`;
    } else if (r.hitInTimeWindow) {
      note = `Correct — matched at ${r.clipRelativeStart !== null ? fmt(r.clipRelativeStart) : '?'} within ${r.expectedClipId.replace('clip_bench_', '')}`;
    } else if (r.clipRelativeStart !== null && w) {
      const diff = r.clipRelativeStart < w.start
        ? `before window by ~${fmt(w.start - r.clipRelativeStart)}`
        : `after window by ~${fmt(r.clipRelativeStart - w.end)}`;
      note = `Off — chunk at ${fmt(r.clipRelativeStart)}, ${diff}`;
    }

    const tick = r.hitInTimeWindow
      ? '<td class="check">✓</td>'
      : (r.hitInCorrectClip ? '<td class="cross warn">✗</td>' : '<td class="cross">✗</td>');

    return `
      <tr>
        <td class="mono">${r.scenarioId}</td>
        <td class="mono">${windowStr}</td>
        <td class="mono">${matchedStr}</td>
        <td class="mono">${msRange}</td>
        ${tick}
        <td style="color:#64748b">${note}</td>
      </tr>`;
  }

  // ── WER / overlap section HTML ───────────────────────────────────────────────
  function werRows(): string {
    return transcriptComparisons.map(tc => {
      const clip   = clips.find(c => c.id === tc.clipId);
      const color  = clip?.color ?? '#888';
      const short  = tc.clipId;
      const pct    = (tc.commonWordsRatio * 100).toFixed(1);
      const barW   = Math.min(tc.commonWordsRatio * 100, 100).toFixed(1);
      // derive unique word counts from ratio: overlap = ratio * refUniq → refUniq needed
      // we store only ratio; show pct + gen words
      return `
  <div class="wer-row">
    <div class="wer-clip" style="color:${color}">${short}</div>
    <div class="wer-bar-bg"><div class="wer-bar-fill" style="width:${barW}%;background:${color}"></div></div>
    <div class="wer-label">${pct}% overlap · ~${tc.generatedWordCount.toLocaleString()} gen words</div>
  </div>`;
    }).join('\n');
  }

  // ── Per-clip bar label ───────────────────────────────────────────────────────
  function clipBarRow(clip: ClipInfo): string {
    return `
  <div class="tl-clip-row">
    <div class="tl-clip-label">
      <b style="color:${clip.color}">${clip.id}</b>
      <span class="right">${clip.label} · ${clip.count} chunks · ${fmt(clip.start)}–${fmt(clip.end)} (${Math.round(clip.dur)}s)</span>
    </div>
    <div class="tl-bar-bg" id="bar-${clip.short}" style="height:40px;"></div>
  </div>`;
  }

  // ── Full bar JS calls ────────────────────────────────────────────────────────
  const drawFullBar = clips.map((c, i) => {
    const scenFilter = i === 0
      ? `scenarios.filter(s => s.clipId === '${c.short}' || !Object.keys(clips).includes(s.clipId))`
      : `scenarios.filter(s => s.clipId === '${c.short}')`;
    return `drawBar(fullbar, '${c.short}', chunks.${c.short}, clips.${c.short}.start, TOTAL_DUR, clips.${c.short}.dur, ${scenFilter});`;
  }).join('\n');

  const drawClipBars = clips.map(c =>
    `drawClipBar('bar-${c.short}', '${c.short}', chunks.${c.short}, clips.${c.short}.dur, clips.${c.short}.start, scenarios.filter(s => s.clipId === '${c.short}'));`
  ).join('\n');

  const drawMinis = clips.map(c =>
    `drawMini('mini-${c.short}', '${c.short}', chunks.${c.short}, clips.${c.short}.dur);`
  ).join('\n');

  // ── Legend items ─────────────────────────────────────────────────────────────
  const legendItems = clips.map(c =>
    `<span><span class="legend-dot" style="background:${c.color}"></span>${c.id} (${c.label} — ${fmt(c.start)}–${fmt(c.end)})</span>`
  ).join('\n    ');

  // ── Ruler ticks (every 10 min) ───────────────────────────────────────────────
  const rulerSteps: number[] = [];
  for (let t = 0; t <= totalDur; t += 600) rulerSteps.push(t);
  if (rulerSteps[rulerSteps.length - 1] < totalDur) rulerSteps.push(totalDur);

  // ── Assemble ─────────────────────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Semantic Search — Timeline &amp; Benchmark</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1117; color: #e2e8f0; padding: 32px 24px; min-width: 900px; }
  h1 { font-size: 20px; font-weight: 600; color: #f8fafc; margin-bottom: 4px; }
  .subtitle { font-size: 12px; color: #64748b; margin-bottom: 32px; }

  .cards { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 32px; }
  .card { background: #1e2330; border: 1px solid #2d3548; border-radius: 8px; padding: 14px 16px; }
  .card-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  .card-value { font-size: 22px; font-weight: 700; color: #f8fafc; }
  .card-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .card.green .card-value { color: #4ade80; }
  .card.yellow .card-value { color: #facc15; }
  .card.red .card-value { color: #f87171; }

  .section-title { font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 14px; }

  .timeline-wrap { background: #1e2330; border: 1px solid #2d3548; border-radius: 10px; padding: 24px; margin-bottom: 32px; }
  .tl-ruler { position: relative; height: 20px; margin-bottom: 6px; }
  .tl-ruler-tick { position: absolute; top: 0; font-size: 10px; color: #475569; transform: translateX(-50%); white-space: nowrap; }
  .tl-ruler-line { position: absolute; top: 14px; width: 1px; height: 6px; background: #2d3548; transform: translateX(-50%); }
  .tl-clip-row { position: relative; margin-bottom: 20px; }
  .tl-clip-label { font-size: 11px; color: #94a3b8; margin-bottom: 5px; display: flex; justify-content: space-between; }
  .tl-clip-label span.right { color: #475569; font-size: 10px; }
  .tl-bar-bg { position: relative; height: 36px; background: #141720; border-radius: 4px; overflow: visible; }
  .tl-clip-extent { position: absolute; top: 0; height: 100%; border-radius: 4px; opacity: .25; }
  .tl-chunk { position: absolute; top: 3px; height: 30px; border-radius: 2px; opacity: .7; cursor: pointer; transition: opacity .15s; }
  .tl-chunk:hover { opacity: 1; z-index: 10; }
  .tl-marker { position: absolute; top: -8px; width: 2px; bottom: -8px; z-index: 20; pointer-events: none; }
  .tl-marker-label { position: absolute; top: -20px; left: 50%; transform: translateX(-50%); font-size: 9px; font-weight: 700; white-space: nowrap; padding: 1px 4px; border-radius: 3px; }

  .scenarios-wrap { background: #1e2330; border: 1px solid #2d3548; border-radius: 10px; padding: 24px; margin-bottom: 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead th { text-align: left; padding: 6px 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: #64748b; border-bottom: 1px solid #2d3548; }
  tbody tr { border-bottom: 1px solid #1a1f2e; }
  tbody tr:hover { background: #252c3d; }
  tbody td { padding: 9px 10px; vertical-align: middle; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .badge-pass    { background: #14532d; color: #4ade80; }
  .badge-partial { background: #422006; color: #fb923c; }
  .badge-fail    { background: #450a0a; color: #f87171; }
  .mono { font-family: "SF Mono", "Fira Code", monospace; font-size: 11px; }
  .score-bar { display: flex; align-items: center; gap: 6px; }
  .score-fill { height: 5px; border-radius: 3px; background: #3b82f6; }
  .check { color: #4ade80; }
  .cross { color: #f87171; }
  .warn  { color: #facc15; }

  .clips-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 32px; }
  .clip-card { background: #1e2330; border: 1px solid #2d3548; border-radius: 10px; padding: 20px; }
  .clip-card-title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .clip-card-sub { font-size: 11px; color: #64748b; margin-bottom: 16px; }
  .clip-stat { display: flex; justify-content: space-between; font-size: 11px; color: #94a3b8; margin-bottom: 6px; }
  .clip-stat span { color: #e2e8f0; font-weight: 500; }
  .chunk-mini-bar { display: flex; gap: 1px; flex-wrap: wrap; margin-top: 12px; }
  .chunk-mini { width: 7px; height: 14px; border-radius: 1px; flex-shrink: 0; }

  .wer-wrap { background: #1e2330; border: 1px solid #2d3548; border-radius: 10px; padding: 24px; margin-bottom: 32px; }
  .wer-row { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; font-size: 12px; }
  .wer-clip { width: 180px; color: #94a3b8; word-break: break-all; }
  .wer-bar-bg { flex: 1; height: 8px; background: #141720; border-radius: 4px; overflow: hidden; }
  .wer-bar-fill { height: 100%; border-radius: 4px; }
  .wer-label { width: 220px; text-align: right; color: #64748b; font-size: 11px; }

  #tooltip { position: fixed; background: #1e2330; border: 1px solid #2d3548; border-radius: 6px; padding: 8px 12px; font-size: 11px; color: #e2e8f0; pointer-events: none; opacity: 0; transition: opacity .1s; z-index: 999; max-width: 320px; line-height: 1.6; }

  .legend { display: flex; gap: 18px; margin-bottom: 12px; font-size: 11px; color: #94a3b8; align-items: center; flex-wrap: wrap; }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; margin-right: 4px; }
</style>
</head>
<body>

<h1>Semantic Search — Timeline &amp; Benchmark Report</h1>
<p class="subtitle">Run: ${runAt} &nbsp;·&nbsp; ${clips.length} clips &nbsp;·&nbsp; ${totalChunks} chunks &nbsp;·&nbsp; ${summary.totalScenarios} scenarios &nbsp;·&nbsp; Whisper base.en + nomic-embed-text + llama3.2:1b CLaRa</p>

<!-- Summary cards -->
<div class="cards">
  <div class="card ${cardColor(passedPct)}">
    <div class="card-label">Scenarios Passed</div>
    <div class="card-value">${summary.passed}/${summary.totalScenarios}</div>
    <div class="card-sub">all 3 criteria</div>
  </div>
  <div class="card ${cardColor(hitAt1Pct)}">
    <div class="card-label">Hit @ 1</div>
    <div class="card-value">${Math.round(hitAt1Pct * 100)}%</div>
    <div class="card-sub">${summary.hitAt1} of ${summary.totalScenarios} correct clip</div>
  </div>
  <div class="card ${cardColor(hitAt3Pct)}">
    <div class="card-label">Hit @ 3</div>
    <div class="card-value">${Math.round(hitAt3Pct * 100)}%</div>
    <div class="card-sub">${summary.hitAt3} of ${summary.totalScenarios} in top-3</div>
  </div>
  <div class="card ${cardColor(windowPct)}">
    <div class="card-label">Window Accuracy</div>
    <div class="card-value">${Math.round(windowPct * 100)}%</div>
    <div class="card-sub">of correct-clip hits</div>
  </div>
  <div class="card ${cardColor(phrasePct)}">
    <div class="card-label">Phrase Match</div>
    <div class="card-value">${Math.round(phrasePct * 100)}%</div>
    <div class="card-sub">key phrase in chunk</div>
  </div>
  <div class="card ${cardColor(avgScore)}">
    <div class="card-label">Avg Cosine</div>
    <div class="card-value">${avgScore.toFixed(3)}</div>
    <div class="card-sub">similarity score</div>
  </div>
</div>

<!-- Full Timeline -->
<div class="timeline-wrap">
  <div class="section-title">Premiere Timeline — ${totalChunks} Chunks Across ${clips.length} Clips</div>
  <div class="legend">
    ${legendItems}
    <span><span class="legend-dot" style="background:#facc15; border-radius:50%"></span>Scenario hit</span>
  </div>
  <div class="tl-ruler" id="ruler"></div>
  <div class="tl-bar-bg" id="fullbar" style="height:44px;"></div>
</div>

<!-- Per-clip timeline rows -->
<div class="timeline-wrap" style="margin-top:-16px;">
  <div class="section-title">Per-Clip Chunk Distribution</div>
  ${clips.map(clipBarRow).join('\n')}
</div>

<!-- Per-clip stat cards -->
<div class="clips-grid">
  ${clips.map(clipCardHtml).join('\n')}
</div>

<!-- Scenario table -->
<div class="scenarios-wrap">
  <div class="section-title">Search Scenarios</div>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Description</th><th>Expected Clip</th><th>Hit Clip</th>
        <th>Score</th><th>Clip-relative</th><th>Abs. Premiere</th>
        <th>Clip ✓</th><th>Window ✓</th><th>Phrase ✓</th><th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${results.map(scenarioRow).join('\n')}
    </tbody>
  </table>
</div>

<!-- Window accuracy detail -->
<div class="scenarios-wrap" style="margin-top:-16px;">
  <div class="section-title">Timestamp Window Check Detail</div>
  <table>
    <thead>
      <tr>
        <th>Scenario</th><th>Expected window (clip-relative)</th>
        <th>Matched chunk (clip-relative)</th><th>Chunk (ms range)</th>
        <th>Window match</th><th>Note</th>
      </tr>
    </thead>
    <tbody>
      ${results.map(windowRow).join('\n')}
    </tbody>
  </table>
</div>

<!-- Transcript coverage -->
<div class="wer-wrap">
  <div class="section-title">Transcript Coverage (Word Overlap vs Gutenberg Reference)</div>
  <p style="font-size:11px;color:#475569;margin-bottom:16px;">Unique-word overlap: how many distinct words in the reference excerpt also appear at least once in the Whisper-generated transcript. Both sides deduplicated before comparison — each reference word counted once.</p>
  ${werRows()}
</div>

<div id="tooltip"></div>

<script>
const TOTAL_DUR = ${totalDur};

const clips = {
${clipsJs}
};

const chunks = {
${chunksJs}
};

const scenarios = [
${scenarioJs}
];

const tooltip = document.getElementById('tooltip');

function fmt(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}
function showTip(e, html) {
  tooltip.innerHTML = html;
  tooltip.style.opacity = '1';
  moveTip(e);
}
function moveTip(e) {
  let x = e.clientX + 12, y = e.clientY + 12;
  if (x + 330 > window.innerWidth) x = e.clientX - 330 - 12;
  tooltip.style.left = x + 'px';
  tooltip.style.top  = y + 'px';
}
function hideTip() { tooltip.style.opacity = '0'; }
document.addEventListener('mousemove', (e) => { if (tooltip.style.opacity !== '0') moveTip(e); });

function buildRuler(container) {
  const steps = [${rulerSteps.join(', ')}];
  steps.forEach(t => {
    const pct = (t / TOTAL_DUR) * 100;
    const tick = document.createElement('div');
    tick.className = 'tl-ruler-tick';
    tick.style.left = pct + '%';
    tick.textContent = fmt(t);
    container.appendChild(tick);
    const line = document.createElement('div');
    line.className = 'tl-ruler-line';
    line.style.left = pct + '%';
    container.appendChild(line);
  });
}

function drawBar(container, clipKey, chunkList, absOffset, totalDur, barDur, markerScenarios) {
  const clip = clips[clipKey];
  const color = clip.color;
  const ext = document.createElement('div');
  ext.className = 'tl-clip-extent';
  ext.style.left  = ((clip.start / totalDur) * 100) + '%';
  ext.style.width = ((barDur / totalDur) * 100) + '%';
  ext.style.background = color;
  container.appendChild(ext);

  chunkList.forEach(c => {
    const el = document.createElement('div');
    el.className = 'tl-chunk';
    el.style.left  = ((c.as / totalDur) * 100) + '%';
    el.style.width = Math.max(((c.ae - c.as) / totalDur) * 100, 0.15) + '%';
    el.style.background = color;
    el.addEventListener('mouseenter', (e) => {
      showTip(e, '<b>chunk ' + c.i + '</b> &nbsp; ' + clipKey + '<br>clip-relative: ' + fmt(c.s/1000) + ' – ' + fmt(c.e/1000) + '<br>absolute: ' + fmt(c.as) + ' – ' + fmt(c.ae) + '<br>duration: ' + ((c.e-c.s)/1000).toFixed(1) + 's');
    });
    el.addEventListener('mouseleave', hideTip);
    container.appendChild(el);
  });

  (markerScenarios || []).forEach(sc => {
    const pct = (sc.absStart / totalDur) * 100;
    const markerColor = sc.passed ? '#4ade80' : sc.clipOk ? '#facc15' : '#f87171';
    const m = document.createElement('div');
    m.className = 'tl-marker';
    m.style.left = pct + '%';
    m.style.background = markerColor;
    const lbl = document.createElement('div');
    lbl.className = 'tl-marker-label';
    lbl.style.background = markerColor;
    lbl.style.color = '#0f1117';
    lbl.textContent = sc.id;
    m.appendChild(lbl);
    container.appendChild(m);
  });
}

function drawClipBar(containerId, clipKey, chunkList, clipDur, clipAbsStart, markerScenarios) {
  const container = document.getElementById(containerId);
  const color = clips[clipKey].color;
  const bg = document.createElement('div');
  bg.style.cssText = 'position:absolute;left:0;right:0;top:0;bottom:0;border-radius:4px;';
  bg.style.background = color;
  bg.style.opacity = '0.08';
  container.appendChild(bg);

  chunkList.forEach(c => {
    const el = document.createElement('div');
    el.className = 'tl-chunk';
    el.style.left  = ((c.s / 1000 / clipDur) * 100) + '%';
    el.style.width = Math.max(((c.e - c.s) / 1000 / clipDur) * 100, 0.2) + '%';
    el.style.background = color;
    el.addEventListener('mouseenter', (e) => {
      showTip(e, '<b>' + clipKey + ' chunk ' + c.i + '</b><br>clip-relative: ' + fmt(c.s/1000) + ' – ' + fmt(c.e/1000) + '<br>absolute timeline: ' + fmt(c.as) + ' – ' + fmt(c.ae) + '<br>duration: ' + ((c.e-c.s)/1000).toFixed(1) + 's');
    });
    el.addEventListener('mouseleave', hideTip);
    container.appendChild(el);
  });

  (markerScenarios || []).forEach(sc => {
    const relPos = sc.absStart - clipAbsStart;
    const pct = (relPos / clipDur) * 100;
    if (pct < 0 || pct > 100) return;
    const markerColor = sc.passed ? '#4ade80' : sc.clipOk ? '#facc15' : '#f87171';
    const m = document.createElement('div');
    m.className = 'tl-marker';
    m.style.left = pct + '%';
    m.style.background = markerColor;
    const lbl = document.createElement('div');
    lbl.className = 'tl-marker-label';
    lbl.style.background = markerColor;
    lbl.style.color = '#0f1117';
    lbl.textContent = sc.id;
    m.appendChild(lbl);
    container.appendChild(m);
  });
}

function drawMini(containerId, clipKey, chunkList, clipDur) {
  const container = document.getElementById(containerId);
  const color = clips[clipKey].color;
  chunkList.forEach(c => {
    const el = document.createElement('div');
    el.className = 'chunk-mini';
    el.style.background = color;
    el.style.opacity = String(0.3 + (c.s / 1000 / clipDur) * 0.7);
    el.title = 'chunk ' + c.i + ': ' + fmt(c.s/1000) + '-' + fmt(c.e/1000);
    container.appendChild(el);
  });
}

const fullbar = document.getElementById('fullbar');
${drawFullBar}
${drawClipBars}
${drawMinis}
buildRuler(document.getElementById('ruler'));
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('[build-html] Reading report.json...');
const reportRaw = await readFile(REPORT_JSON, 'utf-8');
const report: BenchmarkReport = JSON.parse(reportRaw);

console.log('[build-html] Fetching chunk metadata from ChromaDB...');
const chunks = await fetchChunks();
const totalChunks = Object.values(chunks).reduce((s, a) => s + a.length, 0);
console.log(`[build-html] Fetched ${totalChunks} chunks across ${Object.keys(chunks).length} clips`);

const clips = deriveClips(chunks);
clips.forEach(c => console.log(`  ${c.id}: ${c.count} chunks, ${fmt(c.start)}–${fmt(c.end)} (${c.dur.toFixed(1)}s)`));

console.log('[build-html] Building HTML...');
const html = buildHtml(report, chunks, clips);

await writeFile(OUT_HTML, html, 'utf-8');
console.log(`[build-html] Written → ${OUT_HTML}`);
