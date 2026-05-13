# Cleanup Plan: Remove Unused File Path Resolution Code

## Summary
The plugin connects directly to `semantic-clip-search-tool:3100`. The `backend:3001` proxy server and JSX-based file path resolution are completely unused.

## Files to Delete

### 1. backend/server.js (ENTIRE FILE - 880+ lines)
**Reason**: Plugin connects directly to :3100, proxy is unused

Key unused functionality:
- POST /transcripts (line 93) - Duplicate of semantic-clip-search-tool endpoint
- fixFilePath() function (line 557) - Duplicate implementation
- POST /index proxy (line 788) - Unused proxy
- GET /status/progress proxies - Unused
- POST /webhook-proxy - Unused

**Evidence**: 
- `StorySmith-v1/main.js:10` sets `SERVER_URL = "http://localhost:3100"`
- All plugin requests go directly to :3100

**Action**: Delete entire file or move to `backend/DEPRECATED/`

### 2. StorySmith-v1/jsx/getClipFilePaths.jsx (144 lines)
**Reason**: User explicitly rejected JSX approach, function never called

Functionality:
- Traverses Premiere project items via ExtendScript
- Gets file paths using `item.getMediaPath()`, `item.file.fsName`
- Returns JSON with clip names and file paths

**Evidence**:
- Referenced only by unused `getFilePathsFromPremiere()` in main.js
- User feedback: "instead of using the JSX approach - first just fix the file path creation"

**Action**: Delete file

### 3. StorySmith-v1/jsx/getSelectedClipPaths.jsx (183 lines)
**Reason**: Never referenced anywhere in codebase

Functionality:
- Similar to getClipFilePaths but for selected items only
- Uses `app.project.getSelection()`

**Evidence**:
- `grep -rn "getSelectedClipPaths"` returns no results

**Action**: Delete file

### 4. StorySmith-v1/main.js lines 26-55 (getFilePathsFromPremiere function)
**Reason**: Never called, reads deleted JSX file

Function signature:
```javascript
async function getFilePathsFromPremiere() {
  const jsxPath = path.join(__dirname, 'jsx', 'getClipFilePaths.jsx');
  const jsxScript = fs.readFileSync(jsxPath, 'utf-8');
  const result = await ppro.evalES(jsxScript);
  // ... parse and return results
}
```

**Evidence**:
- Function defined but never invoked
- Would fail after deleting `jsx/getClipFilePaths.jsx`

**Action**: Delete function (lines 26-55)

## Files to Keep (Active Code)

### semantic-clip-search-tool/src/api/routes/clip-paths.ts ✓
- POST /clip-paths handler (line 13)
- fixFilePath() function (line 396)
- generateCandidates() (line 276)
- reconstructPath() (line 368)
- Used by plugin's POST /transcripts requests

### semantic-clip-search-tool/src/api/server.ts ✓
- Main server on :3100
- Routes /transcripts → /clip-paths for backward compatibility

### StorySmith-v1/main.js ✓
- loadClipsFromProject() - calls /transcripts endpoint
- sendToWebhook() - calls /index endpoint
- (After removing getFilePathsFromPremiere function)

## Execution Order

1. Delete `backend/server.js` (or move to DEPRECATED/)
2. Delete `StorySmith-v1/jsx/getClipFilePaths.jsx`
3. Delete `StorySmith-v1/jsx/getSelectedClipPaths.jsx`
4. Remove lines 26-55 from `StorySmith-v1/main.js`
5. Update documentation to reflect single server architecture

## Risk Assessment

**LOW RISK**: All deletions are of provably unused code
- Plugin SERVER_URL hardcoded to :3100
- grep confirms no references to deleted functions/files
- User explicitly rejected JSX approach

**No impact on**:
- File path resolution (uses semantic-clip-search-tool)
- Clip indexing (uses semantic-clip-search-tool)
- Search functionality
- Plugin UI

## Estimated Line Count Reduction
- backend/server.js: ~880 lines
- jsx/getClipFilePaths.jsx: 144 lines
- jsx/getSelectedClipPaths.jsx: 183 lines
- main.js function: 30 lines
- **Total: ~1,237 lines removed**
