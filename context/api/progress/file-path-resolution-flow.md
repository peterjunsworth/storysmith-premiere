# Progress: File Path Resolution Flow

## Status
- [x] Part 1 — Document complete file path resolution flow
- [ ] Part 2 — Remove unused/deprecated file path resolution code

## Flow Documentation

### Complete Request Flow (Plugin → Server → Response)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. PLUGIN INITIALIZATION (StorySmith-v1/main.js)                            │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    DOMContentLoaded event (line 1269)
    ↓
    loadClipsFromProject() called (line 101)
    ↓
    Extracts sequences and clips from Premiere Pro project via CSInterface
    ↓
    Collects unique clip names from all sequences
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. FILE PATH RESOLUTION REQUEST                                             │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    POST to /transcripts (line 296) [alias for /clip-paths]
    Request body: {
      projectPath: "/Users/.../project.prproj",
      clipNames: ["clip1.mp4", "clip2.wav", ...]
    }
    ↓
    ↓ [Routes through backend:3001 proxy if configured, or directly to 3100]
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. SERVER PROCESSING (semantic-clip-search-tool:3100)                       │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    POST /clip-paths handler (src/api/routes/clip-paths.ts:13)
    ↓
    Extract project GUID from .prproj file if available (line 18-26)
    ↓
    Locate Adobe Media Cache databases (line 28-46):
      - If GUID: specific .prmdc2 file
      - No GUID: all .prmdc2 files in Media Cache folder
    ↓
    Query SQLite databases for clip records (line 58-105):
      SELECT columnintrinsicfilename, 
             columnintrinsicfilepath,
             columnintrinsictranscriptstatus
      FROM StringTable
      WHERE columnintrinsictranscriptstatus LIKE '%omplete%'
         OR columnintrinsicfilename IN (clipNames)
    ↓
    **KEY ISSUE**: Database stores paths with all separators as spaces:
      " Users peterunsworth Downloads podcast agile intro mp4 "
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. FILE PATH RECONSTRUCTION (fixFilePath function, line 396)                │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    Split DB path on whitespace: ["Users", "peterunsworth", ..., "intro", "mp4"]
    ↓
    Detect /Volumes or root path (line 403-428)
    ↓
    Phase 1: findLongestValidPrefix() (line 246-270)
      - Work backwards from end to find longest existing path prefix
      - Example: /Users/peterunsworth/Downloads/podcast exists
    ↓
    Phase 2: reconstructPath() (line 368-404)
      For each remaining word:
        ↓
        generateCandidates() (line 276-363) creates prioritized candidates:
          Priority 100: File extensions (last 2 words) with dot
            "intro" + "mp4" → "intro.mp4" 
          Priority 5: Four words with spaces
          Priority 4: Three words with spaces  
          Priority 3: Two words with spaces
          Priority 2: Two words with hyphen/dot
          Priority 1: Single word
        ↓
        Try each candidate in priority order (line 385-397):
          - If last 2 words AND priority >= 100: Accept without existsSync
          - Else: Only accept if path exists on filesystem
        ↓
        If no match: Append single word with slash (line 400-402)
    ↓
    Return reconstructed path with proper separators and extensions
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. RESPONSE TO PLUGIN                                                       │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    Response JSON: {
      success: true,
      projectGuid: "...",
      clips: [
        {
          clipName: "intro.mp4",
          filePath: "/Users/peterunsworth/Downloads/podcast/agile/intro.mp4",
          status: "complete",
          audioInfo: "...",
          source: "media_cache"
        },
        ...
      ],
      totalFound: 6
    }
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. PLUGIN UPDATES CLIP DATA (main.js:314-326)                               │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    Match returned file paths to clips by normalized name
    ↓
    Update clip.filePath for matched clips
    ↓
    Store in allClips array
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. USER SENDS SEQUENCES (main.js:388-487)                                   │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    User clicks "Send to Webhook" button
    ↓
    sendToWebhook() builds sequence data with clip.filePath (line 433)
    ↓
    POST to /index (line 453)
    Request body: {
      sequences: [
        {
          sequenceName: "Sequence 01",
          clips: [
            {
              name: "intro.mp4",
              filePath: "/Users/.../intro.mp4",  ← Used here
              trackType: "video",
              timelineStart: 0,
              ...
            }
          ]
        }
      ],
      projectPath: "...",
      timestamp: "..."
    }
    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. INDEXING PIPELINE (semantic-clip-search-tool)                            │
└─────────────────────────────────────────────────────────────────────────────┘
    ↓
    POST /index handler (src/api/routes/index.ts:19)
    ↓
    parseRawExport() converts to internal timeline format
    ↓
    queue.queueTimeline() adds to IndexQueue
    ↓
    Worker processes clips:
      - Extract audio with ffmpeg using clip.filePath
      - Transcribe with whisper.cpp
      - Generate embeddings with Ollama
      - Store in ChromaDB + SQLite
    ↓
    Return job ID for progress tracking

```

### Critical Path Fix (May 2026)

**Problem**: File extensions appearing as directories
- DB: `" Users peterunsworth Documents podcast wav "`
- Before fix: `/Users/peterunsworth/Documents/podcast/wav` (wrong)
- After fix: `/Users/peterunsworth/Documents/podcast.wav` (correct)

**Solution**: 
1. Detect file extensions (last 2 words, common extensions or ≤4 chars)
2. Give extension candidates priority 100
3. Accept high-priority candidates for last 2 words without existsSync check
4. Files: `semantic-clip-search-tool/src/api/routes/clip-paths.ts`
   - `generateCandidates()` lines 284-298 (extension detection)
   - `reconstructPath()` lines 380-397 (priority-based acceptance)

### Key Files

**Plugin (StorySmith-v1/)**
- `main.js` - Main plugin logic
  - `loadClipsFromProject()` (line 101) - Extract sequences, call /transcripts
  - `sendToWebhook()` (line 388) - Send sequences to /index

**Backend Proxy (backend/)** [OPTIONAL - can be bypassed]
- `server.js` (port 3001) - Proxies requests to semantic-clip-search-tool
  - POST /index → forwards to :3100/index
  - POST /transcripts → forwards to :3100/transcripts

**Main Server (semantic-clip-search-tool/)**
- `src/api/server.ts` - Express app setup, routes to :3100
- `src/api/routes/clip-paths.ts` - **FILE PATH RESOLUTION** (the critical file)
  - POST /clip-paths handler (line 13)
  - `fixFilePath()` (line 396) - Main reconstruction function
  - `generateCandidates()` (line 276) - Priority-based path candidates
  - `reconstructPath()` (line 368) - Iterative path building
  - `findLongestValidPrefix()` (line 246) - Find existing base path
- `src/api/routes/index.ts` - Timeline indexing endpoint
  - POST /index handler (line 19)
  - Queues clips for transcription/embedding

### Endpoints

**semantic-clip-search-tool:3100**
- POST /clip-paths - Resolve file paths from Media Cache
- POST /transcripts - Alias for /clip-paths (backward compatibility)
- POST /index - Queue timeline for indexing
- GET /status/progress - Overall system status
- GET /status/progress/:jobId - Job-specific progress

**backend:3001** (optional proxy)
- All endpoints proxy to :3100

## Log

### Part 1 - Flow Documentation
- Files: This file
- Notes: Documented complete request flow from plugin initialization through indexing
- Key insights:
  - Plugin calls /transcripts on load to resolve file paths
  - Server queries Adobe Media Cache SQLite databases
  - Database stores paths with spaces instead of slashes
  - File path reconstruction uses priority-based candidate matching
  - File extensions must be detected and given priority 100
  - Plugin matches resolved paths to clips by name, then sends to /index
  - /index endpoint queues clips for whisper.cpp transcription

### Part 2 - Remove Unused Code
- Status: **Documented - awaiting approval**
- See detailed cleanup plan: `cleanup-unused-code.md`
- Summary:
  - backend/server.js: ENTIRE FILE unused (~880 lines)
  - jsx/getClipFilePaths.jsx: Unused JSX approach (144 lines)
  - jsx/getSelectedClipPaths.jsx: Never referenced (183 lines)
  - main.js getFilePathsFromPremiere(): Never called (30 lines)
  - **Total: ~1,237 lines to remove**
- Risk: LOW - all provably unused, plugin connects directly to :3100
