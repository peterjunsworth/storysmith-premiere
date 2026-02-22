#!/usr/bin/env tsx
/**
 * scripts/db.ts — ChromaDB lifecycle management.
 *
 * Usage (via npm scripts):
 *   npm run db:up      Start ChromaDB in the background
 *   npm run db:down    Kill the ChromaDB process on :8000
 *   npm run db:reset   Kill + wipe ./data/chroma + confirm before doing so
 *   npm run db:status  Show running state, version, and collection stats
 *
 * Can also be run directly:
 *   tsx scripts/db.ts up | down | reset | status
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, openSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT      = join(fileURLToPath(import.meta.url), '..', '..');
const DATA_DIR  = join(ROOT, 'data', 'chroma');
const LOG_DIR   = join(ROOT, 'logs');
const CHROMA_BIN = join(ROOT, 'chromadb', '.venv', 'bin', 'chroma');
const CHROMA_URL = process.env.CHROMA_URL ?? 'http://localhost:8000';

if (!existsSync(CHROMA_BIN)) {
  process.stdout.write(`\x1b[31m✗\x1b[0m ChromaDB venv not found at chromadb/.venv\n`);
  process.stdout.write(`  Run:  bash chromadb/setup.sh\n`);
  process.exit(1);
}

const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const ok   = (s: string) => process.stdout.write(`${GREEN}✓${RESET} ${s}\n`);
const fail = (s: string) => process.stdout.write(`${RED}✗${RESET} ${s}\n`);
const warn = (s: string) => process.stdout.write(`${YELLOW}⚠${RESET} ${s}\n`);
const info = (s: string) => process.stdout.write(`${BOLD}▸${RESET} ${s}\n`);

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CHROMA_URL}/api/v2/heartbeat`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function killPort8000(): void {
  try {
    const pids = execSync('lsof -ti tcp:8000', { encoding: 'utf8' }).trim();
    if (pids) {
      execSync(`kill ${pids.split('\n').join(' ')}`);
    }
  } catch {
    // nothing was running
  }
}

async function waitUntilUp(maxMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function cmdUp(): Promise<void> {
  if (await isUp()) {
    ok(`ChromaDB already running at ${CHROMA_URL}`);
    return;
  }

  info('Starting ChromaDB...');
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR,  { recursive: true });

  const logFile = join(LOG_DIR, 'chroma.log');
  const logFd = openSync(logFile, 'a');
  const child = spawn(CHROMA_BIN, ['run', '--path', DATA_DIR], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: ROOT,
  });
  child.unref();

  if (await waitUntilUp()) {
    ok(`ChromaDB started (PID ${child.pid})`);
  } else {
    fail(`ChromaDB did not start within 10s — check ${logFile}`);
    process.exit(1);
  }
}

function cmdDown(): void {
  killPort8000();
  ok('ChromaDB stopped (or was not running)');
}

async function cmdStatus(): Promise<void> {
  const CYAN = '\x1b[36m';

  process.stdout.write(`${BOLD}ChromaDB status${RESET}\n\n`);
  process.stdout.write(`  URL:      ${CHROMA_URL}\n`);
  process.stdout.write(`  Data dir: ${DATA_DIR}\n`);
  process.stdout.write(`  Log:      ${join(LOG_DIR, 'chroma.log')}\n\n`);

  if (!await isUp()) {
    fail('ChromaDB is not running');
    process.stdout.write(`  Run:  npm run db:up\n`);
    process.exit(1);
  }

  // Version
  try {
    const vRes = await fetch(`${CHROMA_URL}/api/v2/version`, { signal: AbortSignal.timeout(2000) });
    const version = (await vRes.json()) as string;
    ok(`Running  ${CYAN}v${version}${RESET}`);
  } catch {
    ok('Running  (version unknown)');
  }

  // Collection count
  try {
    const cRes = await fetch(
      `${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`,
      { signal: AbortSignal.timeout(2000) }
    );
    const collections = (await cRes.json()) as Array<{ name: string; id: string }>;
    process.stdout.write(`\n  Collections: ${collections.length}\n`);
    for (const col of collections) {
      // Per-collection count
      try {
        const nRes = await fetch(
          `${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections/${col.id}/count`,
          { signal: AbortSignal.timeout(2000) }
        );
        const n = (await nRes.json()) as number;
        process.stdout.write(`    ${CYAN}${col.name}${RESET}  ${n} vectors\n`);
      } catch {
        process.stdout.write(`    ${CYAN}${col.name}${RESET}\n`);
      }
    }
  } catch {
    warn('Could not fetch collection list');
  }

  process.stdout.write('\n');
}

async function cmdReset(): Promise<void> {
  process.stdout.write(`${BOLD}ChromaDB reset — this will DELETE all indexed data.${RESET}\n`);
  process.stdout.write(`  Data dir: ${DATA_DIR}\n\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve =>
    rl.question('  Continue? [y/N] ', resolve)
  );
  rl.close();

  if (answer.toLowerCase() !== 'y') {
    warn('Aborted.');
    return;
  }

  cmdDown();
  if (existsSync(DATA_DIR)) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    ok('Data wiped');
  }
  await cmdUp();
}

// ── Entry point ───────────────────────────────────────────────────────────────

const cmd = process.argv[2];

switch (cmd) {
  case 'up':     await cmdUp();     break;
  case 'down':   cmdDown();          break;
  case 'reset':  await cmdReset();   break;
  case 'status': await cmdStatus();  break;
  default:
    fail(`Unknown command: ${cmd ?? '(none)'}`);
    process.stdout.write('Usage: tsx scripts/db.ts up | down | reset | status\n');
    process.exit(1);
}
