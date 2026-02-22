# Semantic Search Benchmark Report

**Run:** 2026-02-18T22:39:02.896Z  
**Duration:** 52.3s

## Summary

| Metric | Value |
|--------|-------|
| Scenarios passed (all 3 criteria) | 3/6 |
| Hit@1 (correct clip in top-1) | 5/6 (83%) |
| Hit@3 (correct clip in top-3) | 5/6 (83%) |
| Timestamp window accuracy | 60% |
| Key-phrase match rate | 83% |
| Avg cosine similarity score | 0.6672 |
| Avg transcript WER | 100.0% |

## Transcript Accuracy

> Compares whisper.cpp output (stored in ChromaDB) against the reference Gutenberg text for key passages.

| Clip | Ref words | Gen words | WER | Overlap |
|------|-----------|-----------|-----|---------|
| clip_bench_ch08 | 1209 | 5615 | 100.0% | 77% |
| clip_bench_ch18 | 1141 | 5924 | 100.0% | 94% |
| clip_bench_ch29 | 1166 | 4679 | 100.0% | 85% |

<details>
<summary>Sample text comparison — clip_bench_ch08</summary>

**Reference:**
```
I woke up, and turned over. The sun was away up high, and there was that noise and stir going on again. I rubbed my eyes and looked around, scared. Then I remembered. The river looked miles and miles 
```

**Generated (whisper.cpp):**
```
The Adventures of Huckleberry Finn by Mark Twain. The sun was up so high when I waited, that I had judged it was after eight o'clock. I laid there in the grass in the cool shade, thinking about things
```
</details>

## Search Scenarios

### [S1] Huck hiding still watching the search party pass by on the island

**Status:** ❌ FAIL

| Field | Value |
|-------|-------|
| Query | `person hiding quietly in the woods watching people search nearby` |
| Expected clip | `clip_bench_ch08` |
| Top-1 clip | `clip_bench_ch18` |
| Cosine score | 0.593 |
| Chunk in clip (ms) | 337320–383880ms |
| Clip-relative position | 5:37 (337s) |
| Absolute Premiere position | 28:46 (1726s) |
| Clip timeline offset | 0:00 (0s) |
| In correct clip | ✗ |
| In time window | ✗ |
| Key phrase matched | ✗ |
| Top-3 clip IDs | clip_bench_ch18, clip_bench_ch18, clip_bench_ch18 |

**Matched chunk:**
```
road. Buck says, "Quick! Jump for the woods!" We done it, and then peeped down the woods through the leaves. Pretty soon a splendid young man come galloping down the road, setting his horse easy and looking like a soldier. He had a gun across his pommel. I had seen him before. It was young Harney Shepherdson. I heard Buck's gun go off in my ear, and Harney's hat tumbled off from his head. He grabb...
```

### [S2] Jim mistakes Huck for a ghost and begs him not to harm him

**Status:** ✅ PASS

| Field | Value |
|-------|-------|
| Query | `man thinks someone is a ghost and begs not to be hurt` |
| Expected clip | `clip_bench_ch08` |
| Top-1 clip | `clip_bench_ch08` |
| Cosine score | 0.7279 |
| Chunk in clip (ms) | 682200–720400ms |
| Clip-relative position | 11:22 (682s) |
| Absolute Premiere position | 11:22 (682s) |
| Clip timeline offset | 0:00 (0s) |
| In correct clip | ✓ |
| In time window | ✓ |
| Key phrase matched | ✓ |
| Top-3 clip IDs | clip_bench_ch08, clip_bench_ch08, clip_bench_ch18 |

**Matched chunk:**
```
and puts his hand together and says, "Don't hurt me, don't. I ain't never done no harm to a ghost. I always like dead people, and done all I could for 'em. You go and get into River again what you belongs, and don't do nothin' to old Jim. I was always your friend." "Well, I weren't long makin' him understand I weren't dead. I was ever so glad to see Jim. I weren't lonesome now. I told him I weren'...
```

### [S3] Colonel Grangerford described as a tall, slim, aristocratic gentleman

**Status:** ✅ PASS

| Field | Value |
|-------|-------|
| Query | `description of a gentleman who was tall slim aristocratic with dark eyes` |
| Expected clip | `clip_bench_ch18` |
| Top-1 clip | `clip_bench_ch18` |
| Cosine score | 0.7347 |
| Chunk in clip (ms) | 53360–91560ms |
| Clip-relative position | 0:53 (53s) |
| Absolute Premiere position | 24:02 (1443s) |
| Clip timeline offset | 23:09 (1389s) |
| In correct clip | ✓ |
| In time window | ✓ |
| Key phrase matched | ✓ |
| Top-3 clip IDs | clip_bench_ch18, clip_bench_ch18, clip_bench_ch18 |

**Matched chunk:**
```
was very tall and very slim, and had a darkish paly complexion, not a sign of red in it anywhere. He was clean-shaved every morning all over his thin face, and he had the thinnest kind of lips, and the thinnest kind of nostrils and a high nose and heavy eyebrows, and the blackest kind of eyes sunk so deep back that they seemed like they were looking out of caverns at you, as you may say. His foreh...
```

### [S4] Buck explains how a feud works and lists casualties on both sides

**Status:** ⚠️  PARTIAL

| Field | Value |
|-------|-------|
| Query | `someone explaining how a feud starts with a quarrel and killing on both sides` |
| Expected clip | `clip_bench_ch18` |
| Top-1 clip | `clip_bench_ch18` |
| Cosine score | 0.7573 |
| Chunk in clip (ms) | 439920–490840ms |
| Clip-relative position | 7:19 (440s) |
| Absolute Premiere position | 30:29 (1829s) |
| Clip timeline offset | 23:09 (1389s) |
| In correct clip | ✓ |
| In time window | ✗ |
| Key phrase matched | ✓ |
| Top-3 clip IDs | clip_bench_ch18, clip_bench_ch18, clip_bench_ch18 |

**Matched chunk:**
```
him, Buck?" "Well, I bet I did. What did he do to you?" "Him? He never done nothing to me." "Well, then, what did you want to kill him for?" "What, nothing? Only it's on account of the feud." "What's the feud? Why, where was you raised? Don't you know what a feud is?" "Never heard of it before. Tell me about it." "Well," says Buck, "a feud is this way. A man has a quarrel with another man and kill...
```

### [S5] Imposters claiming to be the real Harvey Wilks when the actual relatives arrive

**Status:** ⚠️  PARTIAL

| Field | Value |
|-------|-------|
| Query | `two men pretending to be relatives while the real relatives confront them` |
| Expected clip | `clip_bench_ch29` |
| Top-1 clip | `clip_bench_ch29` |
| Cosine score | 0.615 |
| Chunk in clip (ms) | 482560–513800ms |
| Clip-relative position | 8:02 (483s) |
| Absolute Premiere position | 58:43 (3524s) |
| Clip timeline offset | 50:41 (3041s) |
| In correct clip | ✓ |
| In time window | ✗ |
| Key phrase matched | ✓ |
| Top-3 clip IDs | clip_bench_ch29, clip_bench_ch29, clip_bench_ch29 |

**Matched chunk:**
```
And so they kept it up and kept it up, and it was the worst mixed-up thing you ever see. They made the king tell his yarn, and they made the old gentleman tell his, and anybody but a lot of prejudiced chuckleheads would have seen that the old gentleman was spinning in truth, and the other one lies, and by and by they had me up to tell what I know'd. The king, he gave me a left-handed look out of t...
```

### [S6] Huck escapes in the dark after the gold is found in the coffin at the graveyard

**Status:** ✅ PASS

| Field | Value |
|-------|-------|
| Query | `person escaping through a storm at night running away from a crowd` |
| Expected clip | `clip_bench_ch29` |
| Top-1 clip | `clip_bench_ch29` |
| Cosine score | 0.5752 |
| Chunk in clip (ms) | 1087360–1129960ms |
| Clip-relative position | 18:07 (1087s) |
| Absolute Premiere position | 68:48 (4129s) |
| Clip timeline offset | 50:41 (3041s) |
| In correct clip | ✓ |
| In time window | ✓ |
| Key phrase matched | ✓ |
| Top-3 clip IDs | clip_bench_ch29, clip_bench_ch08, clip_bench_ch29 |

**Matched chunk:**
```
the flicker of the lightning, and sent a man to the nearest house, a half mile off, to borrow one. So they dug and dug like everything, and it got awful dark, and the rain started, and the wind swished and swooshed along, and the lightning come brisker and brisker, and the thunder boomed, but then people never took no notice of it. They were so full of this business, and one minute you could see e...
```
