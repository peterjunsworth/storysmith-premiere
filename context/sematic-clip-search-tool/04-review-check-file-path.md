# Review: check-file-path — `server.js` & `clip-paths.ts`

> **Status: REVIEWED — 2 critical issues identified**
> This document reviews the changes introduced in commit `ea75eba` ("check file path").
> It covers plan-vs-implementation consistency, pattern conformance, and critical findings.

---

## What Was Reviewed

| File | Role |
|------|------|
| `backend/server.js` | Express backend (CommonJS) serving the UXP plugin |
| `semantic-clip-search-tool/src/api/routes/clip-paths.ts` | TypeScript route (ESM) in the semantic search service |

**Driving plan:** `plans/sleepy-waddling-cherny.md`
**Unrelated plan (out of scope):** `plans/nested-stargazing-globe.md` — "View in Sequence" button (not implemented here, expected)

---

## Plan vs. Implementation Consistency

| Plan Requirement | `server.js` | `clip-paths.ts` | Verdict |
|-----------------|-------------|-----------------|---------|
| Add `findLongestValidPrefix()` | ✅ Lines 311-331 | ✅ Lines 243-267 | Consistent |
| Add `generateCandidates()` (6 strategies, priority sort) | ✅ Lines 337-398 | ✅ Lines 273-339 | Consistent |
| Add `reconstructPath()` two-phase loop | ✅ Lines 404-430 | ✅ Lines 344-374 | Consistent |
| Update `fixFilePath()` to call both phases | ✅ Lines 432-487 | ✅ Lines 376-423 | Consistent |
| Port algorithm to TypeScript for consistency | N/A | ✅ Fully ported | Consistent |
| Optional path-existence caching (performance) | ❌ Not implemented | ❌ Not implemented | Plan suggestion not adopted — acceptable |

**Overall plan adherence: HIGH.** All required algorithmic changes are present in both files. The optional caching optimisation was skipped, which is acceptable for the current scope.

---

## Architecture

```
UXP Plugin (Premiere)
        │
        ▼
backend/server.js  (port 3001, CommonJS, sqlite3 async)
        │
        ├── POST /transcripts     → fixFilePath (Phase 1 + Phase 2)
        │                           + findTranscriptFile (reads MetadataIndexer)
        └── POST /index, /search  → proxy → port 3100
                                              │
                        semantic-clip-search-tool (port 3100, ESM, better-sqlite3)
                                              │
                                    POST /clip-paths
                                    POST /transcripts  (backward-compat alias)
                                              │
                                    fixFilePath (same Phase 1 + Phase 2 algorithm)
```

### Two-phase `fixFilePath` algorithm (both files)

```
Phase 1 — findLongestValidPrefix (backwards scan)
  Tries progressively shorter slices joined with "/"
  Finds the deepest existing directory segment
  Returns { validPrefix, remainingIdx }

Phase 2 — reconstructPath (forward greedy with priority)
  For each remaining token, tests candidates in priority order:
    priority 5: 4-word space join  ("My Project v2 Final")
    priority 4: 3-word space join  ("My Project v2")
    priority 3: 2-word space join  ("Card 1")       ← NEW (fixes the bug)
    priority 2: 2-word hyphen      ("storysmith-premiere")
    priority 2: 2-word dot         ("file.wav")
    priority 1: single word        ("Users")
  Falls back to single-word append if no candidate exists
```

---

## Pattern Conformance

| Pattern | `server.js` | `clip-paths.ts` |
|---------|-------------|-----------------|
| Module system | CommonJS (`require`) — correct for `backend/` | ESM (`import`) — correct for `semantic-clip-search-tool/` (type: module) |
| SQLite driver | `sqlite3` (callback/Promise) — consistent with `backend/package.json` | `better-sqlite3` (sync) — consistent with `semantic-clip-search-tool/package.json` |
| Error handling | try/catch + `res.status(500)` | try/catch + `res.status(500)` |
| Route factory | N/A (flat express app) | `createClipPathsRouter(config)` — follows established router factory pattern in `routes/*.ts` |
| Response shape | `{ success, transcripts, projectGuid, searchedDatabases, totalFound }` | `{ success, transcripts, clips, projectGuid, searchedDatabases, totalFound }` — adds `clips` key for semantic clarity |

---

## Differences Between the Two Files (By Design)

| Aspect | `server.js` | `clip-paths.ts` | Reason |
|--------|-------------|-----------------|--------|
| Transcript content loading | Calls `findTranscriptFile()` — attempts to read actual transcript JSON/text from `MetadataIndexer/Transcripts-1/` | **Omitted** — sets `source: 'media_cache'`, no transcript content | `clip-paths.ts` is focused on path resolution for the indexing pipeline; transcript content reading is the UXP-facing backend's responsibility |
| Response field | `transcripts` only | Both `transcripts` (compat) and `clips` | `clips` key better matches the endpoint's purpose |
| DB driver | `sqlite3` async | `better-sqlite3` sync | Correct per project type |

These divergences are **intentional and acceptable**.

---

## Critical Issues

### ❗ Issue 1 — `require()` inside an ESM module (`clip-paths.ts` line 195)

**Severity: Critical — runtime failure**

```typescript
// clip-paths.ts — decompressGzip function
function decompressGzip(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { createReadStream } = require('node:fs');  // ❌ require is undefined in ESM
```

`semantic-clip-search-tool` is declared as `"type": "module"` in its `package.json`. In ESM modules, `require` is **not defined**. This call will throw `ReferenceError: require is not defined` at runtime whenever `decompressGzip` is called (i.e., any request with a `projectPath` body field).

**`createReadStream` is already available** via the top-level import on line 2:
```typescript
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
```

**Fix:** Add `createReadStream` to the existing `node:fs` import and remove the `require()` call:

```typescript
// Line 2 — add createReadStream
import { createReadStream, existsSync, readdirSync } from 'node:fs';

// decompressGzip — remove the require() line
function decompressGzip(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(filePath);  // ✅
```

---

### ❗ Issue 2 — Unused imports (`clip-paths.ts` line 2)

**Severity: Minor — dead code / compile noise**

```typescript
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
//       ^^^^^^^^^^^                              ^^^^^^^^^
//       Never used                               Never used
```

`readFileSync` and `statSync` are imported but have no call sites in the file. `findTranscriptFile` (which used `statSync`) was deliberately omitted from this file, leaving the import orphaned.

**Fix:** Remove unused identifiers:

```typescript
import { createReadStream, existsSync, readdirSync } from 'node:fs';
```

---

## Non-Critical Observations

| # | Observation | Impact |
|---|-------------|--------|
| 1 | `server.js` header comment says `Access: http://localhost:3000` but server binds to `PORT = 3001` | Documentation mismatch only |
| 2 | `clipsWithTranscripts` in `clip-paths.ts` (line 69) is obtained from `db.prepare().all()` then mutated with `.push()`. Works but pattern is slightly inconsistent with immutable style used elsewhere. | Style only |
| 3 | Phase 1 (`findLongestValidPrefix`) joins remaining parts with `/` not space — this means it will only find directory segments that exist as single-word paths, never multi-word ones. That is the expected and correct behaviour: Phase 1 finds the anchor, Phase 2 handles multi-word reconstruction. | No defect — works as designed |
| 4 | `plans/nested-stargazing-globe.md` (View in Sequence) is **not implemented** in this commit. No code for sequence navigation exists yet. | Expected — separate future task |

---

## Summary

| Category | Result |
|----------|--------|
| Plan-to-code consistency | ✅ HIGH — all algorithmic changes match `plans/sleepy-waddling-cherny.md` |
| Algorithm parity (server.js ↔ clip-paths.ts) | ✅ Identical logic, language-appropriate adaptations |
| Pattern conformance | ✅ Follows existing route factory, error handling, and module system patterns |
| Critical runtime defect | ❌ `require()` in ESM module (`clip-paths.ts:195`) — must fix before deployment |
| Dead imports | ⚠️ `readFileSync`, `statSync` unused in `clip-paths.ts` — should clean up |
| `nested-stargazing-globe.md` plan | ⏳ Not yet implemented — out of scope for this PR |
