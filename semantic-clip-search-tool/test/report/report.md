# Semantic Search Benchmark Report

**Run:** 2026-02-25T16:31:44.010Z  
**Duration:** 0.9s

## Summary

| Metric | Value |
|--------|-------|
| Scenarios passed (all 3 criteria) | 0/6 |
| Hit@1 (correct clip in top-1) | 0/6 (0%) |
| Hit@3 (correct clip in top-3) | 0/6 (0%) |
| Timestamp window accuracy | 0% |
| Key-phrase match rate | 0% |
| Avg cosine similarity score | 0 |
| Avg transcript WER | 100.0% |

## Transcript Accuracy

> Compares whisper.cpp output (stored in ChromaDB) against the reference Gutenberg text for key passages.

| Clip | Ref words | Gen words | WER | Overlap |
|------|-----------|-----------|-----|---------|
| clip_bench_ch08 | 0 | 0 | N/A | 0% |
| clip_bench_ch18 | 0 | 0 | N/A | 0% |
| clip_bench_ch29 | 0 | 0 | N/A | 0% |

<details>
<summary>Sample text comparison — clip_bench_ch08</summary>

**Reference:**
```

```

**Generated (whisper.cpp):**
```
ERROR: ENOENT: no such file or directory, open '/Users/peterunsworth/Documents/storysmith-premiere/semantic-clip-search-tool/test/fixtures/transcripts/clip-ch08-reference.txt'
```
</details>

## Search Scenarios

### [S1] Huck hiding still watching the search party pass by on the island

**Status:** ❌ FAIL

| Field | Value |
|-------|-------|
| Query | `person hiding quietly in the woods watching people search nearby` |
| Expected clip | `clip_bench_ch08` |
| Top-1 clip | `none` |
| Cosine score | N/A |
| Chunk in clip (ms) | N/A |
| Clip-relative position | N/A |
| Absolute Premiere position | N/A |
| Clip timeline offset | 0:00 (0s) |
| In correct clip | ✗ |
| In time window | ✗ |
| Key phrase matched | ✗ |
| Top-3 clip IDs |  |

### [S2] Jim mistakes Huck for a ghost and begs him not to harm him

**Status:** ❌ FAIL

| Field | Value |
|-------|-------|
| Query | `man thinks someone is a ghost and begs not to be hurt` |
| Expected clip | `clip_bench_ch08` |
| Top-1 clip | `none` |
| Cosine score | N/A |
| Chunk in clip (ms) | N/A |
| Clip-relative position | N/A |
| Absolute Premiere position | N/A |
| Clip timeline offset | 0:00 (0s) |
| In correct clip | ✗ |
| In time window | ✗ |
| Key phrase matched | ✗ |
| Top-3 clip IDs |  |

### [S3] Colonel Grangerford described as a tall, slim, aristocratic gentleman

**Status:** ❌ FAIL

| Field | Value |
|-------|-------|
| Query | `description of a gentleman who was tall slim aristocratic with dark eyes` |
| Expected clip | `clip_bench_ch18` |
| Top-1 clip | `none` |
| Cosine score | N/A |
| Chunk in clip (ms) | N/A |
| Clip-relative position | N/A |
| Absolute Premiere position | N/A |
| Clip timeline offset | 23:09 (1389s) |
| In correct clip | ✗ |
| In time window | ✗ |
| Key phrase matched | ✗ |
| Top-3 clip IDs |  |

### [S4] Buck explains how a feud works and lists casualties on both sides

**Status:** ❌ FAIL

| Field | Value |
|-------|-------|
| Query | `someone explaining how a feud starts with a quarrel and killing on both sides` |
| Expected clip | `clip_bench_ch18` |
| Top-1 clip | `none` |
| Cosine score | N/A |
| Chunk in clip (ms) | N/A |
| Clip-relative position | N/A |
| Absolute Premiere position | N/A |
| Clip timeline offset | 23:09 (1389s) |
| In correct clip | ✗ |
| In time window | ✗ |
| Key phrase matched | ✗ |
| Top-3 clip IDs |  |

### [S5] Imposters claiming to be the real Harvey Wilks when the actual relatives arrive

**Status:** ❌ FAIL

| Field | Value |
|-------|-------|
| Query | `two men pretending to be relatives while the real relatives confront them` |
| Expected clip | `clip_bench_ch29` |
| Top-1 clip | `none` |
| Cosine score | N/A |
| Chunk in clip (ms) | N/A |
| Clip-relative position | N/A |
| Absolute Premiere position | N/A |
| Clip timeline offset | 50:41 (3041s) |
| In correct clip | ✗ |
| In time window | ✗ |
| Key phrase matched | ✗ |
| Top-3 clip IDs |  |

### [S6] Huck escapes in the dark after the gold is found in the coffin at the graveyard

**Status:** ❌ FAIL

| Field | Value |
|-------|-------|
| Query | `person escaping through a storm at night running away from a crowd` |
| Expected clip | `clip_bench_ch29` |
| Top-1 clip | `none` |
| Cosine score | N/A |
| Chunk in clip (ms) | N/A |
| Clip-relative position | N/A |
| Absolute Premiere position | N/A |
| Clip timeline offset | 50:41 (3041s) |
| In correct clip | ✗ |
| In time window | ✗ |
| Key phrase matched | ✗ |
| Top-3 clip IDs |  |
