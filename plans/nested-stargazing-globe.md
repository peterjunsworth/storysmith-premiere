# Plan: Add "View in Sequence" Button to Search Results

## Context

When users search for moments in their sequences, they receive results showing where specific content appears. However, there's currently no way to jump directly to those moments in Premiere Pro. Users must manually:
1. Remember the sequence name
2. Switch to that sequence in Premiere
3. Navigate to the correct timecode

This plan adds a "View in Sequence" button next to each search result that will:
- Make the matching sequence active in Premiere Pro
- Navigate the playhead to the exact timecode where the result appears

## Current State

### Existing Implementation
- **File**: `StorySmith-v1/main.js`
- Search results display sequence name, timecode range (in/out), clip name, and transcript snippet
- Click handlers exist (lines 1117-1124) but only log to console - no actual navigation
- Comment states: `// Navigation to Premiere sequences is not implemented here`

### Available Data
Each search result has:
- `clipId`: Unique identifier for the clip
- `absoluteStart`: Start timecode in seconds (used for navigation target)
- `absoluteEnd`: End timecode in seconds
- Sequence name (looked up from `allClips` array)

### Premiere Pro API Available
From exploration, the UXP API provides:
- `ppro.Project.getActiveProject()` - Get current project
- `project.getSequences()` - Get all sequences
- `sequence.name` - Sequence name for matching
- Time is returned in format with `.seconds` and `.ticks` properties

## Research Needed

**Critical**: Determine the correct Premiere Pro UXP API methods during implementation.

The exploration revealed:
- ✅ We can READ sequence data (`project.getSequences()`)
- ✅ We can GET the active sequence (`project.activeSequence`)
- ❌ No existing code for SETTING the active sequence
- ❌ No existing code for NAVIGATING to a timecode

**API Methods to Research During Implementation**:
1. Method to open/activate a different sequence
   - Likely candidates: `sequence.openInTimeline()`, `project.setActiveSequence(sequence)`, or `sequence.setAsActive()`
2. Method to set the playhead position to a specific timecode
   - Likely candidates: `sequence.setPlayerPosition(seconds)`, `sequence.setPlayheadPosition()`, or `app.setPlayheadPosition()`
3. Whether time needs to be in seconds, ticks, or a Time object

**Research Sources**:
- Official Adobe Premiere Pro UXP API documentation
- Adobe Developer Forums
- Examine other Premiere UXP extensions for reference patterns
- Test directly in Premiere Pro to verify API behavior

## Implementation Plan

### Phase 1: Research API Methods (FIRST STEP - DO NOT SKIP)
**Before writing any code**, research and verify the correct Premiere Pro UXP API calls:

1. Check official Adobe Premiere Pro UXP API documentation for:
   - How to activate/open a sequence programmatically
   - How to set playhead position to a specific timecode in seconds
   - Required parameter format (seconds vs ticks vs Time object)

2. If UXP API doesn't support these operations:
   - Check if ExtendScript JSX approach is needed
   - Look at `app.project.openSequence()` or similar ExtendScript methods

3. Test API calls in Premiere Pro to verify they work before full implementation

**Deliverable**: Document the exact API calls to use with code examples

### Phase 2: UI Changes

**File**: `StorySmith-v1/main.js` (lines ~1095-1118)

Update the search results HTML to include a button:

```javascript
resultsHtml += `
  <div class="search-result-item" data-clipid="${escapeHtml(hit.clipId || '')}" data-timecode="${hit.absoluteStart || 0}">
    <div class="search-result-content">
      <div class="search-result-title">${escapeHtml(sequenceName)}</div>
      <div class="search-result-details">
        ${inTimecode && outTimecode ? `⏱️ ${inTimecode} - ${outTimecode}` : ''}
        ${clipName ? ` • 🎬 ${escapeHtml(clipName)}` : ''}
      </div>
      ${snippet ? `<div class="search-result-snippet">${escapeHtml(snippet)}</div>` : ''}
    </div>
    <button class="view-in-sequence-btn"
            data-sequence-name="${escapeHtml(sequenceName)}"
            data-timecode="${hit.absoluteStart || 0}">
      View in Sequence
    </button>
  </div>
`;
```

**Changes**:
- Wrap existing content in `.search-result-content` div for flex layout
- Add button with sequence name and timecode in data attributes
- Button positioned on far right of result item

### Phase 3: CSS Styling

**File**: `StorySmith-v1/style.css` (after line ~495)

Add styles for the new button and updated layout:

```css
/* Search Result Item - Flex Layout */
.search-result-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  transition: background 0.15s;
}

.search-result-content {
  flex: 1;
  min-width: 0; /* Allow text truncation */
}

/* View in Sequence Button */
.view-in-sequence-btn {
  flex-shrink: 0;
  background: rgba(13, 102, 208, 0.2);
  color: #0d66d0;
  border: 1px solid rgba(13, 102, 208, 0.4);
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.view-in-sequence-btn:hover {
  background: rgba(13, 102, 208, 0.3);
  border-color: rgba(13, 102, 208, 0.6);
}

.view-in-sequence-btn:active {
  background: rgba(13, 102, 208, 0.4);
}
```

### Phase 4: Navigation Logic

**File**: `StorySmith-v1/main.js`

Add event handlers for the "View in Sequence" buttons (after line ~1124):

```javascript
// Add click handlers to "View in Sequence" buttons
const viewButtons = resultsContent.querySelectorAll(".view-in-sequence-btn");
viewButtons.forEach(button => {
  button.addEventListener("click", async (e) => {
    e.stopPropagation(); // Prevent parent click handler

    const sequenceName = button.getAttribute("data-sequence-name");
    const timecode = parseFloat(button.getAttribute("data-timecode") || "0");

    try {
      await navigateToSequence(sequenceName, timecode);
    } catch (error) {
      console.error("Failed to navigate to sequence:", error);
      // Show error to user (could add status display)
    }
  });
});
```

Add new navigation function (API calls TBD based on research):

```javascript
/**
 * Navigate to a specific sequence and timecode in Premiere Pro
 * @param {string} sequenceName - Name of the sequence to activate
 * @param {number} timecodeSeconds - Timecode in seconds to navigate to
 */
async function navigateToSequence(sequenceName, timecodeSeconds) {
  const ppro = require("premierepro");
  const project = await ppro.Project.getActiveProject();
  const sequences = await project.getSequences();

  // Find the matching sequence by name
  let targetSequence = null;
  for (let i = 0; i < sequences.length; i++) {
    const seq = sequences[i];
    if (seq.name === sequenceName) {
      targetSequence = seq;
      break;
    }
  }

  if (!targetSequence) {
    throw new Error(`Sequence "${sequenceName}" not found in project`);
  }

  // TODO: Replace with actual API calls once research is complete
  // Method 1 (if UXP supports it):
  //   await targetSequence.openInTimeline();
  //   await targetSequence.setPlayerPosition(timecodeSeconds);

  // Method 2 (if ExtendScript required):
  //   await callExtendScript('navigateToSequence.jsx', {
  //     sequenceName,
  //     timecodeSeconds
  //   });

  console.log(`✅ Navigated to "${sequenceName}" at ${formatTimecode(timecodeSeconds)}`);
}
```

### Phase 5: ExtendScript Implementation (If Needed)

If UXP doesn't support sequence activation/navigation, create:

**File**: `StorySmith-v1/jsx/navigateToSequence.jsx`

```javascript
// ExtendScript to activate sequence and navigate to timecode
// This would use app.project.activeSequence setter if available

var targetSequenceName = params.sequenceName;
var timecodeSeconds = params.timecodeSeconds;

var project = app.project;
var sequences = project.sequences;

// Find and activate the sequence
for (var i = 0; i < sequences.numSequences; i++) {
  var seq = sequences[i];
  if (seq.name === targetSequenceName) {
    // Activate sequence (API method TBD)
    app.project.activeSequence = seq; // or seq.setAsActive() etc.

    // Set playhead position (API method TBD)
    seq.setPlayerPosition(timecodeSeconds); // or similar

    return { success: true };
  }
}

return { success: false, error: "Sequence not found" };
```

Then call it from main.js using the existing pattern seen in other `.jsx` files.

## Critical Files to Modify

1. **`StorySmith-v1/main.js`** (lines ~1095-1124)
   - Update search results HTML structure
   - Add event handlers for "View in Sequence" buttons
   - Implement `navigateToSequence()` function

2. **`StorySmith-v1/style.css`** (after line ~495)
   - Add `.search-result-item` flex layout
   - Add `.search-result-content` wrapper styles
   - Add `.view-in-sequence-btn` button styles

3. **`StorySmith-v1/jsx/navigateToSequence.jsx`** (new file, if ExtendScript needed)
   - Create ExtendScript to handle sequence activation and navigation

## Verification Steps

1. **Setup**:
   - Ensure Premiere Pro is running with a project containing multiple sequences
   - Ensure at least one sequence has been indexed by StorySmith

2. **Test Search Results**:
   - Switch to "Search Project" tab
   - Enter a search query that returns results
   - Verify "View in Sequence" button appears on far right of each result
   - Verify button has proper styling (blue, not too large)

3. **Test Navigation**:
   - Click "View in Sequence" button on a result
   - Verify Premiere Pro switches to the correct sequence
   - Verify playhead moves to the correct timecode (matches the in-point shown in result)
   - Verify no errors in console

4. **Test Edge Cases**:
   - Click button for sequence that's already active (should just move playhead)
   - Click button for sequence from different project (should show error)
   - Test with very long sequence names (verify layout doesn't break)

## User Decisions

1. **Playhead Position**: ✅ Position at exact start of match (`absoluteStart`)
2. **API Research**: ✅ Research Premiere Pro UXP documentation during implementation to find correct API methods

## Dependencies

- Premiere Pro UXP API documentation (need to research exact methods)
- Potentially ExtendScript if UXP doesn't support sequence activation
- No new npm packages required

## Implementation Summary

This plan adds "View in Sequence" buttons to search results that will:
1. Find the target sequence by name using the existing UXP API
2. Activate/open that sequence in Premiere Pro's timeline
3. Set the playhead to the exact start timecode of the search match

**Critical First Step**: Research the correct UXP API methods for sequence activation and playhead positioning before writing implementation code. The API methods are not yet confirmed and must be verified against Adobe's documentation.

**User Confirmed**:
- Playhead should be positioned at exact match start (`absoluteStart` in seconds)
- API research should be done during implementation

**Implementation Order**:
1. Research and document API methods ← START HERE
2. Add button UI and styling
3. Implement navigation logic with verified API calls
4. Test in Premiere Pro
5. Add error handling and edge cases

## Notes

- This is the first feature that **controls** Premiere rather than just reading data
- API research is critical - implementation depends on what methods are available
- May need to test on actual Premiere Pro installation to verify API behavior
- Consider adding loading state to button while navigation is in progress
