# Plan: Premiere Timeline Semantic Search Tool (v3.1 — Implemented)

> **Status: FULLY IMPLEMENTED**
> This document reflects the actual state of the codebase in `04-implementation/` as of the end of the implementation session. It supersedes `03-plan-v3.md`.

---

## What Changed from Plan v3

| Area | Plan v3 | Implemented (v3.1) |
|------|---------|-------------------|
| Queue | Simple EmbeddingPipeline | Full `IndexQueue` with 3-stage concurrency pipeline |
| Persistence | None planned | SQLite (`better-sqlite3`) — snapshots + full job history |
| Delta detection | Not planned | `computeChangeset()` via fingerprint diff; only changed clips reprocess |
| Progress tracking | Not planned | `ProgressTracker` (EventEmitter) — per-clip stage + chunk counts |
| Job history | Not planned | All jobs persisted to SQLite, crash-recovery via `markInterruptedJobs()` |
| Admin API | Not planned | `POST /admin/reset-all` — atomically resets all 4 state layers |
| State reset | Not planned | `resetAll()` in Store, ChromaService, ProgressTracker — prevents desync bugs |
| Project delete | ChromaDB only | ChromaDB + SQLite snapshot + in-memory tracker (all 3 layers) |
| Status API | Single `/status` | 6 endpoints: `/status`, `/status/progress`, `/status/progress/:id`, `/status/jobs`, `/status/jobs/:id`, `/status/interrupted` |
| CLI | 2 scripts | 4 scripts: `index-cmd`, `search-cmd`, `queue-status` (live TUI), `tui` (full interactive) |
| TUI | Not planned | Full interactive menu system (5 panels) |
| CLaRa | Single branch | Two-branch expansion (hypotheses + keywords), merged + deduped hits |
| Startup | `bash scripts/start.sh` | `scripts/start.sh` + `scripts/stop.sh` with PID tracking (safe multi-instance) |
| Install | Manual | `scripts/install.sh` — full system installer (Node, whisper, Ollama, ChromaDB) |
| Tests | Verification scripts | 10 integration scenarios + 6 benchmark eval scenarios |
| npm deps | `chromadb`, `chokidar`, `express` | + `better-sqlite3` |

---

## Architecture

```
Premiere JSON  ──POST /index──▶  IndexQueue  ──────────────────────────────┐
(or file drop)                       │                                      │
                                     │  computeChangeset()                  │
                                     │  TimelineStore (SQLite)              │
                                     │                                      │
                                     ▼                                      │
                           ┌─────────────────────┐                         │
                           │   3-Stage Pipeline   │                         │
                           │                      │                         │
                           │  [1] transcribeStage │ WhisperService          │
                           │      (concurrency N) │ whisper.cpp (Metal/CPU) │
                           │          │           │ + ChunkService          │
                           │          ▼           │                         │
                           │  [2] embedStage      │ OllamaEmbedService      │
                           │      (concurrency 1) │ nomic-embed-text 768-d  │
                           │          │           │                         │
                           │          ▼           │                         │
                           │  [3] storeStage      │ ChromaService           │
                           │      (concurrency 3) │ deleteByClipId + upsert │
                           └──────────┬──────────┘                         │
                                      │                                     │
                                      ▼                                     │
                             ProgressTracker (EventEmitter)  ◀─────────────┘
                             TimelineStore  (SQLite job log)

Search Request (CLI or HTTP)
         │
         ▼
  QueryExpander (CLaRa — two branches)
    Branch A: LLM → N hypothetical excerpts → embed → search ChromaDB
    Branch B: LLM → keyword phrases         → embed → search ChromaDB
    merge + dedup hits by chunk ID (best score wins)
         │
         ▼
  ChromaService.query()    cosine similarity → TimelineHit[]
```

### Four state layers (must always stay in sync)

| Layer | What it holds | Reset method |
|-------|--------------|--------------|
| **ChromaDB** | All vector embeddings | `ChromaService.resetCollection()` |
| **SQLite `timelines`** | Project snapshots (delta detection) | `TimelineStore.resetAll()` |
| **SQLite `jobs`** | Job history | `TimelineStore.resetAll()` |
| **ProgressTracker** | In-memory live job state | `ProgressTracker.resetAll()` |

`POST /admin/reset-all` resets all four atomically. Individual project deletion (`DELETE /index/:projectId`) clears all four for that project only.

---

## File Structure

```
04-implementation/
├── src/
│   ├── types/index.ts              All shared interfaces (see below)
│   ├── config/config.ts            loadConfig() from env vars
│   ├── services/
│   │   ├── queue.ts                IndexQueue — 3-stage pipeline + delta detection
│   │   ├── store.ts                TimelineStore — SQLite snapshots + job history
│   │   ├── whisper.ts              WhisperService — whisper.cpp + ffmpeg WAV conversion
│   │   ├── chunker.ts              ChunkService — 120-word chunks, sentence boundary
│   │   ├── embedder.ts             OllamaEmbedService — POST /api/embeddings
│   │   ├── chroma.ts               ChromaService — upsert/query/delete/resetCollection
│   │   ├── clara.ts                QueryExpander — two-branch CLaRa expansion
│   │   ├── pipeline.ts             EmbeddingPipeline (sync, tests) + parseRawExport
│   │   ├── progress.ts             ProgressTracker — EventEmitter, live state
│   │   └── health.ts               checkDeps() — CLI infra validation
│   ├── indexer/
│   │   └── watcher.ts              TimelineWatcher — chokidar → queueTimeline
│   ├── api/
│   │   ├── server.ts               Express app factory + entry point
│   │   └── routes/
│   │       ├── search.ts           POST /search
│   │       ├── index.ts            POST /index, DELETE /index/:projectId
│   │       ├── status.ts           GET /status, /progress, /jobs, /interrupted
│   │       └── admin.ts            POST /admin/reset-all
│   └── cli/
│       ├── index-cmd.ts            npm run index <json-path>
│       ├── search-cmd.ts           npm run search "query" [--no-expand] [--top-k N]
│       ├── queue-status.ts         npm run queue — live ANSI progress TUI
│       └── tui.ts                  npm run tui — full interactive menu system
├── scripts/
│   ├── install.sh                  Full system installer (Node, whisper, Ollama, ChromaDB)
│   ├── start.sh                    Start all services; write PIDs to .pids
│   ├── stop.sh                     Stop only services launched by start.sh
│   ├── db.ts                       ChromaDB lifecycle: up / down / reset / status
│   └── ollama-check.ts             Verify Ollama reachability + model presence
├── chromadb/
│   ├── setup.sh                    Create Python venv + install chromadb (idempotent)
│   └── requirements.txt            chromadb>=1.4.0
├── whisper-setup/
│   ├── build.sh                    Compile whisper.cpp (Metal/CUDA/ROCm/CPU auto-detect)
│   ├── download-model.sh           Download GGML model from Hugging Face
│   ├── check-acceleration.ts       Detect platform + print .env lines
│   ├── verify.sh                   Run jfk.wav sample, confirm acceleration active
│   └── GUIDE.md                    Full platform reference
├── test/
│   ├── queue/
│   │   └── queue-integration.ts    10 integration scenarios (delta, delete, reset)
│   ├── prepare.ts                  Download + convert benchmark audio
│   ├── run-eval.ts                 End-to-end benchmark: index → WER → search score
│   ├── scenarios.ts                6 annotated search scenarios with ground truth
│   ├── types.ts                    Benchmark TypeScript interfaces
│   ├── report/
│   │   └── build-html.ts           Convert report.json to HTML visualization
│   └── fixtures/
│       ├── timeline.json           Premiere-format export (3 benchmark clips)
│       ├── timeline2.json          Second project fixture (delta test integration)
│       └── transcripts/            Reference text for WER comparison
├── data/
│   ├── chroma/                     ChromaDB persistence (gitignored)
│   └── timelines.db                SQLite (gitignored)
├── logs/
│   ├── chroma.log                  ChromaDB stdout/stderr (gitignored)
│   └── ollama.log                  Ollama stdout/stderr (gitignored)
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
└── README.md
```

---

## Key Interfaces

```typescript
// src/types/index.ts

// ── Premiere input ──────────────────────────────────────────────────────────

interface PremiereClip {
  clipId: string;
  filePath: string;
  timelineStart: number;   // seconds
  timelineEnd: number;
  duration: number;
  hasAudio: boolean;
  name?: string;
}

interface PremiereTimeline {
  projectId: string;
  projectName: string;
  exportedAt: string;
  clips: PremiereClip[];
}

// Raw Premiere UXP export (normalised by parseRawExport)
interface PremierRawExport {
  sequences: PremierRawSequence[];
  projectPath: string;
  timestamp: string;
}

// ── Chunking ────────────────────────────────────────────────────────────────

interface TimedSegment {
  text: string;
  startMs: number;
  endMs: number;
}

interface TextChunk {
  text: string;
  chunkIndex: number;
  chunkStartMs: number;  // relative to clip start
  chunkEndMs: number;
}

interface IndexedChunk extends TextChunk {
  clipId: string;
  projectId: string;
  filePath: string;
  absoluteStart: number;  // Premiere timeline seconds
  absoluteEnd: number;
  timelineStart: number;  // clip bounds
  timelineEnd: number;
  embedding: number[];
}

// ── Queue / pipeline ────────────────────────────────────────────────────────

type ClipStage = 'pending' | 'transcribing' | 'chunking' | 'embedding' | 'storing' | 'done' | 'error';
type JobState  = 'running' | 'done' | 'error' | 'interrupted';

interface ClipProgress {
  clipId: string;
  name: string;
  stage: ClipStage;
  totalChunks: number;
  embeddedChunks: number;
  error?: string;
}

interface JobProgress {
  jobId: string;
  projectId: string;
  projectName: string;
  state: JobState;
  totalClips: number;
  completedClips: number;
  totalChunks: number;
  embeddedChunks: number;
  startedAt: string;
  durationMs?: number;
  clips?: ClipProgress[];
}

interface Changeset {
  isNewProject: boolean;
  newClips: PremiereClip[];
  updatedClips: PremiereClip[];
  removedClips: PremiereClip[];
}

// ── Search API ──────────────────────────────────────────────────────────────

interface SearchRequest {
  query: string;
  topK?: number;           // default 10
  expandQuery?: boolean;   // default true (CLaRa)
  projectId?: string;      // optional filter
}

interface TimelineHit {
  rank: number;
  score: number;
  clipId: string;
  filePath: string;
  timelineStart: number;
  timelineEnd: number;
  absoluteStart: number;
  absoluteEnd: number;
  chunkStartMs: number;
  chunkEndMs: number;
  chunkText: string;
  chunkIndex: number;
}

interface SearchResponse {
  query: string;
  expandedQueries?: string[];
  hits: TimelineHit[];
  durationMs: number;
}

// ── Configuration ───────────────────────────────────────────────────────────

interface Config {
  whisperBin: string;
  whisperModel: string;
  whisperThreads: number;
  whisperConcurrency: number;
  ollamaUrl: string;
  ollamaEmbedModel: string;
  ollamaLlmModel: string;
  chromaUrl: string;
  port: number;
  serverUrl: string;
  timelineWatchGlob: string;
  claraNHypotheses: number;
}
```

---

## Service Descriptions

### `IndexQueue` (queue.ts)
Pipelined batch processor with three `PipelineStage<In, Out>` workers running independently:

| Stage | Worker | Concurrency |
|-------|--------|-------------|
| Transcribe | `WhisperService` + `ChunkService` | `WHISPER_CONCURRENCY` (env, default 1) |
| Embed | `OllamaEmbedService` | 1 (Ollama handles one batch at a time) |
| Store | `ChromaService` delete+upsert | 3 |

**Delta-aware submission:** `queueTimeline()` calls `TimelineStore.computeChangeset()` to diff incoming clips against the last SQLite snapshot. Only new and updated clips enter the pipeline; removed clips are deleted from ChromaDB immediately.

**Crash recovery:** Server startup calls `TimelineStore.markInterruptedJobs()` which sets all `state='running'` rows to `state='interrupted'`, preventing stale jobs from appearing active.

### `TimelineStore` (store.ts)
SQLite database via `better-sqlite3` (synchronous API, WAL mode).

**Tables:**
```sql
-- Project snapshots for delta detection
CREATE TABLE timelines (
  projectId    TEXT PRIMARY KEY,
  projectName  TEXT,
  snapshotJson TEXT,   -- full PremiereTimeline JSON
  updatedAt    TEXT
);

-- Job history (survives server restarts)
CREATE TABLE jobs (
  jobId           TEXT PRIMARY KEY,
  projectId       TEXT,
  projectName     TEXT,
  state           TEXT,  -- running|done|error|interrupted
  totalClips      INTEGER,
  completedClips  INTEGER,
  totalChunks     INTEGER,
  embeddedChunks  INTEGER,
  startedAt       TEXT,
  completedAt     TEXT,
  durationMs      INTEGER
);
```

**Key methods beyond standard CRUD:**
- `computeChangeset(timeline)` — fingerprint diff (`filePath:duration`)
- `markInterruptedJobs()` — crash recovery on startup
- `resetAll()` — wipes both tables atomically
- `deleteProject(projectId)` — removes snapshot + all job rows

### `ChromaService` (chroma.ts)
Collection `premiere_clips` with `hnsw:space: cosine`.

**Chunk document ID format:** `${clipId}_chunk_${chunkIndex}`

**Metadata stored per chunk:**
```
clipId, chunkIndex, projectId, filePath
chunkStartMs, chunkEndMs     (within clip, ms)
absoluteStart, absoluteEnd   (Premiere timeline, seconds)
timelineStart, timelineEnd   (clip bounds, seconds)
```

**Key methods beyond standard:**
- `deleteByClipId(clipId)` — safe reindex pattern (delete-before-upsert)
- `deleteByProjectId(projectId)` — where filter on metadata
- `resetCollection()` — drop + recreate (ignores 404 if not exists)
- `ping()` — heartbeat check

### `QueryExpander` / CLaRa (clara.ts)
Two-branch expansion that combines lexical and semantic signal:

```
Branch A — Hypotheses (semantic):
  LLM prompt → N hypothetical spoken transcript excerpts
  → embed each → average → search ChromaDB → claraHits

Branch B — Keywords (lexical):
  LLM prompt → short keyword phrases
  → embed each → average → search ChromaDB → keywordHits

mergeHits(claraHits + keywordHits):
  deduplicate by clipId:chunkIndex
  keep best score per chunk
  sort + slice top-K
```

The `avgEmbedding` (average of query + all hypothesis + keyword embeddings) is also exposed as a fallback single-vector search when the merged hit list is empty.

### `ProgressTracker` (progress.ts)
In-memory EventEmitter that tracks live job/clip state. Populated by `IndexQueue` as clips move through stages; read by `/status/progress` endpoints and `queue-status` TUI.

**Events emitted:** `'clip'` (per stage transition), `'job'` (on finish)

**Key methods beyond standard:**
- `deleteProject(projectId)` — removes all in-memory jobs for a project
- `resetAll()` — clears entire jobs Map

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/search` | `{query, topK?, expandQuery?, projectId?}` → `SearchResponse` |
| POST | `/index` | Raw Premiere JSON → queues changed clips → `QueueAcceptResult` |
| DELETE | `/index/:projectId` | Remove project from ChromaDB + SQLite + tracker |
| GET | `/status` | ChromaDB + Ollama health ping |
| GET | `/status/progress` | All live in-memory jobs with per-clip detail |
| GET | `/status/progress/:jobId` | Single live job |
| GET | `/status/jobs` | Last 100 jobs from SQLite |
| GET | `/status/jobs/:jobId` | Single job (memory → SQLite fallback) |
| GET | `/status/interrupted` | Jobs marked interrupted at last shutdown |
| POST | `/admin/reset-all` | Atomic full reset: ChromaDB + SQLite + tracker |

---

## npm Scripts

```bash
# Start / stop
npm run start:full          # ChromaDB + Ollama + API server (PID-tracked)
npm run stop:full           # Stop only what start:full launched
npm start                   # API server only

# ChromaDB lifecycle
npm run db:setup            # Create Python venv (one-time)
npm run db:up               # Start ChromaDB on :8000
npm run db:down             # Stop ChromaDB
npm run db:status           # Show status + collection stats
npm run db:reset            # Wipe data + restart (prompts)

# Ollama
npm run ollama:check        # Verify Ollama + models
npm run ollama:pull         # Pull missing models

# CLI tools
npm run index <path>        # Submit timeline JSON → server
npm run search "query"      # Semantic search (CLaRa on by default)
npm run queue               # Live queue progress TUI
npm run tui                 # Full interactive TUI

# Tests
npm run test:queue          # 10 integration scenarios
npm run test:eval           # Full benchmark (index + eval)
npm run test:eval:no-index  # Benchmark scoring only (reuse existing index)
npm run report:html         # Build HTML report from report.json
```

---

## Configuration (Environment Variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `/usr/local/share/whisper/ggml-base.en.bin` | GGML model file |
| `WHISPER_THREADS` | `4` | CPU threads per whisper process |
| `WHISPER_CONCURRENCY` | `1` | Max simultaneous whisper.cpp processes |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model (768-dim) |
| `OLLAMA_LLM_MODEL` | `llama3.2` | LLM for CLaRa hypothesis generation |
| `CHROMA_URL` | `http://localhost:8000` | ChromaDB HTTP server URL |
| `PORT` | `3100` | API server port |
| `SERVER_URL` | `http://localhost:3100` | URL used by CLI tools |
| `TIMELINE_WATCH_GLOB` | `./data/timelines/**/*.json` | Chokidar glob |
| `CLARA_N_HYPOTHESES` | `4` | Hypothetical excerpts generated per query |

---

## Infrastructure Setup

### One-command install
```bash
bash scripts/install.sh
# Options:
#   --whisper-model <name>   model to download (default: base.en)
#   --skip-whisper           skip whisper.cpp build
#   --skip-ollama            skip Ollama install
#   --force-whisper          rebuild even if binary exists
```

Installs: Node.js ≥18, Xcode CLT/build-essential, CMake, ffmpeg, whisper.cpp (platform-accelerated), whisper model, Ollama + required models, Python 3, ChromaDB venv, npm dependencies. Creates `.env` from `.env.example` and patches WHISPER_BIN/WHISPER_MODEL with detected paths.

### Service lifecycle
```bash
npm run start:full   # Starts what isn't already running; records PIDs in .pids
npm run stop:full    # Reads .pids; stops only this project's processes (SIGTERM → SIGKILL)
```

Services already running when `start:full` is invoked are noted in output but left alone by `stop:full`.

### whisper.cpp platform support

| Platform | Acceleration | Flag |
|----------|-------------|------|
| macOS 13+ (Metal) | Apple Silicon / Intel + GPU | `GGML_METAL=1` |
| Linux NVIDIA | CUDA | `GGML_CUDA=1` |
| Linux AMD | ROCm/HIP | `GGML_HIP=1` |
| Any (fallback) | CPU (AVX2 if available) | — |

`whisper-setup/build.sh` auto-detects platform and applies correct cmake flags.

---

## Tests

### Integration tests (`test/queue/queue-integration.ts`)
Run against a live server on default ports.

| # | Scenario | Tests |
|---|----------|-------|
| 1 | Fresh ingest | All clips queued as new; ChromaDB + SQLite populated |
| 2 | Re-submit unchanged | Changeset = 0; no re-processing |
| 3 | Single clip updated | Only changed clip re-queued (delta detection) |
| 4 | Clip removed | Removed from ChromaDB and snapshot |
| 5 | Delete project | ChromaDB + SQLite + tracker all cleared |
| 6 | Re-ingest after delete | Treated as new project |
| 7 | Two projects concurrent | No cross-project contamination |
| 8 | Reset-all then ingest | All layers resynced; full re-ingest |
| 9 | Ingest → reset-all → ingest | Full round-trip integrity |
| 10 | Reset-all twice | Idempotent (0 rows deleted on second call) |

### Benchmark eval (`test/run-eval.ts`)
End-to-end evaluation against 3 LibriVox audio chapters (~23–27 min each).

**6 search scenarios** (S1–S6) from *Adventures of Huckleberry Finn*:

| ID | Description | Clip |
|----|-------------|------|
| S1 | Huck hiding, watching search party pass | ch08 |
| S2 | Jim mistakes Huck for a ghost | ch08 |
| S3 | Colonel Grangerford described | ch18 |
| S4 | Buck explains how a feud starts | ch18 |
| S5 | Imposters confronted when real Harvey arrives | ch29 |
| S6 | Huck escapes through a storm | ch29 |

**Pass criteria:** top-1 hit in correct clip + timestamp within window + chunk contains a key phrase.

**Metrics:** WER, Hit@1, Hit@3, window accuracy, phrase match rate, avg cosine score.

---

## Key Design Decisions Made During Implementation

### 1. IndexQueue over EmbeddingPipeline
The original plan had a simple synchronous `EmbeddingPipeline`. This was replaced with a stateful `IndexQueue` using three independent `PipelineStage` workers to avoid blocking — whisper.cpp can run while previous results are being embedded, and embeddings can be stored while new ones are being generated.

### 2. SQLite added (not in v3 plan)
State persistence was identified as necessary for:
- Delta detection (snapshot of last indexed state)
- Job history that survives server restarts
- Crash recovery (`markInterruptedJobs`)
- The TUI's job history screen

### 3. Atomic reset via `/admin/reset-all`
After discovering a desync bug (TUI "re-create collection" wiped ChromaDB but left SQLite snapshots intact, causing the queue to see changeset=0 on next submit even though ChromaDB was empty), a dedicated endpoint was added to reset all four state layers together.

### 4. Two-branch CLaRa vs single-branch
The original plan used a single hypothesis branch. The implementation added a parallel keyword-phrase branch because small local LLMs (llama3.2) sometimes produce long narrative hypotheses that are too far from the query semantically. The keyword branch provides a lexical anchor.

### 5. PID-tracked start/stop
The naive approach (`kill port 8000`) would kill any ChromaDB on that port, including pre-existing instances not started by this project. `start.sh` instead records only the PIDs it starts, and `stop.sh` kills only those.

### 6. TUI double-input bug fix
`textInput()` switches stdin from raw mode to line mode for `readline`, then restores raw mode after. Without draining the stdin buffer (`setImmediate` + `process.stdin.read()`) before restoring raw mode, the Enter key's newline was left in the buffer and immediately consumed by the next `waitKey()` call, making inputs appear to require being entered twice.

---

## What Was Not Implemented (Out of Scope)

- **Windows support** — `scripts/install.sh`, `start.sh`, `stop.sh` are bash-only; whisper.cpp Windows build is documented in `whisper-setup/GUIDE.md` but not scripted
- **Authentication** — API server has no auth; intended for local use only
- **Remote ChromaDB** — config supports `CHROMA_URL` pointing anywhere but install scripts assume local
- **Streaming search results** — search is request/response only, no SSE
- **Re-indexing queue UI** — reindex is triggered by re-submitting the timeline, not a TUI action
