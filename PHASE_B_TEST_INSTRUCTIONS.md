# Phase B Test Instructions

## Testing the Transcript Extraction

You mentioned you have a transcription in Premiere Pro already. Let's test if the new extraction method works!

### Quick Test (2 minutes)

1. **Make sure Premiere Pro is open** with your StorySmith project loaded
2. **Open the StorySmith UXP panel** in Premiere Pro (Window → Extensions → StorySmith-v1)
3. **Click the "Extract Transcripts" button** in the panel
4. **Check the results** displayed in the panel

### What to Look For

The extraction will try 3 methods in order:

**Method 1: Premiere ExtendScript API** (NEW - what we just added)
- This queries Premiere directly for transcript data
- Look for console messages starting with "🎬 METHOD 1"
- If successful, you'll see: "✅ Found X transcript(s) via Premiere API"

**Method 2: .prproj File XML**
- Searches the decompressed project XML
- We know this won't work (transcripts not in XML)

**Method 3: Cache Directory Search**
- Searches Adobe's transcript cache directories
- We know the directories are empty in your case

### Expected Results

Since you have a transcription, Method 1 should either:

**Best Case:** Extract the transcript successfully
```
✅ Extraction Successful!
📊 Method: Premiere ExtendScript API
📝 Source: Direct API access
📄 Found X transcript(s)
```

**Or:** Find the transcript status but not the actual text
```
⚠️ No Transcripts Found
ℹ️ Transcript marked as completed but data not directly accessible
💡 Check ~/Library/Application Support/Adobe/Common/MetadataIndexer/Transcripts-1/
```

### Console Inspection

For detailed logs:

1. **Right-click** on the StorySmith panel
2. **Select "Inspect"** or "Inspect Element"
3. **Go to the Console tab**
4. **Look for the extraction logs** (they're very detailed)

The console will show exactly what the script found and where it looked.

### What the Script Checks

The new `extractTranscripts.jsx` script checks:

1. **XMP Metadata** - `projectItem.getXMPMetadata()` for transcript tags
2. **Direct Property** - `projectItem.transcript` (if it exists)
3. **Markers** - `projectItem.getMarkers()` for transcript-labeled markers
4. **Attachments** - `projectItem.attachments` for .srt/.vtt files
5. **Transcription Status** - `projectItem.transcriptionStatus` for completed flag

It checks:
- All clips in the active sequence (audio + video tracks)
- All project items recursively in the project bin

### After Testing - Report Back

Please share:

1. **What the panel shows** (success/warning/error message)
2. **Console output** (copy the relevant lines starting with 🎬 or 📦)
3. **Which method worked** (if any)

### If It Doesn't Work

Don't worry! That's valuable information. It means:

1. Premiere's transcript data is **truly only in cache files** (not exposed via API)
2. We need to focus on the cache file extraction method
3. We'll need to solve the GUID mapping problem

In that case, we'd use the **hybrid approach**:
- Use the Media Cache database to find "Completed" transcripts ✅ (already works)
- Map those to the cache GUID directories
- Read the actual transcript files

---

## Alternative: Check Premiere Manually

If you want to verify the transcript exists in Premiere:

1. Open Premiere Pro with StorySmith.prproj
2. Find the podcast.wav clip in your project
3. Right-click → "Transcribe"
4. Does it show the transcript text?
5. Can you export it (File → Export → Captions)?

If yes, then the transcript definitely exists - we just need to find the right API to access it!

---

## Quick Manual Test of JSX Script

You can also test the JSX script directly:

1. In Premiere Pro: **File → Scripts → Run Script...**
2. Navigate to: `/Users/peterunsworth/Documents/storysmith-premiere/StorySmith-v1/jsx/extractTranscripts.jsx`
3. Click **Open**
4. Check what result you get

This bypasses the UXP plugin and tests the ExtendScript directly.

---

Let me know what you find!
