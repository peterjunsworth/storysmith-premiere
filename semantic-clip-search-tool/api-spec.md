# API Spec

Base URL: `http://localhost:3100`

See also: [README.md](README.md)

---

## Search

### `POST /search`

```json
// Request
{ "query": "sunrise over the mountains", "topK": 5, "expandQuery": true, "projectId": "proj-abc" }
// topK default: 5 | expandQuery default: true | projectId: optional filter

// Response 200
{
  "query": "sunrise over the mountains",
  "expandedQueries": ["golden hour landscape", "dawn mountain scene"],
  "hits": [
    {
      "rank": 1, "score": 0.91,
      "clipId": "clip-1", "filePath": "/path/to/clip.wav",
      "timelineStart": 12.4, "timelineEnd": 28.1,
      "chunkText": "the sun rose slowly over the peaks",
      "chunkIndex": 2,
      "chunkStartMs": 4200, "chunkEndMs": 9800,
      "absoluteStart": 16.6, "absoluteEnd": 22.2
    }
  ],
  "durationMs": 340
}
```

---

## Index

### `POST /index`

Body is a raw Premiere Pro JSON export (`sequences` object).

```json
// Request
{
  "sequences": [{
    "sequenceName": "My Sequence",
    "clips": [{ "id": "clip_1", "name": "podcast.wav", "filePath": "/path/to/podcast.wav",
                "timelineStart": 0, "timelineEnd": 5336.37, "duration": 5336.37, "hasAudio": true }]
  }],
  "projectPath": "/path/to/Project.prproj",
  "timestamp": "2026-02-17T00:00:00.000Z"
}

// Response 200
{
  "accepted": true,
  "jobId": "a3f7c2b1-...",
  "projectId": "path_to_Project_prproj",
  "projectName": "Project.prproj",
  "isNewProject": true,
  "changeset": { "newClips": 1, "updatedClips": 0, "removedClips": 0 }
}
```

### `DELETE /index/:projectId`

```json
// DELETE /index/path_to_Project_prproj

// Response 200
{ "deleted": true, "projectId": "path_to_Project_prproj", "snapshotDeleted": true, "jobsDeleted": 4, "liveJobsRemoved": 1 }
```

---

## Status

### `GET /status`

```json
// Response 200
{
  "chromaOk": true, "ollamaOk": true,
  "chromaUrl": "http://localhost:8000", "ollamaUrl": "http://localhost:11434",
  "embedModel": "nomic-embed-text", "llmModel": "llama3.2"
}
```

### `GET /status/progress`

Active in-memory jobs. Each job includes `projectName` and `sequenceName`.

```json
// Response 200
{
  "activeJobs": 1,
  "jobs": [
    {
      "jobId": "a3f7c2b1-...",
      "projectId": "path_to_Project_prproj",
      "projectName": "Project.prproj",
      "sequenceName": "My Sequence",
      "state": "running",
      "totalClips": 12, "completedClips": 5,
      "totalChunks": 84, "embeddedChunks": 35,
      "percentComplete": 41,
      "startedAt": "2026-02-17T10:00:00.000Z",
      "elapsedMs": 8200
    }
  ]
}
```

### `GET /status/progress/:jobId`

```json
// Response 200 — live job
{
  "jobId": "a3f7c2b1-...",
  "projectName": "Project.prproj",
  "sequenceName": "My Sequence",
  "state": "running",
  "percentComplete": 41, "chunksPercentComplete": 41,
  "elapsedMs": 8200, "source": "live"
}

// Response 404
{ "error": "Job not found", "jobId": "a3f7c2b1-..." }
```

### `GET /status/jobs`

Last 100 jobs from SQLite (includes completed/failed/interrupted).

```json
// Response 200
{
  "total": 18,
  "jobs": [
    {
      "jobId": "a3f7c2b1-...",
      "projectName": "Project.prproj",
      "sequenceName": "My Sequence",
      "state": "done",
      "totalClips": 12, "completedClips": 12,
      "startedAt": "2026-02-17T10:00:00.000Z",
      "completedAt": "2026-02-17T10:04:12.000Z",
      "durationMs": 252000
    }
  ]
}
```

### `GET /status/jobs/:jobId`

```json
// Response 200
{
  "jobId": "a3f7c2b1-...",
  "projectName": "Project.prproj",
  "sequenceName": "My Sequence",
  "state": "done", "source": "db"
}

// Response 404
{ "error": "Job not found", "jobId": "a3f7c2b1-..." }
```

### `GET /status/interrupted`

Jobs that were running when the server last stopped.

```json
// Response 200
{ "total": 1, "jobs": [ { "jobId": "a3f7c2b1-...", "projectName": "Project.prproj", "sequenceName": "My Sequence", "state": "interrupted" } ] }
```

---

## Admin

### `POST /admin/reset-all`

Wipes all state: ChromaDB vectors, SQLite snapshots, job records, in-memory queue.

```json
// Request — empty body

// Response 200
{ "ok": true, "chromaReset": true, "snapshotsDeleted": 3, "jobsDeleted": 18, "liveJobsCleared": 0 }

// Response 500
{ "ok": false, "error": "ChromaDB unreachable" }
```
