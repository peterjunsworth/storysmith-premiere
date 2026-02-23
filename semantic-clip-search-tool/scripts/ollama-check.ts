#!/usr/bin/env tsx
/**
 * scripts/ollama-check.ts — Verify Ollama is running and required models are pulled.
 *
 * Usage:
 *   npm run ollama:check          Check reachability + model presence
 *   npm run ollama:pull           Same, auto-pull any missing models
 *   tsx scripts/ollama-check.ts [--pull]
 */
import { execSync } from 'node:child_process';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const REQUIRED_MODELS = ['nomic-embed-text', 'llama3.2'];
const pull = process.argv.includes('--pull');

const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const RESET = '\x1b[0m';

const ok   = (s: string) => process.stdout.write(`${GREEN}✓${RESET} ${s}\n`);
const fail = (s: string) => process.stdout.write(`${RED}✗${RESET} ${s}\n`);
const info = (s: string) => process.stdout.write(`${BOLD}▸${RESET} ${s}\n`);

// ── Reachability ──────────────────────────────────────────────────────────────

let tagsJson: { models: Array<{ name: string }> } | null = null;
try {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (res.ok) {
    tagsJson = await res.json() as { models: Array<{ name: string }> };
    ok(`Ollama reachable (${OLLAMA_URL})`);
  } else {
    throw new Error(`HTTP ${res.status}`);
  }
} catch {
  fail(`Ollama not reachable at ${OLLAMA_URL}`);
  process.stdout.write('  Start it:  ollama serve\n');
  process.stdout.write('             brew services start ollama\n');
  process.exit(1);
}

// ── Models ────────────────────────────────────────────────────────────────────

const present = new Set(tagsJson!.models.map(m => m.name.split(':')[0]));

let failed = false;
for (const model of REQUIRED_MODELS) {
  if (present.has(model)) {
    ok(`Model present: ${model}`);
  } else if (pull) {
    info(`Pulling ${model}...`);
    execSync(`ollama pull ${model}`, { stdio: 'inherit' });
    ok(`Model pulled: ${model}`);
  } else {
    fail(`Model missing: ${model}`);
    process.stdout.write(`  Pull it:  ollama pull ${model}\n`);
    process.stdout.write(`  Or run:   npm run ollama:pull\n`);
    failed = true;
  }
}

if (failed) process.exit(1);
