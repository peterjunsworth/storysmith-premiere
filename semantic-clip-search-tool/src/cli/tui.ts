#!/usr/bin/env tsx
/**
 * Interactive TUI for Premiere Semantic Search
 *
 * Menus:
 *   1. Search      — run queries with optional CLaRa expansion
 *   2. Projects    — list projects, inspect clips & embedding status
 *   3. Embeddings  — browse / delete by clip or project
 *   4. Queue       — view live + historical indexing jobs (via server API)
 *   5. DB Admin    — collection stats, reset, health check
 *
 * No external deps beyond what the project already uses.
 * Navigation: arrow keys / j/k, Enter to select, Esc/q to go back.
 */

import * as readline from 'node:readline';
import { loadConfig } from '../config/config.js';
import { ChromaService } from '../services/chroma.js';
import { OllamaEmbedService } from '../services/embedder.js';
import { QueryExpander } from '../services/clara.js';
import type { TimelineHit, JobProgress } from '../types/index.js';

// ── ANSI helpers ───────────────────────────────────────────────────────────────

const ESC  = '\x1B';
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const ALTSCR_ON  = `${ESC}[?1049h`;     // enter alternate screen (no scroll history)
const ALTSCR_OFF = `${ESC}[?1049l`;     // restore normal screen
const CLR  = `${ESC}[2J${ESC}[H`;       // clear screen + go home
const EOL  = `${ESC}[K`;                // erase to end of line
const BOLD = `${ESC}[1m`;
const DIM  = `${ESC}[2m`;
const RST  = `${ESC}[0m`;
const REV  = `${ESC}[7m`;               // reverse video (highlight)
const RED  = `${ESC}[31m`;
const GRN  = `${ESC}[32m`;
const YLW  = `${ESC}[33m`;
const CYN  = `${ESC}[36m`;
const WHT  = `${ESC}[97m`;

const COLS = () => process.stdout.columns || 100;
const ROWS = () => process.stdout.rows    || 40;

function write(s: string) { process.stdout.write(s); }
function writeln(s = '') { write(s + EOL + '\n'); }
function hr() { writeln(DIM + '─'.repeat(COLS()) + RST); }
function bold(s: string) { return BOLD + s + RST; }
function dim(s: string)  { return DIM  + s + RST; }
function grn(s: string)  { return GRN  + s + RST; }
function red(s: string)  { return RED  + s + RST; }
function yel(s: string)  { return YLW  + s + RST; }
function cyn(s: string)  { return CYN  + s + RST; }
function fmt(s: number): string {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtMs(ms: number): string {
  const s = ms / 1000;
  return fmt(s);
}
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}
function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

// ── Init services ──────────────────────────────────────────────────────────────

const config = loadConfig();
const chroma  = new ChromaService(config);
const embedder = new OllamaEmbedService(config);
const expander = new QueryExpander(config);
const SERVER_URL = config.serverUrl;

// ── Server API helpers ─────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${SERVER_URL}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() as T };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

async function apiDelete(path: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: `HTTP ${res.status}: ${body['message'] ?? body['error'] ?? ''}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

async function apiPost<T>(path: string, body?: unknown): Promise<{ ok: boolean; data: T }> {
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as T;
    return { ok: res.ok, data };
  } catch (e: any) {
    return { ok: false, data: { error: e.message ?? String(e) } as T };
  }
}

// ── ChromaDB helpers ───────────────────────────────────────────────────────────

interface ChunkRow {
  id: string;
  document: string;
  clipId: string;
  projectId: string;
  chunkIndex: number;
  chunkStartMs: number;
  chunkEndMs: number;
  absoluteStart: number;
  absoluteEnd: number;
  timelineStart: number;
  timelineEnd: number;
  filePath: string;
}

async function fetchAll(): Promise<ChunkRow[]> {
  const col = await chroma.getCollection();
  const total = await col.count();
  if (total === 0) return [];
  const result = await col.get({
    limit: total,
    include: ['documents', 'metadatas'] as any,
  });
  const ids   = result.ids ?? [];
  const docs  = (result.documents ?? []) as string[];
  const metas = (result.metadatas  ?? []) as Record<string, unknown>[];
  return ids.map((id, i) => {
    const m = metas[i] ?? {};
    return {
      id,
      document: docs[i] ?? '',
      clipId:        m['clipId']        as string ?? '',
      projectId:     m['projectId']     as string ?? '',
      chunkIndex:    m['chunkIndex']    as number ?? 0,
      chunkStartMs:  m['chunkStartMs']  as number ?? 0,
      chunkEndMs:    m['chunkEndMs']    as number ?? 0,
      absoluteStart: m['absoluteStart'] as number ?? 0,
      absoluteEnd:   m['absoluteEnd']   as number ?? 0,
      timelineStart: m['timelineStart'] as number ?? 0,
      timelineEnd:   m['timelineEnd']   as number ?? 0,
      filePath:      m['filePath']      as string ?? '',
    };
  });
}

// Group rows into: { projectId → { clipId → ChunkRow[] } }
function groupByProject(rows: ChunkRow[]): Map<string, Map<string, ChunkRow[]>> {
  const proj = new Map<string, Map<string, ChunkRow[]>>();
  for (const row of rows) {
    if (!proj.has(row.projectId)) proj.set(row.projectId, new Map());
    const clips = proj.get(row.projectId)!;
    if (!clips.has(row.clipId)) clips.set(row.clipId, []);
    clips.get(row.clipId)!.push(row);
  }
  return proj;
}

// ── Keyboard input ─────────────────────────────────────────────────────────────

type Key = 'up' | 'down' | 'enter' | 'esc' | 'backspace' | 'delete' | string;

// Forward-declared; assigned at bottom after setupRaw() is called
let teardown: () => void = () => {};

function setupRaw(): () => void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
  }
  // Enter alternate screen so redraws never pollute the scroll-back buffer
  write(ALTSCR_ON + HIDE);
  return () => {
    write(ALTSCR_OFF + SHOW);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  };
}

function waitKey(): Promise<Key> {
  return new Promise((resolve) => {
    const onData = (ch: string) => {
      process.stdin.removeListener('data', onData);
      if (ch === '\r' || ch === '\n')  return resolve('enter');
      if (ch === '\x1B[A' || ch === 'k') return resolve('up');
      if (ch === '\x1B[B' || ch === 'j') return resolve('down');
      if (ch === '\x1B[5~' || ch === '\x1B[6~\x1B[5~') return resolve('pageup');   // Page-Up
      if (ch === '\x1B[6~')              return resolve('pagedown');                 // Page-Down
      if (ch === '\x1B' || ch === 'q')   return resolve('esc');
      if (ch === '\x7F' || ch === '\b')  return resolve('backspace');
      if (ch === '\x03')                 { teardown(); process.exit(0); }
      resolve(ch);
    };
    process.stdin.on('data', onData);
  });
}

// ── Menu primitive ─────────────────────────────────────────────────────────────

interface MenuItem {
  label: string;
  sub?: string;
}

/**
 * Render a scrollable menu and return selected index (or -1 for Esc).
 * Redraws whenever a key is pressed or the terminal is resized.
 * maxVisible is capped at 40 items and recalculated from live ROWS() on every draw.
 */
async function menu(
  title: string,
  items: MenuItem[],
  opts: { startIdx?: number; hint?: string } = {},
): Promise<number> {
  if (items.length === 0) {
    write(CLR);
    writeln(bold(title));
    hr();
    writeln(dim('  (no items)'));
    hr();
    writeln(dim('  Press any key to go back'));
    await waitKey();
    return -1;
  }

  let idx = opts.startIdx ?? 0;

  // header (title + hr) = 2 lines, footer (hr + hint) = 2–3 lines, overflow indicators = up to 2
  const OVERHEAD = 7;

  const draw = () => {
    // Re-read terminal dimensions on every draw so resize is respected immediately.
    // Reserve 2 rows for potential overflow indicators (↑ / ↓) inside the item area.
    const totalSlots = Math.min(40, Math.max(4, ROWS() - OVERHEAD));
    write(CLR);
    writeln(bold(WHT + title + RST));
    hr();

    // Compute the scroll window keeping cursor centred
    let start = Math.max(0, Math.min(idx - Math.floor(totalSlots / 2), items.length - totalSlots));
    let end   = Math.min(items.length, start + totalSlots);

    // Shrink visible range by 1 on each side that needs an indicator,
    // so indicators never push content past the OVERHEAD budget.
    const needTop = start > 0;
    const needBot = end < items.length;
    if (needTop) start = Math.min(start + 1, end);
    if (needBot) end   = Math.max(end - 1, start);

    if (needTop) writeln(dim(`  ↑ ${start} more above`));
    for (let i = start; i < end; i++) {
      const item   = items[i];
      const cursor = i === idx ? REV + ' › ' + RST : '   ';
      const cols   = COLS();
      // Total visible budget: cols minus the 3-char cursor prefix and 1-char right gutter
      const budget = cols - 4;
      // Label gets up to half the budget (min 10), sub gets the rest
      const labelMax = Math.max(10, Math.floor(budget * 0.5));
      const subMax   = budget - labelMax - 2; // -2 for the '  ' separator
      const labelStr = pad(item.label, labelMax);
      const subStr   = item.sub && subMax > 4
        ? dim('  ' + (item.sub.length > subMax ? item.sub.slice(0, subMax - 1) + '…' : item.sub))
        : '';
      writeln(cursor + labelStr + subStr);
    }
    if (needBot) writeln(dim(`  ↓ ${items.length - end} more below`));

    hr();
    writeln(dim('  ↑↓ / j·k  navigate    PgDn/PgUp  page    Enter  select    Esc / q  back'));
    if (opts.hint) writeln(dim('  ' + opts.hint));
  };

  // Redraw on terminal resize
  const onResize = () => draw();
  process.stdout.on('resize', onResize);

  draw();
  try {
    while (true) {
      const k = await waitKey();
      if (k === 'esc') return -1;
      if (k === 'up'   || k === 'k') { idx = Math.max(0, idx - 1); draw(); continue; }
      if (k === 'down' || k === 'j') { idx = Math.min(items.length - 1, idx + 1); draw(); continue; }
      // Page navigation
      if (k === 'pagedown' || k === 'f' || k === ' ') {
        const pageSize = Math.min(40, Math.max(4, ROWS() - OVERHEAD));
        idx = Math.min(items.length - 1, idx + pageSize);
        draw(); continue;
      }
      if (k === 'pageup' || k === 'b' || k === 'u') {
        const pageSize = Math.min(40, Math.max(4, ROWS() - OVERHEAD));
        idx = Math.max(0, idx - pageSize);
        draw(); continue;
      }
      if (k === 'enter') return idx;
    }
  } finally {
    process.stdout.removeListener('resize', onResize);
  }
}

// ── Confirm dialog ─────────────────────────────────────────────────────────────

async function confirm(msg: string): Promise<boolean> {
  write(CLR);
  writeln(bold(yel('⚠  Confirm')));
  hr();
  writeln('  ' + msg);
  writeln('');
  writeln('  ' + REV + ' y ' + RST + '  confirm    ' + dim('any other key cancels'));
  hr();
  const k = await waitKey();
  return k === 'y' || k === 'Y';
}

// ── Inline text input ──────────────────────────────────────────────────────────

async function textInput(prompt: string, initial = ''): Promise<string | null> {
  write(CLR);
  writeln(bold(prompt));
  hr();
  writeln(dim('  Type your input. Enter to confirm, Esc to cancel.'));
  writeln('');

  // Switch back to line-mode for readline
  if (process.stdin.isTTY) process.stdin.setRawMode(false);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string | null>((resolve) => {
    write('  > ');
    rl.question('', (ans) => {
      rl.close();
      resolve(ans.trim() || null);
    });
    rl.on('SIGINT', () => { rl.close(); resolve(null); });
  });

  // Drain any bytes that readline left in the stdin buffer (e.g. the trailing
  // newline from Enter) before switching back to raw mode.  Without this,
  // the next waitKey() call immediately resolves with 'enter', making it look
  // like the user has to type their input a second time.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (process.stdin.isTTY) {
    process.stdin.read(); // discard any residual buffered bytes
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  return answer;
}

// ── Pager ──────────────────────────────────────────────────────────────────────

async function pager(title: string, lines: string[]): Promise<void> {
  // header + hr = 2, footer hr + hint = 2  → 4 lines overhead
  const OVERHEAD = 4;
  let offset = 0;

  const draw = () => {
    // Re-read terminal height on every draw so window resize is respected
    const pageSize = Math.min(40, Math.max(4, ROWS() - OVERHEAD));
    // Clamp offset so it never exceeds what the current page size allows
    offset = Math.min(offset, Math.max(0, lines.length - pageSize));

    write(CLR);
    writeln(bold(title));
    hr();

    const slice = lines.slice(offset, offset + pageSize);
    for (const l of slice) writeln(l);

    // Fill remaining rows so the footer always stays at the same position
    const blank = pageSize - slice.length;
    for (let i = 0; i < blank; i++) writeln('');

    hr();
    const end = Math.min(offset + pageSize, lines.length);
    writeln(dim(
      `  ↑↓ / j·k  line    PgDn/f/Space  page-down    PgUp/b/u  page-up    q/Esc  back` +
      `    [${offset + 1}–${end} / ${lines.length}]`
    ));
  };

  const onResize = () => draw();
  process.stdout.on('resize', onResize);

  draw();
  try {
    while (true) {
      const k = await waitKey();
      if (k === 'esc' || k === 'q') return;

      const pageSize = Math.min(40, Math.max(4, ROWS() - OVERHEAD));
      const maxOffset = Math.max(0, lines.length - pageSize);

      if (k === 'up'   || k === 'k') { offset = Math.max(0, offset - 1); draw(); }
      if (k === 'down' || k === 'j') { offset = Math.min(maxOffset, offset + 1); draw(); }

      // Page-down: space, f, PageDown escape sequence
      if (k === ' ' || k === 'f' || k === 'pagedown') {
        offset = Math.min(maxOffset, offset + pageSize);
        draw();
      }
      // Page-up: u, b, PageUp escape sequence
      if (k === 'u' || k === 'b' || k === 'pageup') {
        offset = Math.max(0, offset - pageSize);
        draw();
      }
    }
  } finally {
    process.stdout.removeListener('resize', onResize);
  }
}

// ── Loading spinner ────────────────────────────────────────────────────────────

const SPIN = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinTimer: ReturnType<typeof setInterval> | null = null;
let spinFrame = 0;

function spinStart(msg: string) {
  write(CLR);
  writeln(bold(msg));
  spinTimer = setInterval(() => {
    write(`\r  ${CYN}${SPIN[spinFrame % SPIN.length]}${RST}  ${msg}${EOL}`);
    write('\x1B[1A');
    spinFrame++;
  }, 80);
}

function spinStop() {
  if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  write('\r' + EOL + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// ── SCREENS ──────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. SEARCH ─────────────────────────────────────────────────────────────────

async function screenSearch(): Promise<void> {
  while (true) {
    const choice = await menu('Search', [
      { label: '🔍  Run search query', sub: 'with CLaRa expansion' },
      { label: '⚡  Run search query (no expansion)', sub: 'embed query directly' },
    ]);
    if (choice < 0) return;

    const expand = choice === 0;
    const query = await textInput('Search query');
    if (!query) continue;

    const topKStr = await textInput('Top-K results', '10');
    const topK = parseInt(topKStr ?? '10', 10) || 10;

    spinStart('Running search…');
    const start = Date.now();
    let hits: TimelineHit[] = [];
    let hypotheses: string[] | undefined;
    let keywordPhrases: string[] | undefined;

    try {
      if (expand) {
        const res = await expander.expand(
          query,
          (vec, k) => chroma.query(vec, k),
          topK,
        );
        hypotheses    = res.hypotheses;
        keywordPhrases = res.keywordPhrases;
        hits = res.mergedHits.length > 0
          ? res.mergedHits
          : await chroma.query(res.avgEmbedding, topK);
      } else {
        hits = await chroma.query(await embedder.embed(query), topK);
      }
    } catch (e: any) {
      spinStop();
      await pager('Error', [`${red('Error:')} ${e.message ?? String(e)}`]);
      continue;
    }
    spinStop();

    const elapsed = Date.now() - start;

    // Build result lines
    const lines: string[] = [];
    lines.push(bold(`Query: `) + cyn(`"${query}"`) + dim(`  ${elapsed}ms  top-${topK}  expand=${expand}`));
    lines.push('');

    if (hypotheses?.length) {
      lines.push(bold('CLaRa hypotheses:'));
      hypotheses.forEach((h, i) => lines.push(dim(`  ${i + 1}. `) + h));
      lines.push('');
    }

    if (keywordPhrases?.length) {
      lines.push(bold('Keyword phrases:'));
      keywordPhrases.forEach((k, i) => lines.push(dim(`  ${i + 1}. `) + cyn(k)));
      lines.push('');
    }

    if (hits.length === 0) {
      lines.push(yel('No results found. Have you indexed any timelines?'));
    } else {
      for (const hit of hits) {
        const score = hit.score >= 0.7 ? grn(hit.score.toFixed(4))
                    : hit.score >= 0.5 ? yel(hit.score.toFixed(4))
                    : red(hit.score.toFixed(4));
        lines.push(bold(`[${hit.rank}]`) + ` score=${score}  abs: ${cyn(fmt(hit.absoluteStart))} – ${fmt(hit.absoluteEnd)}  chunk-in-clip: ${fmt(hit.chunkStartMs / 1000)}`);
        lines.push(`    ${dim('clip:')} ${hit.clipId}`);
        lines.push(`    ${dim('file:')} ${hit.filePath}`);
        lines.push(`    ${dim('text:')} ${hit.chunkText.slice(0, COLS() - 12)}`);
        if (hit.chunkText.length > COLS() - 12) {
          const rest = hit.chunkText.slice(COLS() - 12);
          // show up to 3 continuation lines
          for (let i = 0; i < rest.length && i < (COLS() - 12) * 3; i += COLS() - 16) {
            lines.push('          ' + rest.slice(i, i + COLS() - 16));
          }
        }
        lines.push('');
      }
    }

    await pager(`Search Results — "${query}"`, lines);
  }
}

// ── 2. PROJECTS ───────────────────────────────────────────────────────────────

async function screenProjects(): Promise<void> {
  while (true) {
    spinStart('Loading collection…');
    let rows: ChunkRow[];
    try { rows = await fetchAll(); } catch (e: any) {
      spinStop();
      await pager('Error', [red(e.message)]);
      return;
    }
    spinStop();

    const projectMap = groupByProject(rows);

    if (projectMap.size === 0) {
      await pager('Projects', [dim('No projects indexed yet. Run: npm run index <timeline.json>')]);
      return;
    }

    const projectIds = [...projectMap.keys()].sort();
    const items: MenuItem[] = projectIds.map(pid => {
      const clips = projectMap.get(pid)!;
      const totalChunks = [...clips.values()].reduce((s, a) => s + a.length, 0);
      return { label: pid, sub: `${clips.size} clips  ${totalChunks} chunks` };
    });

    const idx = await menu('Projects', items, { hint: 'Enter to inspect clips' });
    if (idx < 0) return;

    await screenProjectDetail(projectIds[idx], projectMap.get(projectIds[idx])!);
  }
}

async function screenProjectDetail(
  projectId: string,
  clipMap: Map<string, ChunkRow[]>,
): Promise<void> {
  while (true) {
    const clipIds = [...clipMap.keys()].sort();
    const items: MenuItem[] = clipIds.map(cid => {
      const chunks = clipMap.get(cid)!;
      const sorted = [...chunks].sort((a, b) => a.absoluteStart - b.absoluteStart);
      const tStart = fmt(sorted[0]?.absoluteStart ?? 0);
      const tEnd   = fmt(sorted[sorted.length - 1]?.absoluteEnd ?? 0);
      return {
        label: cid,
        sub: `${chunks.length} chunks  ${tStart}–${tEnd}  ${dim(chunks[0]?.filePath?.split('/').pop() ?? '')}`,
      };
    });

    const idx = await menu(
      `Project: ${projectId}`,
      [
        { label: '🗑  Delete ALL embeddings + snapshot for this project', sub: `${[...clipMap.values()].reduce((s,a)=>s+a.length,0)} chunks` },
        { label: '─── Clips ───────────────────────────────', sub: '' },
        ...items,
      ],
    );
    if (idx < 0) return;
    if (idx === 0) {
      const totalChunks = [...clipMap.values()].reduce((s,a)=>s+a.length,0);
      const ok = await confirm(
        `Delete ALL embeddings for project "${projectId}"?\n` +
        `  • Removes ${totalChunks} chunks from ChromaDB\n` +
        `  • Removes the delta snapshot from SQLite (via server API)\n` +
        `  • Next index of this project will be treated as a fresh import`,
      );
      if (ok) {
        spinStart('Deleting…');
        try {
          // 1. Delete from ChromaDB
          await chroma.deleteByProjectId(projectId);

          // 2. Delete snapshot from SQLite via server API (best-effort)
          const apiResult = await apiDelete(`/index/${encodeURIComponent(projectId)}`);
          spinStop();

          const note = apiResult.ok
            ? grn('✓ Snapshot cleared from SQLite via server.')
            : yel(`⚠ ChromaDB cleared, but server snapshot delete failed: ${apiResult.error ?? ''}\n  (Run: DELETE /index/${projectId} manually, or restart server)`) ;
          await pager('Deleted', [
            grn(`✓ All embeddings for project "${projectId}" deleted from ChromaDB.`),
            note,
          ]);
          return; // go back to project list to refresh
        } catch (e: any) {
          spinStop();
          await pager('Error', [red(e.message)]);
        }
      }
      continue;
    }
    if (idx === 1) continue; // separator
    await screenClipDetail(projectId, clipIds[idx - 2], clipMap.get(clipIds[idx - 2])!);
  }
}

async function screenClipDetail(
  projectId: string,
  clipId: string,
  chunks: ChunkRow[],
): Promise<void> {
  while (true) {
    const sorted = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);

    const idx = await menu(
      `Clip: ${clipId}`,
      [
        { label: '📋  View all chunks & embeddings', sub: `${chunks.length} chunks` },
        { label: '🗑  Delete all embeddings for this clip', sub: `${chunks.length} chunks` },
        { label: '─── Chunks ──────────────────────────────', sub: '' },
        ...sorted.map(c => ({
          label: `chunk ${String(c.chunkIndex).padStart(3)}  ${fmtMs(c.chunkStartMs)}–${fmtMs(c.chunkEndMs)}`,
          sub: c.document.slice(0, 60).replace(/\n/g, ' '),
        })),
      ],
    );
    if (idx < 0) return;

    if (idx === 0) {
      // View all chunks
      const lines: string[] = [
        bold(`Clip: ${clipId}`) + dim(`  project: ${projectId}`),
        dim(`File: ${sorted[0]?.filePath ?? ''}`),
        dim(`Timeline: ${fmt(sorted[0]?.timelineStart ?? 0)} – ${fmt(sorted[sorted.length - 1]?.timelineEnd ?? 0)}`),
        '',
        bold('Chunks:'),
        '',
      ];
      for (const c of sorted) {
        lines.push(
          cyn(`  #${String(c.chunkIndex).padStart(3)}`) +
          `  clip-rel: ${fmtMs(c.chunkStartMs)}–${fmtMs(c.chunkEndMs)}` +
          `  abs: ${fmt(c.absoluteStart)}–${fmt(c.absoluteEnd)}` +
          `  id: ${dim(c.id)}`
        );
        // wrap text to terminal width
        const words = c.document.split(' ');
        let line = '        ';
        for (const w of words) {
          if (line.length + w.length + 1 > COLS() - 4) {
            lines.push(dim(line));
            line = '        ' + w;
          } else {
            line += (line.length > 8 ? ' ' : '') + w;
          }
        }
        if (line.trim()) lines.push(dim(line));
        lines.push('');
      }
      await pager(`Chunks — ${clipId}`, lines);
      continue;
    }

    if (idx === 1) {
      // Delete clip embeddings
      const ok = await confirm(`Delete all ${chunks.length} embeddings for clip "${clipId}"?`);
      if (ok) {
        spinStart('Deleting…');
        try {
          await chroma.deleteByClipId(clipId);
          spinStop();
          await pager('Deleted', [grn(`✓ All embeddings for clip "${clipId}" deleted.`)]);
          return;
        } catch (e: any) {
          spinStop();
          await pager('Error', [red(e.message)]);
        }
      }
      continue;
    }

    if (idx === 2) continue; // separator

    // View individual chunk
    const chunk = sorted[idx - 3];
    if (chunk) {
      const lines = [
        bold(`Chunk #${chunk.chunkIndex}`) + `  — ${clipId}`,
        '',
        `${dim('ID:')}           ${chunk.id}`,
        `${dim('Clip-relative:')} ${fmtMs(chunk.chunkStartMs)} – ${fmtMs(chunk.chunkEndMs)}`,
        `${dim('Absolute:')}     ${fmt(chunk.absoluteStart)} – ${fmt(chunk.absoluteEnd)}`,
        `${dim('Timeline clip:')} ${fmt(chunk.timelineStart)} – ${fmt(chunk.timelineEnd)}`,
        `${dim('File:')}         ${chunk.filePath}`,
        '',
        bold('Text:'),
        '',
        ...chunk.document.split('\n').flatMap(l => {
          const chunks2: string[] = [];
          for (let i = 0; i < l.length || chunks2.length === 0; i += COLS() - 4) {
            chunks2.push('  ' + l.slice(i, i + COLS() - 4));
          }
          return chunks2;
        }),
      ];
      await pager(`Chunk #${chunk.chunkIndex} — ${clipId}`, lines);
    }
  }
}

// ── 3. EMBEDDINGS ─────────────────────────────────────────────────────────────

async function screenEmbeddings(): Promise<void> {
  while (true) {
    const choice = await menu('Embeddings', [
      { label: '📊  Browse all embeddings by clip', sub: 'grouped list' },
      { label: '🔢  Collection statistics', sub: 'counts, metadata keys' },
      { label: '🗑  Delete embeddings for a clip (enter clip ID)', sub: '' },
      { label: '🗑  Delete embeddings for a project (enter project ID)', sub: '' },
      { label: '💥  Delete ALL embeddings', sub: 'drops entire collection' },
    ]);
    if (choice < 0) return;

    if (choice === 0) {
      spinStart('Loading…');
      let rows: ChunkRow[];
      try { rows = await fetchAll(); } catch (e: any) {
        spinStop(); await pager('Error', [red(e.message)]); continue;
      }
      spinStop();

      const projectMap = groupByProject(rows);
      const lines: string[] = [
        bold(`Total: ${rows.length} chunks  ${projectMap.size} projects`),
        '',
      ];
      for (const [pid, clips] of [...projectMap.entries()].sort()) {
        lines.push(bold(cyn(pid)));
        for (const [cid, cchunks] of [...clips.entries()].sort()) {
          const sorted = [...cchunks].sort((a, b) => a.absoluteStart - b.absoluteStart);
          const tStart = fmt(sorted[0]?.absoluteStart ?? 0);
          const tEnd   = fmt(sorted[sorted.length - 1]?.absoluteEnd ?? 0);
          lines.push(
            `  ${pad(cid, 35)}  ${String(cchunks.length).padStart(3)} chunks  ${tStart}–${tEnd}`
          );
          lines.push(`  ${dim(sorted[0]?.filePath ?? '')}`);
        }
        lines.push('');
      }
      await pager('Embeddings by Clip', lines);
      continue;
    }

    if (choice === 1) {
      spinStart('Loading stats…');
      let rows: ChunkRow[];
      try { rows = await fetchAll(); } catch (e: any) {
        spinStop(); await pager('Error', [red(e.message)]); continue;
      }
      spinStop();

      const projectMap = groupByProject(rows);
      const projectIds = [...projectMap.keys()];
      const allClipIds = new Set(rows.map(r => r.clipId));

      // Chunk size stats
      const lengths = rows.map(r => r.document.split(' ').length);
      const avgLen = lengths.length ? lengths.reduce((s, n) => s + n, 0) / lengths.length : 0;
      const minLen = lengths.length ? Math.min(...lengths) : 0;
      const maxLen = lengths.length ? Math.max(...lengths) : 0;

      const lines = [
        bold('Collection: premiere_clips'),
        '',
        `${dim('Total chunks:')}     ${grn(String(rows.length))}`,
        `${dim('Projects:')}         ${projectIds.length}`,
        `${dim('Clips:')}            ${allClipIds.size}`,
        '',
        bold('Chunk text stats (word count):'),
        `  avg ${avgLen.toFixed(0)}  min ${minLen}  max ${maxLen}`,
        '',
        bold('Per-project breakdown:'),
        '',
        ...projectIds.sort().flatMap(pid => {
          const clips = projectMap.get(pid)!;
          const total = [...clips.values()].reduce((s, a) => s + a.length, 0);
          return [
            `  ${cyn(pid)}`,
            `    ${clips.size} clips  ${total} chunks`,
            ...([...clips.entries()].sort().map(([cid, cchunks]) =>
              `    ${dim('  ' + cid)}  ${cchunks.length} chunks`
            )),
            '',
          ];
        }),
      ];
      await pager('Collection Statistics', lines);
      continue;
    }

    if (choice === 2) {
      const clipId = await textInput('Enter clip ID to delete (e.g. clip_bench_ch08)');
      if (!clipId) continue;
      const ok = await confirm(`Delete all embeddings where clipId = "${clipId}"?`);
      if (!ok) continue;
      spinStart('Deleting…');
      try {
        await chroma.deleteByClipId(clipId);
        spinStop();
        await pager('Done', [grn(`✓ Deleted embeddings for clip "${clipId}".`)]);
      } catch (e: any) { spinStop(); await pager('Error', [red(e.message)]); }
      continue;
    }

    if (choice === 3) {
      const projectId = await textInput('Enter project ID to delete');
      if (!projectId) continue;
      const ok = await confirm(`Delete all embeddings where projectId = "${projectId}"?`);
      if (!ok) continue;
      spinStart('Deleting…');
      try {
        await chroma.deleteByProjectId(projectId);
        spinStop();
        await pager('Done', [grn(`✓ Deleted embeddings for project "${projectId}".`)]);
      } catch (e: any) { spinStop(); await pager('Error', [red(e.message)]); }
      continue;
    }

    if (choice === 4) {
      const ok = await confirm('Delete ALL embeddings?\nThis will drop the entire "premiere_clips" collection from ChromaDB.\nYou will need to re-index all timelines.');
      if (!ok) continue;
      spinStart('Deleting…');
      try {
        const client = (chroma as any).client;
        await client.deleteCollection({ name: 'premiere_clips' });
        // Reset cached collection handle
        (chroma as any).collection = null;
        spinStop();
        await pager('Done', [grn('✓ Collection "premiere_clips" dropped. ChromaDB is empty.')]);
      } catch (e: any) { spinStop(); await pager('Error', [red(e.message)]); }
      continue;
    }
  }
}

// ── 4. QUEUE ──────────────────────────────────────────────────────────────────

interface ProgressResponse {
  activeJobs: number;
  jobs: JobProgress[];
}

interface JobsResponse {
  total: number;
  jobs: Array<{
    jobId: string;
    projectId: string;
    projectName: string;
    state: string;
    totalClips: number;
    completedClips: number;
    totalChunks: number;
    embeddedChunks: number;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
  }>;
}

const STAGE_ICON: Record<string, string> = {
  pending: '·', transcribing: '◎', chunking: '◐',
  embedding: '◑', storing: '◒', done: '✓', error: '✗',
};
const STAGE_COLOR: Record<string, string> = {
  pending: DIM, transcribing: CYN, chunking: CYN,
  embedding: YLW, storing: YLW, done: GRN, error: RED,
};
const STATE_COLOR: Record<string, string> = {
  running: CYN, done: GRN, error: RED, interrupted: YLW,
};

function stageIcon(stage: string): string {
  const icon = STAGE_ICON[stage] ?? '?';
  const c = STAGE_COLOR[stage] ?? '';
  return `${c}${icon}${RST}`;
}

function stateLabel(state: string): string {
  const c = STATE_COLOR[state] ?? '';
  return `${c}${state}${RST}`;
}

async function screenQueue(): Promise<void> {
  while (true) {
    const choice = await menu('Queue', [
      { label: '▶  Live jobs', sub: 'currently running (polls server)' },
      { label: '📋  Job history', sub: 'all jobs from SQLite (last 100)' },
      { label: '⚠  Interrupted jobs', sub: 'jobs killed mid-run' },
      { label: '🗑  Clean project', sub: 'wipe embeddings + snapshot to re-test' },
    ], { hint: `Server: ${SERVER_URL}` });
    if (choice < 0) return;

    if (choice === 0) await screenQueueLive();
    if (choice === 1) await screenJobHistory();
    if (choice === 2) await screenInterrupted();
    if (choice === 3) await screenQueueCleanProject();
  }
}

async function screenQueueCleanProject(): Promise<void> {
  // Load known projects from job history so we can offer a pick-list
  spinStart('Loading projects…');
  const result = await apiGet<JobsResponse>('/status/jobs');
  spinStop();

  if (!result.ok) {
    await pager('Clean Project — Error', [
      red(`Cannot reach server: ${result.error}`),
      dim(`  SERVER_URL = ${SERVER_URL}`),
    ]);
    return;
  }

  // Deduplicate by projectId, keep most recent job per project
  const seen = new Map<string, { projectId: string; projectName: string }>();
  for (const j of result.data.jobs) {
    if (!seen.has(j.projectId)) seen.set(j.projectId, { projectId: j.projectId, projectName: j.projectName });
  }

  // Also offer manual entry in case the project was never indexed via this server
  const knownProjects = [...seen.values()];
  const items: MenuItem[] = [
    ...knownProjects.map((p) => ({ label: p.projectName, sub: p.projectId })),
    { label: '✏  Enter project ID manually', sub: '' },
  ];

  const idx = await menu('Clean Project — Select project', items, {
    hint: 'Removes all embeddings from ChromaDB + clears SQLite snapshot',
  });
  if (idx < 0) return;

  let projectId: string;
  let projectName: string;

  if (idx === knownProjects.length) {
    // Manual entry
    const entered = await textInput('Enter project ID');
    if (!entered) return;
    projectId = entered;
    projectName = entered;
  } else {
    projectId = knownProjects[idx].projectId;
    projectName = knownProjects[idx].projectName;
  }

  const ok = await confirm(
    `Clean project "${projectName}"?\n` +
    `  • Delete ALL embeddings from ChromaDB\n` +
    `  • Clear the delta snapshot from SQLite (via server API)\n` +
    `  • Next index of this project will be treated as a fresh import`,
  );
  if (!ok) return;

  spinStart('Cleaning…');
  try {
    await chroma.deleteByProjectId(projectId);
    const apiResult = await apiDelete(`/index/${encodeURIComponent(projectId)}`);
    spinStop();

    const note = apiResult.ok
      ? grn('✓ Snapshot cleared from SQLite via server.')
      : yel(`⚠ ChromaDB cleared, but server snapshot delete failed: ${apiResult.error ?? ''}\n  (Run: DELETE /index/${projectId} manually)`);
    await pager('Cleaned', [
      grn(`✓ All embeddings for project "${projectName}" deleted from ChromaDB.`),
      note,
    ]);
  } catch (e: any) {
    spinStop();
    await pager('Error', [red(e.message ?? String(e))]);
  }
}

async function screenQueueLive(): Promise<void> {
  // Fetch live progress; offer to drill into a job
  spinStart('Loading live jobs…');
  const result = await apiGet<ProgressResponse>('/status/progress');
  spinStop();

  if (!result.ok) {
    await pager('Live Jobs — Error', [
      red(`Cannot reach server: ${result.error}`),
      dim(`  SERVER_URL = ${SERVER_URL}`),
      dim('  Is the server running?  npm run start'),
    ]);
    return;
  }

  const data = result.data;

  if (data.jobs.length === 0) {
    await pager('Live Jobs', [dim('No jobs in memory. Submit a timeline: npm run index <file.json>')]);
    return;
  }

  const items: MenuItem[] = data.jobs.map((j) => {
    const pct = j.totalClips > 0
      ? `${Math.round((j.completedClips / j.totalClips) * 100)}%`
      : '0%';
    return {
      label: `${j.projectName}`,
      sub: `${stateLabel(j.state)}  ${j.completedClips}/${j.totalClips} clips  ${pct}  [${j.jobId.slice(0,8)}]`,
    };
  });

  const idx = await menu('Live Jobs', items, { hint: 'Enter to view clip detail' });
  if (idx < 0) return;

  await screenJobDetail(data.jobs[idx]);
}

async function screenJobDetail(job: JobProgress): Promise<void> {
  const clips = job.clips ?? [];
  const stageCounts: Record<string, number> = {};
  for (const c of clips) {
    stageCounts[c.stage] = (stageCounts[c.stage] ?? 0) + 1;
  }

  const elapsedMs = job.durationMs ?? (Date.now() - new Date(job.startedAt).getTime());

  const lines: string[] = [
    bold(`Job: ${job.jobId}`),
    '',
    `  ${dim('Project:')}   ${job.projectName}`,
    `  ${dim('Project ID:')} ${job.projectId}`,
    `  ${dim('State:')}     ${stateLabel(job.state)}`,
    `  ${dim('Clips:')}     ${job.completedClips} / ${job.totalClips}`,
    `  ${dim('Chunks:')}    ${job.embeddedChunks} / ${job.totalChunks}`,
    `  ${dim('Started:')}   ${job.startedAt}`,
    `  ${dim('Elapsed:')}   ${fmtElapsed(elapsedMs)}`,
    '',
    bold('Stage summary:'),
    '  ' + Object.entries(stageCounts)
      .map(([s, n]) => `${stageIcon(s)} ${s} ×${n}`)
      .join('   '),
    '',
    bold('Clips:'),
    '',
    ...clips.map((c) => {
      const icon = stageIcon(c.stage);
      const name = pad(c.name, 32);
      const chunks = c.totalChunks > 0 ? `  ${c.embeddedChunks}/${c.totalChunks}ch` : '';
      const err = c.error ? `  ${red('! ' + c.error.slice(0, 40))}` : '';
      return `  ${icon} ${name}  ${c.stage.padEnd(12)}${chunks}${err}`;
    }),
  ];

  await pager(`Job Detail — ${job.projectName}`, lines);
}

async function screenJobHistory(): Promise<void> {
  spinStart('Loading job history…');
  const result = await apiGet<JobsResponse>('/status/jobs');
  spinStop();

  if (!result.ok) {
    await pager('Job History — Error', [
      red(`Cannot reach server: ${result.error}`),
      dim(`  SERVER_URL = ${SERVER_URL}`),
    ]);
    return;
  }

  const jobs = result.data.jobs;

  if (jobs.length === 0) {
    await pager('Job History', [dim('No jobs in SQLite yet.')]);
    return;
  }

  const items: MenuItem[] = jobs.map((j) => {
    const pct = j.totalClips > 0
      ? `${Math.round((j.completedClips / j.totalClips) * 100)}%`
      : '0%';
    const dur = j.durationMs ? fmtElapsed(j.durationMs) : '…';
    return {
      label: j.projectName,
      sub: `${stateLabel(j.state)}  ${j.completedClips}/${j.totalClips} clips  ${pct}  ${dur}  [${j.jobId.slice(0,8)}]`,
    };
  });

  const idx = await menu(`Job History (${jobs.length})`, items);
  if (idx < 0) return;

  const j = jobs[idx];
  const dur = j.durationMs ? fmtElapsed(j.durationMs) : 'in progress';
  const lines = [
    bold(`Job: ${j.jobId}`),
    '',
    `  ${dim('Project:')}    ${j.projectName}`,
    `  ${dim('Project ID:')} ${j.projectId}`,
    `  ${dim('State:')}      ${stateLabel(j.state)}`,
    `  ${dim('Clips:')}      ${j.completedClips} / ${j.totalClips}`,
    `  ${dim('Chunks:')}     ${j.embeddedChunks} / ${j.totalChunks}`,
    `  ${dim('Started:')}    ${j.startedAt}`,
    `  ${dim('Completed:')}  ${j.completedAt ?? '—'}`,
    `  ${dim('Duration:')}   ${dur}`,
    '',
    dim('(Clip-level detail only available for live jobs via Queue → Live Jobs)'),
  ];
  await pager(`Job — ${j.projectName}`, lines);
}

async function screenInterrupted(): Promise<void> {
  spinStart('Loading interrupted jobs…');
  const result = await apiGet<{ total: number; jobs: JobsResponse['jobs'] }>('/status/interrupted');
  spinStop();

  if (!result.ok) {
    await pager('Interrupted Jobs — Error', [red(`Cannot reach server: ${result.error}`)]);
    return;
  }

  const { total, jobs } = result.data;

  if (total === 0) {
    await pager('Interrupted Jobs', [grn('✓ No interrupted jobs.')]);
    return;
  }

  const lines = [
    bold(`${total} interrupted job(s) — these were running when the server was killed`),
    '',
    dim('To re-index, resubmit the original timeline JSON: npm run index <file.json>'),
    dim('Delta detection will pick up only clips that did not fully complete.'),
    '',
    ...jobs.flatMap((j) => [
      `  ${yel('⚠')} ${bold(j.projectName)}  [${j.jobId.slice(0,8)}]`,
      `     ${dim('clips:')} ${j.completedClips}/${j.totalClips}   ${dim('started:')} ${j.startedAt}`,
      '',
    ]),
  ];

  await pager(`Interrupted Jobs (${total})`, lines);
}

// ── 5. DB ADMIN ───────────────────────────────────────────────────────────────

async function screenDbAdmin(): Promise<void> {
  while (true) {
    const choice = await menu('DB Admin', [
      { label: '💚  Health check', sub: 'ChromaDB + Ollama + Server ping' },
      { label: '📋  Collection info', sub: 'metadata & config' },
      { label: '🔄  Reset all data', sub: 'drop ChromaDB + wipe SQLite snapshots + job history' },
      { label: '⚙   Config', sub: 'show loaded environment config' },
    ]);
    if (choice < 0) return;

    if (choice === 0) {
      spinStart('Checking services…');
      const chromaOk = await chroma.ping();
      let ollamaOk = false;
      let serverOk = false;
      try {
        const r = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
        ollamaOk = r.ok;
      } catch { ollamaOk = false; }
      try {
        const r = await fetch(`${SERVER_URL}/status`, { signal: AbortSignal.timeout(3000) });
        serverOk = r.ok;
      } catch { serverOk = false; }
      spinStop();

      const lines = [
        bold('Service Health'),
        '',
        `  ChromaDB   ${config.chromaUrl}   ${chromaOk ? grn('✓ OK') : red('✗ DOWN')}`,
        `  Ollama     ${config.ollamaUrl}   ${ollamaOk ? grn('✓ OK') : red('✗ DOWN')}`,
        `  API Server ${SERVER_URL}   ${serverOk ? grn('✓ OK') : red('✗ DOWN')}`,
        '',
        bold('Models:'),
        `  embed model:  ${config.ollamaEmbedModel}`,
        `  llm model:    ${config.ollamaLlmModel}`,
        '',
        bold('Whisper:'),
        `  binary: ${config.whisperBin}`,
        `  model:  ${config.whisperModel}`,
        `  threads: ${config.whisperThreads}`,
        `  concurrency: ${config.whisperConcurrency}`,
      ];
      await pager('Health Check', lines);
      continue;
    }

    if (choice === 1) {
      spinStart('Loading collection info…');
      let info = '';
      let count = 0;
      try {
        const col = await chroma.getCollection();
        count = await col.count();
        info = JSON.stringify((col as any).metadata ?? {}, null, 2);
      } catch (e: any) {
        spinStop(); await pager('Error', [red(e.message)]); continue;
      }
      spinStop();

      const lines = [
        bold('Collection: premiere_clips'),
        '',
        `  Total documents: ${grn(String(count))}`,
        '',
        bold('Metadata:'),
        ...info.split('\n').map(l => '  ' + l),
      ];
      await pager('Collection Info', lines);
      continue;
    }

    if (choice === 2) {
      const ok = await confirm(
        'Reset ALL data?\n' +
        '  • Drop + re-create the "premiere_clips" ChromaDB collection\n' +
        '  • Wipe ALL project snapshots from SQLite\n' +
        '  • Wipe ALL job history from SQLite\n' +
        '  • Clear live job tracker\n' +
        '  Every project will be treated as a fresh import on next index.',
      );
      if (!ok) continue;
      spinStart('Resetting all data…');
      try {
        const result = await apiPost<{
          ok: boolean; chromaReset: boolean;
          snapshotsDeleted: number; jobsDeleted: number; liveJobsCleared: number;
          error?: string;
        }>('/admin/reset-all');
        spinStop();
        if (!result.ok || !result.data.ok) {
          await pager('Error', [red(`Reset failed: ${result.data.error ?? 'unknown error'}`)]);
        } else {
          await pager('Reset Complete', [
            grn('✓ All data reset.'),
            '',
            `  ${dim('ChromaDB collection:')}  dropped + re-created`,
            `  ${dim('Snapshots deleted:')}    ${result.data.snapshotsDeleted}`,
            `  ${dim('Job rows deleted:')}     ${result.data.jobsDeleted}`,
            `  ${dim('Live jobs cleared:')}    ${result.data.liveJobsCleared}`,
          ]);
        }
      } catch (e: any) {
        spinStop();
        await pager('Error', [red(e.message ?? String(e))]);
      }
      continue;
    }

    if (choice === 3) {
      const lines = [
        bold('Loaded Configuration'),
        '',
        `  ${dim('WHISPER_BIN')}            ${config.whisperBin}`,
        `  ${dim('WHISPER_MODEL')}          ${config.whisperModel}`,
        `  ${dim('WHISPER_THREADS')}        ${config.whisperThreads}`,
        `  ${dim('WHISPER_CONCURRENCY')}    ${config.whisperConcurrency}`,
        `  ${dim('OLLAMA_URL')}             ${config.ollamaUrl}`,
        `  ${dim('OLLAMA_EMBED_MODEL')}     ${config.ollamaEmbedModel}`,
        `  ${dim('OLLAMA_LLM_MODEL')}       ${config.ollamaLlmModel}`,
        `  ${dim('CHROMA_URL')}             ${config.chromaUrl}`,
        `  ${dim('PORT')}                   ${config.port}`,
        `  ${dim('SERVER_URL')}             ${SERVER_URL}`,
        `  ${dim('TIMELINE_WATCH_GLOB')}    ${config.timelineWatchGlob}`,
        `  ${dim('CLARA_N_HYPOTHESES')}     ${config.claraNHypotheses}`,
      ];
      await pager('Config', lines);
      continue;
    }
  }
}

// ── MAIN MENU ─────────────────────────────────────────────────────────────────

teardown = setupRaw();

process.on('exit', () => { teardown(); });
process.on('SIGINT', () => { teardown(); process.exit(0); });

while (true) {
  const choice = await menu(
    `${bold('Premiere Semantic Search')} — TUI`,
    [
      { label: '🔍  Search',     sub: 'run semantic queries against indexed clips' },
      { label: '📁  Projects',   sub: 'inspect premiere projects & clips' },
      { label: '🗄  Embeddings', sub: 'browse, delete, manage ChromaDB vectors' },
      { label: '⏳  Queue',      sub: 'live jobs, history, interrupted — via server API' },
      { label: '🛠  DB Admin',   sub: 'health, collection info, reset' },
      { label: '🚪  Exit',       sub: '' },
    ],
    { hint: 'Welcome — select a section to get started' },
  );

  if (choice < 0 || choice === 5) break;
  if (choice === 0) await screenSearch();
  if (choice === 1) await screenProjects();
  if (choice === 2) await screenEmbeddings();
  if (choice === 3) await screenQueue();
  if (choice === 4) await screenDbAdmin();
}

write(CLR);
writeln('Bye.');
teardown();
process.exit(0);
