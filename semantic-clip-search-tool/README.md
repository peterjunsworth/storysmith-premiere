# Premiere Timeline Semantic Search

Watches a Premiere Pro timeline JSON export, transcribes each audio clip via whisper.cpp (Metal/CUDA/CPU), chunks the transcript, embeds chunks via Ollama (`nomic-embed-text`), stores in ChromaDB, and exposes a CLaRa-style search endpoint that returns timeline positions.

Indexing runs through a **pipelined queue with delta detection and SQLite persistence** — only changed clips are re-processed, jobs survive server restarts, and multiple timelines can be submitted concurrently.

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
                           │      (concurrency N) │ whisper.cpp (Metal)     │
                           │          │           │                         │
                           │  [2] embedStage      │ OllamaEmbedService      │
                           │      (concurrency 1) │ nomic-embed-text 768-d  │
                           │          │           │                         │
                           │  [3] storeStage      │ ChromaService           │
                           │      (concurrency 3) │ upsert premiere_clips   │
                           └──────────┬──────────┘                         │
                                      │                                     │
                                      ▼                                     │
                             ProgressTracker ◀────────────────────────────-┘
                             TimelineStore (SQLite job history)

Search Request
         │
         ▼
  QueryExpander (CLaRa)    llama3.2 → N hypothetical excerpts → avg embedding
         │
         ▼
  ChromaService.query()    cosine similarity → TimelineHit[]
```

### Key design points

- **Delta detection** — incoming clips compared against last SQLite snapshot by fingerprint (`filePath:duration`). Only new or changed clips enter the pipeline.
- **Pipelined concurrency** — each stage runs independently with its own worker pool. Transcription is the bottleneck (`WHISPER_CONCURRENCY`), embedding is serial (Ollama constraint), storing is parallel.
- **SQLite persistence** — every job is written to `data/timelines.db` on start, completion, and failure. Server restarts mark any `running` jobs as `interrupted`.
- **Snapshot-before-processing** — the clip snapshot is saved to SQLite *before* the pipeline starts. If the server crashes mid-job, the next submission sees a clean diff.
- **Atomic reset** — `POST /admin/reset-all` drops ChromaDB vectors, wipes SQLite snapshots and job history, and clears the in-memory tracker in a single operation, keeping all layers in sync.

---

## Quick Start

### 1. Install everything

```bash
bash scripts/install.sh
```

Installs and configures all dependencies in one step: Node.js ≥ 18, Xcode CLT / build-essential, CMake, ffmpeg, whisper.cpp (auto-detects Metal/CUDA/CPU), the default whisper model (`base.en`), Ollama + required models, Python 3, ChromaDB Python venv, and `npm install`. Creates `.env` from `.env.example` and patches in the detected whisper paths.

Options:
```bash
bash scripts/install.sh --whisper-model large-v3-turbo   # use a larger model
bash scripts/install.sh --skip-whisper                   # skip whisper build
bash scripts/install.sh --skip-ollama                    # skip Ollama install
bash scripts/install.sh --force-whisper                  # rebuild whisper.cpp
```

### 2. Review `.env`

```bash
# Verify these two paths match your whisper.cpp build:
WHISPER_BIN=/Users/you/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL=/Users/you/whisper.cpp/models/ggml-base.en.bin
```

### 3. Start everything

```bash
npm run start:full   # ChromaDB + Ollama + API server
```

### 4. Stop everything

```bash
npm run stop:full    # stops only services that start:full launched
```

---

## Setup (manual)

If you prefer to set things up individually rather than using `install.sh`:

```bash
cp .env.example .env    # set WHISPER_BIN, WHISPER_MODEL at minimum
npm install
```

### whisper.cpp

whisper.cpp must be compiled from source with the correct acceleration backend. The `whisper-setup/` folder contains everything needed.

```bash
# 1. Detect platform and get the exact build command
tsx whisper-setup/check-acceleration.ts

# 2. Clone and compile (auto-detects Metal / CUDA / CPU)
bash whisper-setup/build.sh

# 3. Download a model
bash whisper-setup/download-model.sh base.en          # testing
bash whisper-setup/download-model.sh large-v3-turbo   # production

# 4. Verify it works (runs jfk.wav sample, checks Metal/CUDA is active)
bash whisper-setup/verify.sh
```

`check-acceleration.ts` prints ready-to-paste `.env` lines for `WHISPER_BIN`, `WHISPER_MODEL`, and `WHISPER_THREADS`. See [`whisper-setup/GUIDE.md`](whisper-setup/GUIDE.md) for the full reference including Linux/Windows/CUDA instructions and model comparison table.

### ChromaDB

```bash
bash chromadb/setup.sh   # creates Python venv at chromadb/.venv (idempotent)
npm run db:up            # start ChromaDB on :8000
```

### Ollama

```bash
ollama serve             # or: brew services start ollama
npm run ollama:pull      # pull nomic-embed-text + llama3.2 if missing
```

---

## Service Management

### Start / stop everything

```bash
npm run start:full   # starts ChromaDB and/or Ollama if not already up, then starts API server
npm run stop:full    # stops only the services that start:full launched — never touches pre-existing instances
```

`start:full` records which services it started in a `.pids` file. `stop:full` reads that file and sends `SIGTERM` (then `SIGKILL` after 5 s) only to those specific PIDs. Services that were already running before `start:full` are untouched.

### Individual service control

```bash
npm run db:up        # start ChromaDB on :8000
npm run db:down      # stop ChromaDB
npm run db:status    # show ChromaDB status + collection stats
npm run db:reset     # wipe all vector data and restart (prompts for confirmation)

npm run ollama:check # verify Ollama is up and models are present
npm run ollama:pull  # same, but auto-pulls any missing models

npm start            # start API server only (assumes ChromaDB + Ollama already up)
```

### Development workflow

```bash
# Terminal 1 — services
npm run start:full

# Terminal 2 — submit a timeline and watch progress
npm run index path/to/timeline.json
npm run queue

# Terminal 3 — search
npm run search "two people talking about money"

# Or use the interactive TUI for everything
npm run tui

# When done
npm run stop:full
```

> `npm run index` requires the API server to be running. It POSTs the timeline JSON to the server, prints a changeset summary, and exits immediately. Use `npm run queue` to watch live progress.

---

## Usage

### Submit a timeline for indexing

```bash
npm run index path/to/premiere-project-timeline.json
```

Posts the timeline JSON to the server. The server computes a changeset (new, updated, and removed clips against the last snapshot) and queues only the changed clips through the 3-stage pipeline. Output:

```
  Project:  My Documentary  (existing)
  Job ID:   a3f7c2b1
  New:      3 clips
  Updated:  1 clips
  Removed:  0 clips

  Processing 4 clip(s) in background.
  Watch progress:  npm run queue
  Or via HTTP:     GET http://localhost:3100/status/progress/a3f7c2b1
```

If nothing changed since the last index: `No changes detected — nothing to process.`

### Watch live queue progress

```bash
npm run queue
```

Polls `GET /status/progress` every 500 ms and renders a live display. Press `q` or `Ctrl+C` to exit.

### CLI search

```bash
npm run search "two people talking about money"
npm run search "budget discussion" -- --no-expand --top-k 5
```

### Interactive TUI

```bash
npm run tui
```

Full-screen terminal UI with five sections:

| Section | Description |
|---------|-------------|
| **Search** | Run semantic queries with or without CLaRa expansion; pageable results |
| **Projects** | Browse indexed projects and clips; inspect chunks; delete by project or clip |
| **Embeddings** | Browse all chunks grouped by project/clip; collection statistics; bulk delete |
| **Queue** | Live jobs, job history (SQLite), interrupted jobs; clean a project to re-test |
| **DB Admin** | Health check (ChromaDB + Ollama + server), collection info, reset all data, config |

Navigate with arrow keys / `j`·`k`, `Enter` to select, `Esc`/`q` to go back.

**Queue → Clean project:** wipes all embeddings from ChromaDB *and* clears the SQLite snapshot via `DELETE /index/:projectId`. The next `npm run index` for that project is treated as a fresh import.

**DB Admin → Reset all data:** calls `POST /admin/reset-all`, which atomically drops + recreates the ChromaDB collection, wipes all SQLite snapshots and job history, and clears the in-memory job tracker.

### API server

```bash
npm start
```

| Endpoint | Description |
|----------|-------------|
| `POST /search` | `{ query, topK?, expandQuery?, projectId? }` → `SearchResponse` |
| `POST /index` | Raw Premiere JSON body → queues changed clips, returns changeset + job ID |
| `DELETE /index/:projectId` | Remove all ChromaDB chunks *and* SQLite snapshot for a project |
| `GET /status` | ChromaDB + Ollama health ping |
| `GET /status/progress` | All in-memory jobs with per-clip stage and chunk progress |
| `GET /status/progress/:jobId` | Single job detail from memory |
| `GET /status/jobs` | Last 100 jobs from SQLite (includes completed and interrupted) |
| `GET /status/jobs/:jobId` | Single job from memory, falling back to SQLite |
| `GET /status/interrupted` | Jobs that were running when the server was last killed |
| `POST /admin/reset-all` | Atomically reset all state: ChromaDB + SQLite + in-memory tracker |

Example:

```bash
# Submit a timeline
curl -X POST localhost:3100/index \
  -H 'Content-Type: application/json' \
  -d @path/to/timeline.json

# Check progress
curl localhost:3100/status/progress

# Search
curl -X POST localhost:3100/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"budget discussion","expandQuery":true}'

# Delete a project (clears ChromaDB + SQLite snapshot)
curl -X DELETE localhost:3100/index/my-project-id

# Reset everything
curl -X POST localhost:3100/admin/reset-all
```

### File watcher (auto-indexing)

The server automatically starts a chokidar watcher on `TIMELINE_WATCH_GLOB` (default `./data/timelines/**/*.json`). Dropping a Premiere export JSON into that directory triggers indexing within 2 seconds. Delta detection applies — only changed clips are queued.

---

## Configuration

All settings via environment variables (copy `.env.example` to `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `/usr/local/share/whisper/ggml-base.en.bin` | Model file path |
| `WHISPER_THREADS` | `4` | CPU threads per whisper process |
| `WHISPER_CONCURRENCY` | `1` | Max simultaneous whisper.cpp processes |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Embedding model (768-dim) |
| `OLLAMA_LLM_MODEL` | `llama3.2` | LLM for CLaRa hypothesis generation |
| `CHROMA_URL` | `http://localhost:8000` | ChromaDB HTTP server URL |
| `PORT` | `3100` | API server port |
| `SERVER_URL` | `http://localhost:3100` | URL CLI commands use to reach the server |
| `TIMELINE_WATCH_GLOB` | `./data/timelines/**/*.json` | Glob for file watcher |
| `CLARA_N_HYPOTHESES` | `4` | Hypothetical excerpts generated per query |

`WHISPER_CONCURRENCY` controls how many clips are transcribed in parallel. Set to the number of CPU performance cores (e.g. `4` on M-series Macs) to fully utilise the hardware.

---

## File Structure

```
src/
├── types/index.ts          All shared interfaces (Config, JobProgress, Changeset, …)
├── config/config.ts        loadConfig() from env vars
├── services/
│   ├── whisper.ts          WhisperService — spawn whisper.cpp + ffmpeg WAV conversion
│   ├── chunker.ts          ChunkService — 120-word chunks, sentence boundary walk-back
│   ├── embedder.ts         OllamaEmbedService — fetch wrapper for /api/embeddings
│   ├── chroma.ts           ChromaService — chromadb npm client, upsert/query/delete/reset
│   ├── store.ts            TimelineStore — SQLite snapshots + job history (better-sqlite3)
│   ├── queue.ts            IndexQueue — 3-stage pipeline, delta detection, concurrency
│   ├── clara.ts            QueryExpander — CLaRa hypothesis generation + avg embedding
│   └── progress.ts         ProgressTracker — EventEmitter, live job/clip/chunk state
├── indexer/
│   └── watcher.ts          TimelineWatcher — chokidar, submits to IndexQueue on file change
├── api/
│   ├── server.ts           Express app factory + entry point (wires queue + store)
│   └── routes/
│       ├── search.ts       POST /search
│       ├── index.ts        POST /index, DELETE /index/:projectId
│       ├── status.ts       GET /status, /progress, /jobs, /interrupted
│       └── admin.ts        POST /admin/reset-all
└── cli/
    ├── index-cmd.ts        npm run index <json-path>  — submit to server, print changeset
    ├── queue-status.ts     npm run queue              — live queue TUI (polls server)
    ├── search-cmd.ts       npm run search "query" [--no-expand] [--top-k 5]
    └── tui.ts              npm run tui                — interactive management TUI
chromadb/
├── setup.sh                Create Python venv + install ChromaDB (idempotent)
└── requirements.txt        chromadb package pin
data/
├── chroma/                 ChromaDB vector store (gitignored)
└── timelines.db            SQLite — project snapshots + job history (gitignored)
scripts/
├── install.sh              Full system installer (Node, whisper, Ollama, ChromaDB, npm)
├── start.sh                Start all services; records started PIDs to .pids
├── stop.sh                 Stop only services started by start.sh (reads .pids)
├── db.ts                   ChromaDB lifecycle: up / down / reset / status
└── ollama-check.ts         Verify Ollama reachability + required models
whisper-setup/
├── build.sh                Compile whisper.cpp (auto-detects Metal/CUDA/ROCm/CPU)
├── download-model.sh       Download a GGML model from Hugging Face
├── check-acceleration.ts   Detect platform + print .env lines
├── verify.sh               Run jfk.wav sample, confirm acceleration is active
└── GUIDE.md                Full reference: platforms, models, troubleshooting
test/
├── queue/
│   └── queue-integration.ts  10 integration scenarios (delta, delete, reset, round-trip)
├── prepare.ts              Downloads benchmark audio, converts to WAV, patches timeline.json
├── run-eval.ts             End-to-end benchmark: index → WER → search scoring → report
├── scenarios.ts            6 annotated search scenarios with ground truth timestamps
└── fixtures/
    ├── timeline.json       Premiere-format export referencing 3 benchmark clips
    ├── timeline2.json      Second project with 2 clips (used in integration tests)
    └── transcripts/        Reference transcripts for WER comparison
logs/
└── chroma.log              ChromaDB stdout/stderr (gitignored)
.pids                       PID tracking for start:full / stop:full (gitignored)
```

---

## Premiere JSON format

The pipeline accepts the sequences-based export format produced by the Premiere UXP plugin. The entire JSON is sent as the body of `POST /index`:

```json
{
  "sequences": [{
    "clips": [{
      "id": "clip_1_0_1",
      "name": "podcast.wav",
      "filePath": "/path/to/podcast.wav",
      "trackType": "audio",
      "timelineStart": 0,
      "timelineEnd": 5336.37,
      "duration": 5336.37,
      "hasAudio": true
    }]
  }],
  "projectPath": "/path/to/Project.prproj",
  "timestamp": "2026-02-17T00:00:00.000Z"
}
```

Only clips with `hasAudio: true` and a non-null `filePath` are indexed.

---

## SQLite schema

`data/timelines.db` is created automatically on first server start (WAL mode).

**`timelines`** — one row per project, stores the last successfully submitted clip list as JSON. Used by delta detection.

| Column | Type | Description |
|--------|------|-------------|
| `projectId` | TEXT PK | Unique project identifier |
| `projectName` | TEXT | Human-readable name |
| `snapshotJson` | TEXT | JSON array of last-indexed clips |
| `updatedAt` | TEXT | ISO timestamp of last update |

**`jobs`** — one row per indexing job.

| Column | Type | Description |
|--------|------|-------------|
| `jobId` | TEXT PK | UUID |
| `projectId` / `projectName` | TEXT | Project reference |
| `state` | TEXT | `running` \| `done` \| `error` \| `interrupted` |
| `totalClips` / `completedClips` | INTEGER | Clip-level progress |
| `totalChunks` / `embeddedChunks` | INTEGER | Chunk-level progress |
| `startedAt` | TEXT | ISO timestamp |
| `completedAt` | TEXT \| NULL | ISO timestamp, null if not finished |
| `durationMs` | INTEGER \| NULL | Wall-clock ms, null if not finished |

On startup, `markInterruptedJobs()` sets all `state='running'` rows to `state='interrupted'` so stale jobs are never shown as active.

---

## Integration tests

```bash
npm run test:queue
```

Runs 10 integration scenarios against a live server (requires ChromaDB + Ollama + API server on their default ports):

| Scenario | What it tests |
|----------|---------------|
| 1 | Fresh ingest — all clips queued as new |
| 2 | Re-submit unchanged — no-op (changeset = 0) |
| 3 | Single clip updated — only that clip re-queued |
| 4 | Clip removed — removed from ChromaDB and snapshot |
| 5 | Delete project — ChromaDB + SQLite cleared |
| 6 | Re-ingest after delete — treated as fresh import |
| 7 | Two projects independent — no cross-contamination |
| 8 | Reset-all then ingest — ChromaDB/SQLite back in sync |
| 9 | Ingest → reset-all → ingest again — full round-trip |
| 10 | Reset-all twice — idempotent |

---

## Benchmark

### Audio clips

3 chapters from the LibriVox recording of *Adventures of Huckleberry Finn* (public domain, Annie Coleman Rothenberg). Downloaded from archive.org — no login required, ~21 MB each as MP3, converted to 16 kHz mono WAV.

| Clip ID | Chapter | Duration |
|---------|---------|----------|
| `clip_bench_ch08` | Chapter 8 — river island, cannon, Jim ghost scene | ~23 min |
| `clip_bench_ch18` | Chapter 18 — Grangerford family, feud, gunfight | ~27 min |
| `clip_bench_ch29` | Chapter 29 — Wilks imposters, graveyard escape | ~23 min |

### 6 search scenarios

| ID | Description | Clip | Window |
|----|-------------|------|--------|
| S1 | Huck hiding still watching the search party pass | ch08 | 200–600s |
| S2 | Jim mistakes Huck for a ghost, begs not to be hurt | ch08 | 650–1000s |
| S3 | Colonel Grangerford described as tall aristocratic gentleman | ch18 | 0–300s |
| S4 | Buck explains how a feud starts with a quarrel and killing | ch18 | 550–900s |
| S5 | Imposters confronted when real Harvey Wilks arrives | ch29 | 0–400s |
| S6 | Huck escapes through a storm after gold found in coffin | ch29 | 950–1382s |

A scenario **passes** when: top-1 hit is in the correct clip, clip-relative timestamp is within the window, and the chunk text contains at least one key phrase.

### Evaluation metrics

| Metric | Description |
|--------|-------------|
| **WER** | Word error rate between whisper.cpp output and reference Gutenberg text |
| **Hit@1** | Top-1 result is in the expected clip |
| **Hit@3** | Any of top-3 results is in the expected clip |
| **Window accuracy** | % of correct-clip hits within the expected timestamp window |
| **Phrase match rate** | % of hits containing a scenario key phrase |
| **Avg cosine score** | Mean similarity score of top-1 results |

### Running the benchmark

```bash
# Step 1 — one-time setup: download + convert audio (~60 MB, requires ffmpeg)
npm run test:prepare

# Step 2 — full benchmark: index + evaluate (requires ChromaDB + Ollama + WHISPER_BIN)
npm run start:full && npm run test:eval

# Re-run scoring only, reuse existing ChromaDB index
npm run test:eval:no-index
```

Reports are written to `test/report/`:
- `report.json` — full machine-readable results
- `report.md` — human-readable summary with per-scenario breakdown and matched chunk text
