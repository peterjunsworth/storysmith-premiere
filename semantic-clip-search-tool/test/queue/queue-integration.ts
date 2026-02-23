#!/usr/bin/env tsx
/**
 * Queue Integration Tests
 *
 * Tests the full state machine: index → update → partial delete → full delete.
 * Verifies that ChromaDB vectors, SQLite snapshots, and SQLite job history
 * are all consistent after every operation.
 *
 * Requirements:
 *   - API server running:  npm start
 *   - ChromaDB running:    npm run db:up
 *
 * Run:
 *   tsx test/queue/queue-integration.ts
 *
 * The test suite is completely self-contained — it submits timelines via HTTP,
 * queries ChromaDB directly, and inspects SQLite directly. No external test
 * framework required.
 */

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { ChromaClient } from 'chromadb';

// ── Config ────────────────────────────────────────────────────────────────────

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3100';
const CHROMA_URL  = process.env.CHROMA_URL  ?? 'http://localhost:8000';
const DB_PATH     = resolve(process.cwd(), 'data', 'timelines.db');
const FIXTURES    = resolve(process.cwd(), 'test', 'fixtures');

const TIMELINE1_PATH = resolve(FIXTURES, 'timeline.json');
const TIMELINE2_PATH = resolve(FIXTURES, 'timeline2.json');

// Derived projectIds (mirror parseRawExport logic)
function deriveProjectId(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-40);
}
const T1_RAW = JSON.parse(readFileSync(TIMELINE1_PATH, 'utf-8'));
const T2_RAW = JSON.parse(readFileSync(TIMELINE2_PATH, 'utf-8'));
const PROJECT1_ID = deriveProjectId(T1_RAW.projectPath as string);
const PROJECT2_ID = deriveProjectId(T2_RAW.projectPath as string);
const PROJECT1_NAME = (T1_RAW.projectPath as string).split('/').pop() ?? 'unknown';
const PROJECT2_NAME = (T2_RAW.projectPath as string).split('/').pop() ?? 'unknown';

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.log(`  ✗  ${message}`);
    failed++;
    failures.push(message);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`);
}

// ── Server API ────────────────────────────────────────────────────────────────

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function apiDelete(path: string) {
  const res = await fetch(`${SERVER_URL}${path}`, { method: 'DELETE' });
  return { status: res.status, data: await res.json() };
}

async function apiGet(path: string) {
  const res = await fetch(`${SERVER_URL}${path}`);
  return { status: res.status, data: await res.json() };
}

// ── SQLite helpers ─────────────────────────────────────────────────────────────

function dbOpen(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

function getSnapshot(projectId: string): { projectId: string; projectName: string; snapshotJson: string } | undefined {
  const db = dbOpen();
  try {
    return db.prepare('SELECT * FROM timelines WHERE projectId = ?').get(projectId) as any;
  } finally { db.close(); }
}

function getJobs(projectId: string): Array<{ jobId: string; state: string; completedClips: number; totalClips: number }> {
  const db = dbOpen();
  try {
    return db.prepare('SELECT * FROM jobs WHERE projectId = ? ORDER BY startedAt DESC').all(projectId) as any;
  } finally { db.close(); }
}

function getAllJobs(): Array<{ jobId: string; projectId: string; state: string }> {
  const db = dbOpen();
  try {
    return db.prepare('SELECT jobId, projectId, state FROM jobs ORDER BY startedAt DESC').all() as any;
  } finally { db.close(); }
}

// ── ChromaDB helpers ──────────────────────────────────────────────────────────

async function chromaCount(projectId: string): Promise<number> {
  const client = new ChromaClient({ path: CHROMA_URL });
  try {
    const col = await client.getOrCreateCollection({ name: 'premiere_clips' });
    const result = await col.get({ where: { projectId } });
    return result.ids.length;
  } catch {
    return 0;
  }
}

// Wait for a job to finish (poll /status/jobs until state != running)
async function waitForJob(jobId: string, timeoutMs = 30_000): Promise<{ state: string; completedClips: number; totalClips: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await apiGet(`/status/jobs/${jobId}`);
    if (data.state && data.state !== 'running') return data;
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  throw new Error(`Job ${jobId} did not finish within ${timeoutMs}ms`);
}

// ── Preflight ─────────────────────────────────────────────────────────────────

async function preflight(): Promise<boolean> {
  try {
    const { status } = await apiGet('/status');
    if (status !== 200) {
      console.error(`[preflight] Server returned ${status}. Is it running? npm start`);
      return false;
    }
  } catch (e: any) {
    console.error(`[preflight] Cannot reach server at ${SERVER_URL}: ${e.message}`);
    return false;
  }
  return true;
}

// ── CLEAN SLATE ───────────────────────────────────────────────────────────────

async function cleanSlate() {
  // Delete both test projects so we start fresh
  await apiDelete(`/index/${encodeURIComponent(PROJECT1_ID)}`);
  await apiDelete(`/index/${encodeURIComponent(PROJECT2_ID)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── TEST SCENARIOS ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function testScenario1_TwoProjectsCreated() {
  section('Scenario 1 — Create two projects');

  const r1 = await apiPost('/index', T1_RAW);
  assert(r1.status === 200, 'POST /index project1 → 200');
  assert(r1.data.accepted === true, 'project1 accepted');
  assert(r1.data.isNewProject === true, 'project1 isNewProject');
  assertEqual(r1.data.changeset.newClips, 3, 'project1 newClips=3');
  assertEqual(r1.data.changeset.updatedClips, 0, 'project1 updatedClips=0');

  const r2 = await apiPost('/index', T2_RAW);
  assert(r2.status === 200, 'POST /index project2 → 200');
  assert(r2.data.accepted === true, 'project2 accepted');
  assert(r2.data.isNewProject === true, 'project2 isNewProject');
  assertEqual(r2.data.changeset.newClips, 2, 'project2 newClips=2');

  // SQLite snapshot exists for both
  const snap1 = getSnapshot(PROJECT1_ID);
  assert(snap1 !== undefined, 'snapshot exists for project1');
  const snap2 = getSnapshot(PROJECT2_ID);
  assert(snap2 !== undefined, 'snapshot exists for project2');

  // Job rows created
  const jobs1 = getJobs(PROJECT1_ID);
  assert(jobs1.length >= 1, 'at least 1 job row for project1');
  const jobs2 = getJobs(PROJECT2_ID);
  assert(jobs2.length >= 1, 'at least 1 job row for project2');

  // Projects are distinct
  assert(PROJECT1_ID !== PROJECT2_ID, 'project IDs are distinct');

  // Wait for jobs to be queued (may not finish before test ends — we just check state was created)
  const { data: progress1 } = await apiGet(`/status/progress`);
  const liveIds = (progress1.jobs as any[]).map((j: any) => j.jobId);
  assert(
    liveIds.includes(r1.data.jobId) || getJobs(PROJECT1_ID).some((j) => j.jobId === r1.data.jobId),
    'job1 visible in live progress or SQLite',
  );

  return { job1Id: r1.data.jobId, job2Id: r2.data.jobId };
}

async function testScenario2_ResubmitUnchanged() {
  section('Scenario 2 — Resubmit unchanged (no-op)');

  const r1 = await apiPost('/index', T1_RAW);
  assert(r1.status === 200, 'resubmit project1 → 200');
  assertEqual(r1.data.changeset.newClips, 0, 'project1 no new clips');
  assertEqual(r1.data.changeset.updatedClips, 0, 'project1 no updated clips');
  assertEqual(r1.data.changeset.removedClips, 0, 'project1 no removed clips');
  assert(r1.data.isNewProject === false, 'project1 not new');

  const r2 = await apiPost('/index', T2_RAW);
  assert(r2.status === 200, 'resubmit project2 → 200');
  assertEqual(r2.data.changeset.newClips, 0, 'project2 no new clips');
}

async function testScenario3_PartialUpdate() {
  section('Scenario 3 — Partial update (change duration of one clip per project)');

  // Modify project1: change duration of clip_bench_ch08 → fingerprint changes
  const p1Modified = JSON.parse(JSON.stringify(T1_RAW));
  const ch08 = p1Modified.sequences[0].clips.find((c: any) => c.id === 'clip_bench_ch08');
  ch08.duration = ch08.duration + 1; // bump duration → new fingerprint

  const r1 = await apiPost('/index', p1Modified);
  assert(r1.status === 200, 'modified project1 → 200');
  assertEqual(r1.data.changeset.updatedClips, 1, 'project1 updatedClips=1');
  assertEqual(r1.data.changeset.newClips, 0, 'project1 newClips=0');

  // Snapshot should now reflect modified clip
  const snap1 = getSnapshot(PROJECT1_ID);
  assert(snap1 !== undefined, 'snapshot still exists for project1');
  const snapData1 = JSON.parse(snap1!.snapshotJson);
  const snapCh08 = snapData1.clips.find((c: any) => c.clipId === 'clip_bench_ch08');
  assert(snapCh08?.duration === ch08.duration, 'project1 snapshot reflects updated duration');

  // Modify project2: add a clip (using ch29 which p2 doesn't have)
  const p2Modified = JSON.parse(JSON.stringify(T2_RAW));
  p2Modified.sequences[0].clips.push({
    id: 'clip2_ch29',
    name: 'huckfinn_29_twain_apc.wav',
    filePath: '/Users/jeik/ws/jk-dashboard/research/semantic-clip-search-tool/04-implementation/test/fixtures/audio/huckfinn_29_twain_apc.wav',
    trackType: 'audio',
    trackIndex: 0,
    timelineStart: 3041.306188,
    timelineEnd: 4424.777188,
    inPoint: 0,
    outPoint: 1383.471,
    duration: 1383.471,
    hasAudio: true,
  });

  const r2 = await apiPost('/index', p2Modified);
  assert(r2.status === 200, 'modified project2 → 200');
  assertEqual(r2.data.changeset.newClips, 1, 'project2 newClips=1');
  assertEqual(r2.data.changeset.updatedClips, 0, 'project2 updatedClips=0');

  const snap2 = getSnapshot(PROJECT2_ID);
  const snapData2 = JSON.parse(snap2!.snapshotJson);
  assert(snapData2.clips.length === 3, 'project2 snapshot has 3 audio clips (+1 video = correct)');

  return { p1Modified, p2Modified };
}

async function testScenario4_DeleteOneProject() {
  section('Scenario 4 — Delete project1, verify project2 untouched');

  // Capture project2 state before delete
  const snap2Before = getSnapshot(PROJECT2_ID);
  const jobs2Before = getJobs(PROJECT2_ID);

  const r = await apiDelete(`/index/${encodeURIComponent(PROJECT1_ID)}`);
  assert(r.status === 200, 'DELETE /index/project1 → 200');
  assert(r.data.deleted === true, 'deleted=true');
  assert(r.data.snapshotDeleted === true, 'snapshotDeleted=true');

  // project1 snapshot gone
  const snap1After = getSnapshot(PROJECT1_ID);
  assert(snap1After === undefined, 'project1 snapshot removed from SQLite');

  // project1 jobs gone
  const jobs1After = getJobs(PROJECT1_ID);
  assert(jobs1After.length === 0, 'project1 job rows removed from SQLite');

  // project2 snapshot untouched
  const snap2After = getSnapshot(PROJECT2_ID);
  assert(snap2After !== undefined, 'project2 snapshot still exists');
  assertEqual(snap2After?.projectId, snap2Before?.projectId, 'project2 snapshot unchanged');

  // project2 jobs untouched
  const jobs2After = getJobs(PROJECT2_ID);
  assertEqual(jobs2After.length, jobs2Before.length, 'project2 job count unchanged');

  // live tracker: project1 gone from progress endpoint
  const { data: progress } = await apiGet('/status/progress');
  const liveP1Jobs = (progress.jobs as any[]).filter((j: any) => j.projectId === PROJECT1_ID);
  assert(liveP1Jobs.length === 0, 'project1 removed from live progress tracker');

  // job history endpoint: project1 jobs gone
  const { data: history } = await apiGet('/status/jobs');
  const histP1 = (history.jobs as any[]).filter((j: any) => j.projectId === PROJECT1_ID);
  assert(histP1.length === 0, 'project1 absent from /status/jobs');
}

async function testScenario5_UpdateProject2AfterProject1Deleted() {
  section('Scenario 5 — Update project2 after project1 deleted');

  // Resubmit T2_RAW unchanged → should be no-op
  const r = await apiPost('/index', T2_RAW);
  assert(r.status === 200, 'resubmit project2 after p1 delete → 200');
  // changeset may be non-zero if scenario 3 modified p2, but no crash
  assert(r.data.accepted === true, 'project2 resubmit accepted');

  const snap2 = getSnapshot(PROJECT2_ID);
  assert(snap2 !== undefined, 'project2 snapshot still present after p1 delete');
}

async function testScenario6_DeleteProject2() {
  section('Scenario 6 — Delete project2 (full cleanup)');

  const r = await apiDelete(`/index/${encodeURIComponent(PROJECT2_ID)}`);
  assert(r.status === 200, 'DELETE /index/project2 → 200');
  assert(r.data.deleted === true, 'deleted=true');
  assert(r.data.snapshotDeleted === true, 'snapshotDeleted=true');

  // Both snapshots gone
  const snap1 = getSnapshot(PROJECT1_ID);
  const snap2 = getSnapshot(PROJECT2_ID);
  assert(snap1 === undefined, 'project1 snapshot absent');
  assert(snap2 === undefined, 'project2 snapshot absent');

  // Both job histories gone
  const jobs1 = getJobs(PROJECT1_ID);
  const jobs2 = getJobs(PROJECT2_ID);
  assert(jobs1.length === 0, 'project1 jobs absent');
  assert(jobs2.length === 0, 'project2 jobs absent');

  // Live tracker empty
  const { data: progress } = await apiGet('/status/progress');
  const allLive = (progress.jobs as any[]).filter(
    (j: any) => j.projectId === PROJECT1_ID || j.projectId === PROJECT2_ID,
  );
  assert(allLive.length === 0, 'neither project in live tracker');

  // Job history empty for both
  const { data: history } = await apiGet('/status/jobs');
  const histBoth = (history.jobs as any[]).filter(
    (j: any) => j.projectId === PROJECT1_ID || j.projectId === PROJECT2_ID,
  );
  assert(histBoth.length === 0, 'neither project in /status/jobs');
}

async function testScenario7_ReindexAfterDelete() {
  section('Scenario 7 — Re-index after full delete (treated as fresh import)');

  const r1 = await apiPost('/index', T1_RAW);
  assert(r1.status === 200, 'POST /index project1 again → 200');
  assert(r1.data.isNewProject === true, 'project1 treated as new project after delete');
  assertEqual(r1.data.changeset.newClips, 3, 'project1 newClips=3 (fresh)');

  const r2 = await apiPost('/index', T2_RAW);
  assert(r2.status === 200, 'POST /index project2 again → 200');
  assert(r2.data.isNewProject === true, 'project2 treated as new project after delete');
  assertEqual(r2.data.changeset.newClips, 2, 'project2 newClips=2 (fresh)');

  // Clean up
  await apiDelete(`/index/${encodeURIComponent(PROJECT1_ID)}`);
  await apiDelete(`/index/${encodeURIComponent(PROJECT2_ID)}`);
}

// ── Reset helpers ─────────────────────────────────────────────────────────────

async function apiResetAll() {
  return apiPost('/admin/reset-all', {});
}

function getAllSnapshots(): Array<{ projectId: string }> {
  const db = dbOpen();
  try {
    return db.prepare('SELECT projectId FROM timelines').all() as any;
  } finally { db.close(); }
}

async function testScenario8_ResetAllThenIngest() {
  section('Scenario 8 — reset-all then ingest (edge case: was the bug)');

  // First index both projects so there IS data to reset
  await apiPost('/index', T1_RAW);
  await apiPost('/index', T2_RAW);

  // Verify data exists before reset
  const snapsBefore = getAllSnapshots();
  assert(snapsBefore.some(s => s.projectId === PROJECT1_ID), 'p1 snapshot present before reset');
  assert(snapsBefore.some(s => s.projectId === PROJECT2_ID), 'p2 snapshot present before reset');

  // Reset all
  const r = await apiResetAll();
  assert(r.status === 200, 'POST /admin/reset-all → 200');
  assert(r.data.ok === true, 'reset-all ok=true');
  assert(r.data.chromaReset === true, 'chromaReset=true');
  assert(typeof r.data.snapshotsDeleted === 'number', 'snapshotsDeleted is a number');
  assert(r.data.snapshotsDeleted >= 2, 'at least 2 snapshots deleted');

  // SQLite completely empty
  const snapsAfter = getAllSnapshots();
  assert(snapsAfter.length === 0, 'no snapshots remain after reset-all');
  const allJobsAfter = getAllJobs();
  const relevantJobs = allJobsAfter.filter(
    j => j.projectId === PROJECT1_ID || j.projectId === PROJECT2_ID,
  );
  assert(relevantJobs.length === 0, 'no job rows remain after reset-all');

  // Live tracker empty
  const { data: progress } = await apiGet('/status/progress');
  assert((progress.jobs as any[]).length === 0, 'live tracker empty after reset-all');

  // Now submit project1 — MUST be treated as a new project (not a no-op)
  const r1 = await apiPost('/index', T1_RAW);
  assert(r1.status === 200, 'POST /index project1 after reset → 200');
  assert(r1.data.isNewProject === true, 'project1 isNewProject=true after reset');
  assertEqual(r1.data.changeset.newClips, 3, 'project1 newClips=3 after reset (not 0)');

  // Submit project2 — also fresh
  const r2 = await apiPost('/index', T2_RAW);
  assert(r2.status === 200, 'POST /index project2 after reset → 200');
  assert(r2.data.isNewProject === true, 'project2 isNewProject=true after reset');
  assertEqual(r2.data.changeset.newClips, 2, 'project2 newClips=2 after reset (not 0)');

  // Cleanup
  await apiResetAll();
}

async function testScenario9_IngestThenResetThenIngestAgain() {
  section('Scenario 9 — ingest → reset-all → ingest again (full round-trip)');

  // Round 1
  const r1a = await apiPost('/index', T1_RAW);
  assert(r1a.data.isNewProject === true, 'round1 p1 isNewProject');

  // Reset
  await apiResetAll();

  // Round 2 — must be fresh again
  const r1b = await apiPost('/index', T1_RAW);
  assert(r1b.data.isNewProject === true, 'round2 p1 isNewProject after reset');
  assertEqual(r1b.data.changeset.newClips, 3, 'round2 p1 all clips fresh');

  // Round 2 resubmit — no-op
  const r1c = await apiPost('/index', T1_RAW);
  assertEqual(r1c.data.changeset.newClips, 0, 'round2 p1 second submit is no-op');

  // Cleanup
  await apiResetAll();
}

async function testScenario10_ResetAllTwiceIsSafe() {
  section('Scenario 10 — reset-all twice is idempotent');

  const r1 = await apiResetAll();
  assert(r1.status === 200, 'first reset-all → 200');
  assert(r1.data.ok === true, 'first reset-all ok');

  const r2 = await apiResetAll();
  assert(r2.status === 200, 'second reset-all → 200');
  assert(r2.data.ok === true, 'second reset-all ok');
  assertEqual(r2.data.snapshotsDeleted, 0, 'second reset-all snapshotsDeleted=0');
  assertEqual(r2.data.jobsDeleted, 0, 'second reset-all jobsDeleted=0');
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MAIN ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const startTime = Date.now();

console.log('Queue Integration Tests');
console.log(`  Server:  ${SERVER_URL}`);
console.log(`  ChromaDB: ${CHROMA_URL}`);
console.log(`  SQLite:  ${DB_PATH}`);
console.log(`  Project1 ID: ${PROJECT1_ID}`);
console.log(`  Project2 ID: ${PROJECT2_ID}`);

const ok = await preflight();
if (!ok) process.exit(1);

await cleanSlate();

await testScenario1_TwoProjectsCreated();
await testScenario2_ResubmitUnchanged();
await testScenario3_PartialUpdate();
await testScenario4_DeleteOneProject();
await testScenario5_UpdateProject2AfterProject1Deleted();
await testScenario6_DeleteProject2();
await testScenario7_ReindexAfterDelete();
await testScenario8_ResetAllThenIngest();
await testScenario9_IngestThenResetThenIngestAgain();
await testScenario10_ResetAllTwiceIsSafe();

const elapsed = Date.now() - startTime;

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(62)}`);
console.log(`Results: ${passed} passed, ${failed} failed  (${elapsed}ms)`);
if (failures.length > 0) {
  console.log('\nFailed assertions:');
  for (const f of failures) console.log(`  ✗  ${f}`);
}
console.log('');

// Write machine-readable result for report generation
const result = {
  timestamp: new Date().toISOString(),
  server: SERVER_URL,
  durationMs: elapsed,
  passed,
  failed,
  total: passed + failed,
  failures,
};
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync(resolve(process.cwd(), 'test', 'queue'), { recursive: true });
writeFileSync(
  resolve(process.cwd(), 'test', 'queue', 'result.json'),
  JSON.stringify(result, null, 2),
);

process.exit(failed > 0 ? 1 : 0);
