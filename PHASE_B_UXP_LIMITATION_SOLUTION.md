# Phase B - Critical Discovery: ExtendScript Not Available in UXP

## The Problem

Premiere Pro 2023+ (v25.x) **does not support ExtendScript (`evaluateJSX`) in UXP panels**.

This is a fundamental architectural change that blocks:
- ✅ JSX script execution
- ✅ File system access (reading .prproj, cache files)
- ✅ Cache directory scanning
- ✅ Direct database queries

Your logs show:
```
main.js:149 ❌ ExtendScript (evaluateJSX) is not available in this Premiere Pro version.
main.js:150    This is a known limitation in Premiere Pro 2023+ UXP panels.
```

---

## Why Our Phase B Implementation Doesn't Work

All our extraction methods rely on file system access:

1. **ExtendScript API** - Requires `evaluateJSX` ❌
2. **XML Decompression** - Requires reading .prproj file ❌
3. **Cache Database Query** - Requires reading SQLite file ❌
4. **XMP Sidecar Search** - Requires file system scanning ❌

**UXP panels are sandboxed** and cannot access the file system directly.

---

## Solutions for Premiere Pro 2023+

### Solution 1: Use Node.js Backend (Recommended)

Create a local HTTP server that handles file operations:

**Architecture:**
```
UXP Plugin (Frontend)
    ↓ HTTP Request
Node.js Server (Backend on localhost:3000)
    ↓ File System Access
Media Cache DB + Transcript Files
    ↓ Parsed Data
UXP Plugin (Display Results)
```

**Implementation:**

```javascript
// backend-server.js (Node.js)
const express = require('express');
const sqlite3 = require('sqlite3');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json());

app.post('/transcripts', async (req, res) => {
  const { projectGuid } = req.body;

  // Query Media Cache database
  const dbPath = path.join(
    os.homedir(),
    'Library/Application Support/Adobe/Common/Media Cache Files',
    `StorySmith${projectGuid}.prmdc2`
  );

  const db = new sqlite3.Database(dbPath);

  db.all(`
    SELECT * FROM StringTable
    WHERE columnintrinsictranscriptstatus LIKE '%omplete%'
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json({ transcripts: rows });
    }
  });
});

app.listen(3000, () => {
  console.log('Transcript extraction server running on http://localhost:3000');
});
```

```javascript
// UXP Plugin (main.js)
async function extractTranscriptsViaBackend() {
  try {
    const project = await ppro.Project.getActiveProject();
    const projectGuid = '0cd64278-989c-4ce4-b7ce-d1bf99b9a19c'; // Extract from project

    const response = await fetch('http://localhost:3000/transcripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectGuid })
    });

    const data = await response.json();
    return data.transcripts;
  } catch (err) {
    console.error('Backend extraction failed:', err);
    return null;
  }
}
```

---

### Solution 2: CEP Extension Instead of UXP

Create a **CEP (Common Extensibility Platform) extension** which DOES have ExtendScript access:

**Differences:**
| Feature | UXP | CEP |
|---------|-----|-----|
| ExtendScript | ❌ No | ✅ Yes |
| File System | ❌ Sandboxed | ✅ Full access |
| Modern UI | ✅ Yes | ⚠️ HTML/CSS/JS |
| Future Support | ✅ Adobe's focus | ⚠️ Legacy |

**To Convert to CEP:**
1. Create `.debug` file for manifest
2. Add `CSInterface.js` library
3. Use `CSInterface.evalScript()` instead of `evaluateJSX`
4. Package as `.zxp` extension

---

### Solution 3: File System Plugin Permission (UXP v7+)

Request file system access in manifest:

```json
{
  "manifestVersion": 7,
  "requiredPermissions": [
    "fileSystemAccess",
    "localFileSystem",
    "webview",
    "network"
  ],
  "entrypoints": [{
    "type": "panel",
    "id": "storysmith",
    "permissions": {
      "fileSystem": {
        "mode": "readWrite"
      }
    }
  }]
}
```

Then use UXP File System API:

```javascript
const fs = require('uxp').storage.localFileSystem;

async function readTranscriptCache() {
  try {
    const homeFolder = await fs.getDataFolder();
    const cachePath = await homeFolder.getEntry(
      'Library/Application Support/Adobe/Common/Media Cache Files'
    );

    // Read files
    const files = await cachePath.getEntries();
    // ...
  } catch (err) {
    console.error('UXP file system access failed:', err);
  }
}
```

---

### Solution 4: User-Assisted File Selection

Let the user manually select the .prproj file:

```javascript
const fs = require('uxp').storage.localFileSystem;

async function extractWithUserHelp() {
  // Open file picker
  const file = await fs.getFileForOpening({
    types: ['prproj']
  });

  if (!file) {
    console.log('User cancelled');
    return;
  }

  // Read file
  const contents = await file.read({ format: storage.formats.binary });

  // Decompress and parse
  // ... (but still need Node.js for gzip/SQLite)
}
```

---

## Recommended Approach

**Hybrid Solution: UXP Frontend + Node.js Backend**

**Pros:**
- ✅ Keep modern UXP UI
- ✅ Full file system access via Node.js
- ✅ Can query SQLite databases
- ✅ Can scan cache directories
- ✅ Easy to debug and test
- ✅ Cross-platform compatible

**Cons:**
- ⚠️ Requires user to run backend server
- ⚠️ Extra setup step
- ⚠️ Need to package/distribute Node.js app

---

## Implementation Plan (Updated)

### Step 1: Create Node.js Backend

```bash
cd ~/Documents/storysmith-premiere
mkdir backend
cd backend
npm init -y
npm install express sqlite3 cors
```

Create `backend/server.js` with:
- `/health` - Check if server is running
- `/transcripts` - Extract transcripts from cache
- `/project-info` - Get project GUID from .prproj

### Step 2: Update UXP Plugin

Modify `main.js` to:
1. Check if backend is running (`fetch('http://localhost:3000/health')`)
2. Show setup instructions if not running
3. Call backend APIs instead of local file operations

### Step 3: User Setup

**First Time Setup:**
1. Download/install Node.js
2. Run `node backend/server.js` in terminal
3. Keep terminal open while using plugin

**Using Plugin:**
1. Open Premiere Pro
2. Load StorySmith panel
3. Click "Extract Transcripts"
4. Backend handles file operations
5. Results display in panel

---

## Alternative: Quick Test Without Backend

Since you have the transcript in Premiere, you can manually export it:

### Manual Export Method

1. **In Premiere Pro:**
   - Right-click the podcast.wav clip
   - Select "Transcribe Sequence" or "Speech to Text"
   - Once completed, go to: **Text Panel** (Window → Text)
   - Click the "..." menu → **Export Transcript**
   - Save as .srt, .vtt, or .txt file

2. **In StorySmith Plugin:**
   - Add "Import Transcript" button
   - Let user select the exported file
   - Parse and display

This bypasses all the cache extraction complexity!

---

## Updated Decision Tree

```
Need Transcripts from Premiere Pro?
│
├─ User can export manually?
│  └─ ✅ Add "Import Transcript" feature
│      (Simplest, works today)
│
├─ Need automatic extraction?
│  │
│  ├─ OK with Node.js backend?
│  │  └─ ✅ Implement hybrid solution
│  │      (Most powerful, requires setup)
│  │
│  └─ Want pure UXP solution?
│      ├─ Try UXP File System API
│      │  └─ ⚠️ May not have permissions
│      │
│      └─ Switch to CEP extension
│          └─ ⚠️ Legacy tech, full rebuild
│
└─ No Premiere transcripts available?
   └─ ✅ Use Whisper fallback
       (Already implemented)
```

---

## What I Recommend Right Now

### Option A: Quick Win (1 hour)
**Add "Import Transcript" button** that accepts:
- SRT files (Premiere export format)
- VTT files
- TXT files (plain text)
- JSON (your internal format)

User workflow:
1. Export transcript from Premiere (Text Panel → Export)
2. Click "Import" in StorySmith
3. Select file
4. Done!

### Option B: Full Solution (1-2 days)
**Build Node.js backend** for automatic extraction:
- Handles all file operations
- Queries cache databases
- Returns transcript data to UXP
- Professional solution

### Option C: Hybrid (2-3 hours)
**Both!** Start with Import, add backend later:
- Phase 1: Manual import (works immediately)
- Phase 2: Auto-detection via backend (enhanced experience)
- Users choose which method to use

---

## Next Steps

**Tell me which direction you want to go:**

1. **Quick Import Feature** - I'll add a file upload button
2. **Node.js Backend** - I'll create the server code
3. **Something Else** - What are your constraints/preferences?

The good news: Your Phase B research was 100% correct about WHERE transcripts are stored. We just need a different METHOD to access them in UXP.
