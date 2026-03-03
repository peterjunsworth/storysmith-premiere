# Progress: Fix fixFilePath to Handle Folder Names with Spaces

## Context

Adobe Premiere Pro's Media Cache database stores file paths with **all separators converted to spaces**. For example:
- Database value: `" Volumes Macintosh HD Users foo Media Card 1 file wav "`
- Expected output: `/Volumes/Macintosh HD/Users/foo/Media/Card 1/file.wav`

The current `fixFilePath` function ([backend/server.js:308-437](backend/server.js#L308-L437)) reconstructs these paths using a **forward-scanning greedy algorithm** that tests:
1. Single word (as-is)
2. Two words with hyphen (e.g., "storysmith-premiere")
3. Two words with dot (e.g., "file.wav")

**Problem**: This algorithm **breaks on legitimate folder names containing spaces** like "Card 1" or "My Project v2".

**Why it breaks**:
- When it encounters "Card 1", it tests "Card" first → doesn't exist
- Tests "Card-1" → doesn't exist
- Tests "Card.1" → doesn't exist
- Falls back to appending "Card/" alone, losing the "1"
- Result: `/path/to/Card/file.wav` (wrong) instead of `/path/to/Card 1/file.wav` (correct)

**Root cause**: The algorithm has **no pattern for multi-word folder names with spaces** — only hyphen and dot patterns.

## Recommended Solution

Implement a **hybrid backwards-prefix + forward-reconstruction algorithm** that:

1. **Phase 1 - Find Longest Valid Prefix**: Work backwards from the full path to find the longest existing path segment
2. **Phase 2 - Reconstruct Remaining**: Build forward from that prefix using prioritized multi-word strategies

### Key Algorithm Changes

#### Current Forward-Only Strategy (Lines 347-384, 398-433)
```javascript
while (idx < parts.length) {
  // Test: single word → hyphen → dot → fallback
  if (exists(parts[idx])) { ... }
  else if (exists(parts[idx] + '-' + parts[idx+1])) { ... }
  else if (exists(parts[idx] + '.' + parts[idx+1])) { ... }
  else { append(parts[idx]); } // PROBLEM: loses multi-word names
}
```

#### New Backwards + Forward Strategy
```javascript
// Phase 1: Find longest existing prefix by working backwards
function findLongestValidPrefix(parts, basePrefix, startIdx) {
  for (let endIdx = parts.length; endIdx >= startIdx; endIdx--) {
    const testPath = basePrefix + '/' + parts.slice(startIdx, endIdx).join('/');
    if (fs.existsSync(testPath)) {
      return { validPrefix: testPath, remainingIdx: endIdx };
    }
  }
  return { validPrefix: basePrefix, remainingIdx: startIdx };
}

// Phase 2: Reconstruct with prioritized multi-word strategies
while (idx < remaining.length) {
  const candidates = [
    // Prioritize longer matches first
    { len: 4, path: join(' ', 4), priority: 5 },  // "My Project v2 Final"
    { len: 3, path: join(' ', 3), priority: 4 },  // "My Project v2"
    { len: 2, path: join(' ', 2), priority: 3 },  // "Card 1" ✓ NEW!
    { len: 2, path: join('-', 2), priority: 2 },  // "storysmith-premiere"
    { len: 2, path: join('.', 2), priority: 2 },  // "file.wav"
    { len: 1, path: single,       priority: 1 }   // "Users"
  ];

  // Test candidates in priority order (longest first)
  for (const candidate of candidates.sort(...)) {
    if (fs.existsSync(candidate.path)) {
      currentPath = candidate.path;
      idx += candidate.len;
      break;
    }
  }
}
```

### Why This Works

**Example: "Volumes Macintosh HD Users foo Media Card 1 file wav"**

**Phase 1 - Backwards Scan**:
```
Test: /Volumes/Macintosh HD/Users/foo/Media/Card/1/file/wav  → ✗
Test: /Volumes/Macintosh HD/Users/foo/Media/Card/1/file      → ✗
Test: /Volumes/Macintosh HD/Users/foo/Media/Card/1           → ✗
Test: /Volumes/Macintosh HD/Users/foo/Media/Card             → ✗
Test: /Volumes/Macintosh HD/Users/foo/Media                  → ✓ EXISTS!

Result: validPrefix = "/Volumes/.../Media"
        remaining = ["Card", "1", "file", "wav"]
```

**Phase 2 - Forward Reconstruction**:
```
At idx=0 ("Card"):
  Try 4-word space: "Media/Card 1 file wav"     → ✗
  Try 3-word space: "Media/Card 1 file"         → ✗
  Try 2-word space: "Media/Card 1"              → ✓ EXISTS! (consume 2 parts)

currentPath = "/Volumes/.../Media/Card 1"
remaining = ["file", "wav"]

At idx=2 ("file"):
  Try 2-word space: "Card 1/file wav"           → ✗
  Try 2-word hyphen: "Card 1/file-wav"          → ✗
  Try 2-word dot: "Card 1/file.wav"             → ✓ EXISTS! (consume 2 parts)

Final: "/Volumes/.../Media/Card 1/file.wav" ✓ CORRECT
```

## Critical Files

### 1. `/backend/server.js` (Lines 308-437) - Primary Implementation
**Changes Required**:
- Add `findLongestValidPrefix()` helper function
- Add `generateCandidates()` helper function with 6 strategies (1-4 word combinations)
- Replace forward-scan loops (lines 347-384, 398-433) with two-phase algorithm
- Keep volume name handling (lines 317-340) as-is — already handles "Macintosh HD" correctly

### 2. `/semantic-clip-search-tool/src/api/routes/clip-paths.ts` (Lines 240-350)
**Changes Required**:
- Port same algorithm to TypeScript for consistency
- Duplicate `fixFilePath` implementation exists here with identical logic
- Ensure both implementations stay synchronized

## Performance Considerations

**Current Algorithm**:
- O(3n) filesystem checks: single + hyphen + dot per position
- ~30ms worst case per path (3 checks × 10ms)

**New Algorithm**:
- Phase 1: O(n) backwards scan
- Phase 2: O(6n) forward reconstruction (6 strategies per position)
- Total: O(7n) worst case
- ~70ms worst case per path (7 checks × 10ms)

**Mitigation**: Add optional path existence caching for repeated API calls:
```javascript
const pathExistsCache = new Map();

function cachedExistsSync(path) {
  if (pathExistsCache.has(path)) return pathExistsCache.get(path);
  const exists = fs.existsSync(path);
  pathExistsCache.set(path, exists);
  return exists;
}
```

With caching, typical case reduces to ~40ms per path.

## Backward Compatibility

✓ **Preserves existing behavior** for currently working paths:
- Hyphenated folders: "storysmith-premiere" → `/storysmith-premiere`
- File extensions: "file.wav" → `/file.wav`
- Multi-word volumes: "Macintosh HD" → `/Macintosh HD`

✓ **Adds support** for space-separated folder names:
- "Card 1" → `/Card 1`
- "My Project v2" → `/My Project v2`
- "Audio Files" → `/Audio Files`

✓ **Same API contract**: `string → string`, called at:
- [backend/server.js:265](backend/server.js#L265) - `/transcripts` endpoint
- [semantic-clip-search-tool/src/api/routes/clip-paths.ts:160](semantic-clip-search-tool/src/api/routes/clip-paths.ts#L160) - `/clip-paths` POST

## Verification

**Manual Testing**:
1. Create test folder structure: `/tmp/test-paths/Card 1/file.wav`
2. Test with input: `"tmp test-paths Card 1 file wav"`
3. Verify output: `/tmp/test-paths/Card 1/file.wav`

**Edge Cases to Test**:
```javascript
// Existing working cases (must still work)
"Volumes Macintosh HD Users foo storysmith premiere"
  → "/Volumes/Macintosh HD/Users/foo/storysmith-premiere" ✓

"Volumes Macintosh HD Users foo file wav"
  → "/Volumes/Macintosh HD/Users/foo/file.wav" ✓

// New space-separated cases (should now work)
"Volumes Macintosh HD Users foo Card 1 file wav"
  → "/Volumes/Macintosh HD/Users/foo/Card 1/file.wav" ✓

"Volumes Macintosh HD Users foo My Project v2 audio mp3"
  → "/Volumes/Macintosh HD/Users/foo/My Project v2/audio.mp3" ✓

// Mixed separators
"Volumes Macintosh HD storysmith premiere Card 1 test wav"
  → "/Volumes/Macintosh HD/storysmith-premiere/Card 1/test.wav" ✓

// Non-existent paths (fallback behavior)
"Volumes Macintosh HD nonexistent path"
  → "/Volumes/Macintosh HD/nonexistent/path" (best effort)

// Empty/null inputs
"" → ""
null → ""
```

**Integration Testing**:
1. Query actual Premiere Pro Media Cache database
2. Call `/transcripts` API endpoint
3. Verify returned `filePath` values match actual filesystem locations
4. Test with project containing folders like "Card 1", "Take 2", "Scene 3 Final"

**Performance Testing**:
1. Benchmark with 100 paths from real database
2. Measure before/after response times
3. Verify < 100ms per path (acceptable for API responses)
4. Monitor cache hit rates if caching implemented
