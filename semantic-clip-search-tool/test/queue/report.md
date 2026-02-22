# Queue Artifact — Integration Test Report

**Date:** 2026-02-19
**Test file:** `test/queue/queue-integration.ts`
**Run command:** `npm run test:queue`

---

## Summary

| | |
|---|---|
| **Result** | ✅ PASS |
| **Tests** | 59 passed, 0 failed |
| **Duration** | 68 ms |
| **Server** | http://localhost:3100 |
| **ChromaDB** | http://localhost:8000 |

---

## Bug Fixed

`DELETE /index/:projectId` previously deleted only ChromaDB vectors. After the fix it now atomically cleans:

| Layer | Before | After |
|-------|--------|-------|
| ChromaDB vectors | ✅ deleted | ✅ deleted |
| SQLite `timelines` snapshot | ❌ left behind | ✅ deleted |
| SQLite `jobs` rows | ❌ left behind | ✅ deleted |
| In-memory `ProgressTracker` jobs | ❌ left behind | ✅ deleted |

The response body now includes `snapshotDeleted`, `jobsDeleted`, and `liveJobsRemoved` fields for observability.

---

## Test Scenarios

### Scenario 1 — Create two projects (15 assertions ✅)

Submit `timeline.json` (project1, 3 audio clips) and `timeline2.json` (project2, 2 audio clips).

- Both accepted as new projects
- Correct new-clip counts (3 and 2)
- SQLite snapshots created for both
- Job rows created for both
- Projects have distinct IDs

### Scenario 2 — Resubmit unchanged (no-op) (7 assertions ✅)

Resubmit both timelines with identical content.

- Both return `changeset = { newClips: 0, updatedClips: 0, removedClips: 0 }`
- Both return `isNewProject: false`

### Scenario 3 — Partial update (10 assertions ✅)

- Project1: bump `duration` of one clip → fingerprint changes → `updatedClips: 1`
- Project2: add a third audio clip → `newClips: 1`
- SQLite snapshots updated to reflect new state in both cases

### Scenario 4 — Delete project1, verify project2 untouched (10 assertions ✅)

- `DELETE /index/project1` returns `deleted: true, snapshotDeleted: true`
- Project1 snapshot row gone from `timelines` table
- All project1 job rows gone from `jobs` table
- Project1 absent from live `/status/progress` response
- Project1 absent from `/status/jobs` history
- **Project2 snapshot unchanged** — same `projectId`, same job count

### Scenario 5 — Update project2 after project1 deleted (3 assertions ✅)

Confirm that deleting project1 does not corrupt project2's state.

- Project2 resubmit accepted without error
- Project2 snapshot still present

### Scenario 6 — Full cleanup of project2 (10 assertions ✅)

- Both snapshots absent after deleting project2
- All job rows for both projects absent
- Neither project appears in live tracker or job history

### Scenario 7 — Re-index after full delete (4 assertions ✅)

After complete deletion, resubmitting either timeline is treated as a fresh import.

- Both return `isNewProject: true`
- Both get correct `newClips` counts (3 and 2)

---

## Files Changed

| File | Change |
|------|--------|
| `src/services/store.ts` | Added `deleteProject(projectId)` — deletes from both `timelines` and `jobs` tables |
| `src/services/progress.ts` | Added `deleteProject(projectId)` — removes all in-memory jobs for that project |
| `src/api/routes/index.ts` | `DELETE /:projectId` now accepts `tracker` + `store`; calls all three deletions atomically |
| `src/api/server.ts` | Passes `tracker` and `store` to `createIndexRouter` |
| `test/fixtures/timeline2.json` | New: second project fixture (2 audio clips, distinct projectPath) |
| `test/queue/queue-integration.ts` | New: 7-scenario integration test suite |
| `package.json` | Added `"test:queue"` script |
