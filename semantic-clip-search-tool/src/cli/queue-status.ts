#!/usr/bin/env tsx
/**
 * queue-status — live TUI for IndexQueue state
 *
 * Polls GET /status/progress every 500 ms and renders:
 *   - All active jobs with per-clip stage/progress bars
 *   - Recent completed/error jobs (last 5, collapsed)
 *   - Pipeline stage summary counts across all active jobs
 *
 * Press q or Ctrl+C to exit.
 */
import { loadConfig } from '../config/config.js';
import type { JobProgress, ClipProgress } from '../types/index.js';

// ── Config ────────────────────────────────────────────────────────────────────

const config = loadConfig();
const SERVER_URL = config.serverUrl;
const POLL_MS = 500;

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
};

const STAGE_COLOR: Record<string, string> = {
  pending:      C.gray,
  transcribing: C.cyan,
  chunking:     C.blue,
  embedding:    C.magenta,
  storing:      C.yellow,
  done:         C.green,
  error:        C.red,
};

const STAGE_ICON: Record<string, string> = {
  pending:      '·',
  transcribing: '◎',
  chunking:     '◐',
  embedding:    '◑',
  storing:      '◒',
  done:         '✓',
  error:        '✗',
};

function col(text: string, color: string): string {
  return `${color}${text}${C.reset}`;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

const COLS = () => process.stdout.columns || 100;

function bar(done: number, total: number, width: number): string {
  if (total === 0) return col(' '.repeat(width + 2), C.dim);
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return col('[', C.gray) +
    col('█'.repeat(filled), C.green) +
    col('░'.repeat(empty), C.dim) +
    col(']', C.gray);
}

function pct(done: number, total: number): string {
  if (total === 0) return '  -';
  return String(Math.round((done / total) * 100)).padStart(3) + '%';
}

function elapsed(startedAt: string, durationMs?: number): string {
  const ms = durationMs ?? (Date.now() - new Date(startedAt).getTime());
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ── Spinner ───────────────────────────────────────────────────────────────────

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinIdx = 0;
function spin(): string {
  return col(SPIN[spinIdx % SPIN.length], C.cyan);
}

// ── Render ────────────────────────────────────────────────────────────────────

interface ProgressResponse {
  activeJobs: number;
  jobs: JobProgress[];
}

let prevLines = 0;

function clearPrev(): void {
  if (prevLines > 0) {
    process.stdout.write(`\x1b[${prevLines}A\x1b[0J`);
  }
}

function renderIdle(serverUrl: string): void {
  clearPrev();
  const lines: string[] = [
    `${spin()} ${col('Queue idle', C.dim)}  ${col(serverUrl, C.gray)}`,
    col('  No active jobs. Press q to exit.', C.dim),
  ];
  writeLines(lines);
}

function renderError(msg: string): void {
  clearPrev();
  const lines: string[] = [
    `${spin()} ${col('Connecting...', C.dim)}`,
    `  ${col(msg, C.red)}`,
  ];
  writeLines(lines);
}

function renderJobs(data: ProgressResponse): void {
  clearPrev();
  const cols = COLS();
  const BAR_W = Math.max(10, Math.min(24, cols - 60));
  const lines: string[] = [];

  // ── Header bar ─────────────────────────────────────────────────────────────
  const activeLabel = data.activeJobs > 0
    ? col(`${data.activeJobs} running`, C.green + C.bold)
    : col('idle', C.dim);

  lines.push(
    `${spin()} ${col('IndexQueue', C.bold + C.cyan)}  ${activeLabel}  ` +
    col(SERVER_URL, C.gray),
  );
  lines.push('');

  // ── Stage summary across all active jobs ───────────────────────────────────
  const activeJobs = data.jobs.filter((j) => j.state === 'running');
  if (activeJobs.length > 0) {
    const counts: Record<string, number> = {
      pending: 0, transcribing: 0, chunking: 0,
      embedding: 0, storing: 0, done: 0, error: 0,
    };
    for (const job of activeJobs) {
      for (const clip of job.clips ?? []) {
        counts[clip.stage] = (counts[clip.stage] ?? 0) + 1;
      }
    }
    const stageStr = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([stage, n]) => {
        const icon = STAGE_ICON[stage] ?? '?';
        const c = STAGE_COLOR[stage] ?? C.white;
        return `${col(icon, c)} ${col(stage, c)} ×${n}`;
      })
      .join('   ');
    lines.push(`  ${col('Stages:', C.bold)}  ${stageStr}`);
    lines.push('');
  }

  // ── Active jobs ────────────────────────────────────────────────────────────
  for (const job of activeJobs) {
    const clips = job.clips ?? [];
    const barW = BAR_W;
    const jobElapsed = elapsed(job.startedAt, job.durationMs);

    lines.push(
      col('  ┌─ ', C.gray) +
      col(job.projectName, C.bold) +
      col(` [${job.jobId.slice(0, 8)}]`, C.gray) +
      `  clips ${job.completedClips}/${job.totalClips} ` +
      bar(job.completedClips, job.totalClips, barW) +
      ` ${pct(job.completedClips, job.totalClips)}` +
      col(`  ${jobElapsed}`, C.dim),
    );

    if (job.totalChunks > 0) {
      lines.push(
        col('  │   ', C.gray) +
        col('chunks ', C.dim) +
        `${job.embeddedChunks}/${job.totalChunks} ` +
        bar(job.embeddedChunks, job.totalChunks, barW) +
        ` ${pct(job.embeddedChunks, job.totalChunks)}`,
      );
    }

    lines.push(col('  │', C.gray));

    // Per-clip rows
    for (const clip of clips) {
      const icon = STAGE_ICON[clip.stage] ?? '?';
      const c = STAGE_COLOR[clip.stage] ?? C.white;
      const nameW = Math.max(20, Math.min(32, cols - 70));
      const name = clip.name.slice(0, nameW).padEnd(nameW);
      const stageLabel = col(`${icon} ${clip.stage.padEnd(12)}`, c);

      let clipBar: string;
      if (clip.stage === 'embedding' && clip.totalChunks > 0) {
        clipBar = bar(clip.embeddedChunks, clip.totalChunks, barW);
      } else if (clip.stage === 'done') {
        clipBar = bar(1, 1, barW);
      } else if (clip.stage === 'error') {
        clipBar = col('[' + '!'.repeat(barW) + ']', C.red);
      } else {
        clipBar = col('[' + ' '.repeat(barW) + ']', C.dim);
      }

      const chunkInfo = clip.totalChunks > 0
        ? col(` ${clip.embeddedChunks}/${clip.totalChunks}ch`, C.dim)
        : '';

      const errSuffix = clip.error
        ? col(`  ! ${clip.error.slice(0, 28)}`, C.red)
        : '';

      lines.push(
        col('  │  ', C.gray) +
        col(name, clip.stage === 'done' ? C.dim : C.white) +
        `  ${stageLabel}  ${clipBar}${chunkInfo}${errSuffix}`,
      );
    }

    lines.push(col('  └', C.gray));
    lines.push('');
  }

  // ── Recent completed/errored jobs (last 5, collapsed) ─────────────────────
  const recentDone = data.jobs
    .filter((j) => j.state !== 'running')
    .slice(0, 5);

  if (recentDone.length > 0) {
    lines.push(col('  Recent:', C.dim));
    for (const job of recentDone) {
      const stateIcon = job.state === 'done' ? col('✓', C.green)
        : job.state === 'error' ? col('✗', C.red)
        : col('~', C.yellow);
      const clips = job.clips ?? [];
      const failedCount = clips.filter((c: ClipProgress) => c.stage === 'error').length;
      const failNote = failedCount > 0 ? col(` (${failedCount} failed)`, C.red) : '';
      lines.push(
        `    ${stateIcon} ` +
        col(job.projectName, C.dim) +
        col(` [${job.jobId.slice(0, 8)}]`, C.gray) +
        col(`  ${job.completedClips}/${job.totalClips} clips`, C.dim) +
        failNote +
        col(`  ${elapsed(job.startedAt, job.durationMs)}`, C.gray),
      );
    }
    lines.push('');
  }

  lines.push(col('  q to exit', C.gray));

  writeLines(lines);
}

function writeLines(lines: string[]): void {
  const cols = COLS();
  for (const line of lines) {
    // Strip ANSI codes for length calculation, then truncate visible content if needed
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (visible.length > cols) {
      // Naive truncation — works for simple lines; for ANSI-heavy lines just emit as-is
      process.stdout.write(line.slice(0, cols * 3) + C.reset + '\x1b[K\n');
    } else {
      process.stdout.write(line + '\x1b[K\n');
    }
  }
  prevLines = lines.length;
}

// ── Keyboard: q to quit ───────────────────────────────────────────────────────

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === '\u0003') {
      process.stdout.write('\x1b[?25h'); // show cursor
      process.stdout.write('\n');
      process.exit(0);
    }
  });
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

process.stdout.write('\x1b[?25l'); // hide cursor

async function poll(): Promise<void> {
  spinIdx++;
  try {
    const res = await fetch(`${SERVER_URL}/status/progress`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      renderError(`Server returned ${res.status}`);
      return;
    }
    const data = await res.json() as ProgressResponse;
    if (data.activeJobs === 0 && data.jobs.filter((j) => j.state !== 'running').length === 0) {
      renderIdle(SERVER_URL);
    } else {
      renderJobs(data);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    renderError(`Cannot reach server: ${msg}`);
  }
}

// Initial render immediately, then poll
await poll();
setInterval(poll, POLL_MS);
