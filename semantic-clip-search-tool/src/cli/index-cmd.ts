#!/usr/bin/env tsx
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../config/config.js';

const { positionals } = parseArgs({ allowPositionals: true, options: {} });

const jsonPath = positionals[0];
if (!jsonPath) {
  console.error('Usage: tsx src/cli/index-cmd.ts <timeline-json-path>');
  process.exit(1);
}

const config = loadConfig();
const serverUrl = config.serverUrl;

// ── Read + POST ───────────────────────────────────────────────────────────────

let raw: unknown;
try {
  raw = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[index-cmd] Failed to read ${jsonPath}: ${msg}`);
  process.exit(1);
}

console.log(`[index-cmd] Submitting to ${serverUrl}/index ...`);

let response: Response;
try {
  response = await fetch(`${serverUrl}/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(raw),
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[index-cmd] Could not reach server at ${serverUrl}: ${msg}`);
  console.error('  Make sure the server is running: npm run start');
  process.exit(1);
}

const body = await response.json() as Record<string, unknown>;

if (!response.ok) {
  console.error(`[index-cmd] Server returned ${response.status}:`);
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

// ── Print result ──────────────────────────────────────────────────────────────

const changeset = body.changeset as { newClips: number; updatedClips: number; removedClips: number };
const isNew = body.isNewProject as boolean;

console.log('');
console.log(`  Project:  ${body.projectName}  (${isNew ? 'new' : 'existing'})`);
console.log(`  Job ID:   ${body.jobId}`);
console.log(`  New:      ${changeset.newClips} clips`);
console.log(`  Updated:  ${changeset.updatedClips} clips`);
console.log(`  Removed:  ${changeset.removedClips} clips`);

const total = changeset.newClips + changeset.updatedClips;
if (total === 0) {
  console.log('');
  console.log('  No changes detected — nothing to process.');
} else {
  console.log('');
  console.log(`  Processing ${total} clip(s) in background.`);
  console.log(`  Watch progress:  npm run queue`);
  console.log(`  Or via HTTP:     GET ${serverUrl}/status/progress/${body.jobId}`);
}
console.log('');
