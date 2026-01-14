/**************************************************************************
 * StorySmith - Simplified Version
 * Load clips from Premiere Pro project and retrieve file paths
 **************************************************************************/

// Global object for Premiere Pro API
const ppro = require("premierepro");

// Backend URL for file path retrieval
const BACKEND_URL = "https://42c2ac9a3068.ngrok-free.app";

// ============================================================================
// STATE
// ============================================================================

// All clips loaded from project
let allClips = [];

// Selected clip IDs
const selectedClips = new Set();

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Format seconds to timecode (HH:MM:SS.mmm)
 */
function formatTimecode(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Normalize clip name for matching
 * Handles various formats: "podcast.wav", "podcast wav ", "podcast", etc.
 */
function normalizeClipName(name) {
  if (!name) return '';

  let normalized = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')        // Remove all spaces FIRST (handles "podcast wav")
    .replace(/\.[^/.]+$/, '');   // Then remove file extension (handles "podcast.wav")

  // Remove common media extensions that might appear as words
  // This handles cases where DB has "podcast wav" instead of "podcast.wav"
  const mediaExtensions = ['wav', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'flac', 'm4a', 'aac', 'aiff'];
  for (const ext of mediaExtensions) {
    if (normalized.endsWith(ext)) {
      normalized = normalized.slice(0, -ext.length);
      break; // Only remove one extension
    }
  }

  // Remove remaining special characters
  normalized = normalized.replace(/[-_]/g, '');

  return normalized;
}

/**
 * Load all clips from the Premiere Pro project
 */
async function loadClipsFromProject() {
  console.log("\n🎬 Starting to load clips from project...");

  const statusDiv = document.getElementById("status");
  const statusContent = document.getElementById("status-content");

  statusDiv.style.display = "block";
  statusContent.innerHTML = `
    <div class="status-info">
      ⏳ <strong>Loading clips from project...</strong><br>
      <small>This may take a moment</small>
    </div>
  `;

  try {
    // Get active project
    const project = await ppro.Project.getActiveProject();
    if (!project) {
      statusContent.innerHTML = `
        <div class="error">
          ❌ <strong>No active project found</strong><br>
          <small>Please open a project in Premiere Pro</small>
        </div>
      `;
      return;
    }

    console.log(`📁 Project: ${project.name}`);
    const projectPath = project.path || "";
    console.log(`📁 Project path: ${projectPath}`);

    // Store project path for later use
    if (projectPath) {
      window.currentProjectPath = projectPath;
    }

    let allClipsList = [];

    // Get sequences using the correct API method
    try {
      console.log(`\n🔍 Calling project.getSequences()...`);
      const sequences = await project.getSequences();
      console.log(`📋 Sequences:`, sequences);
      console.log(`📋 Sequences available: ${sequences ? 'yes' : 'no'}`);
      console.log(`📋 Sequences length: ${sequences?.length || 0}`);

      if (sequences && sequences.length > 0) {
        for (let seqIndex = 0; seqIndex < sequences.length; seqIndex++) {
          const sequence = sequences[seqIndex];
          console.log(`\n  Processing sequence ${seqIndex}: ${sequence.name}`);

          // Get sequence time range using the correct method
          let endTime = null;
          try {
            endTime = await sequence.getEndTime();
            console.log(`    Sequence duration: ${endTime.seconds}s (${endTime.ticks} ticks)`);

            // Skip empty sequences
            if (endTime.ticks === 0) {
              console.log(`    ⚠️ Skipping empty sequence`);
              continue;
            }
          } catch (e) {
            console.log(`    Could not get sequence end time:`, e.message);
            continue;
          }

          // Get clips from video tracks
          const videoTrackCount = await sequence.getVideoTrackCount();
          console.log(`    Video tracks: ${videoTrackCount}`);

          for (let trackIndex = 0; trackIndex < videoTrackCount; trackIndex++) {
            try {
              const track = await sequence.getVideoTrack(trackIndex);

              // Use the correct parameters: (Type: 1 for Clips, IncludeEmpty: false)
              try {
                const trackItems = await track.getTrackItems(1, false);
                console.log(`    ✓ Video Track ${trackIndex}: ${trackItems.length} items`);

                // Process the items
                for (const item of trackItems) {
                  try {
                    const projectItem = await item.getProjectItem();
                    if (!projectItem) {
                      console.log(`      ⚠️ Skipping item - no project item`);
                      continue;
                    }

                    // Get timecode information using the correct methods
                    const startTime = await item.getStartTime();
                    const endTime = await item.getEndTime();
                    const inPoint = await item.getInPoint();
                    const outPoint = await item.getOutPoint();
                    const duration = await item.getDuration();
                    const clipName = await item.getName();

                    console.log(`      ✓ Clip: ${projectItem.name}`);
                    console.log(`        Timeline: ${startTime.seconds}s - ${endTime.seconds}s`);
                    console.log(`        In/Out: ${inPoint.seconds}s - ${outPoint.seconds}s`);
                    console.log(`        Duration: ${duration.seconds}s`);

                    // Generate a unique ID for this clip
                    const clipId = `clip_${seqIndex}_${trackIndex}_${allClipsList.length}`;

                    // Add to our clips list (we'll get file path from backend)
                    allClipsList.push({
                      id: clipId,
                      name: projectItem.name,
                      filePath: null, // Will be populated from backend
                      sequenceName: sequence.name,
                      trackType: 'video',
                      trackIndex: trackIndex,
                      timelineStart: startTime.seconds,
                      timelineEnd: endTime.seconds,
                      inPoint: inPoint.seconds,
                      outPoint: outPoint.seconds,
                      duration: duration.seconds,
                      startTicks: startTime.ticks,
                      endTicks: endTime.ticks
                    });

                    console.log(`      ✓ Added clip ${clipId} to list`);
                  } catch (error) {
                    console.warn(`      ✗ Error processing video item:`, error);
                  }
                }
              } catch (e) {
                console.log(`    ✗ getTrackItems failed for video track ${trackIndex}: ${e.message}`);
              }
            } catch (trackError) {
              console.warn(`    Error processing video track ${trackIndex}:`, trackError);
            }
          }

          // Get clips from audio tracks
          const audioTrackCount = await sequence.getAudioTrackCount();
          console.log(`    Audio tracks: ${audioTrackCount}`);

          for (let trackIndex = 0; trackIndex < audioTrackCount; trackIndex++) {
            try {
              const track = await sequence.getAudioTrack(trackIndex);

              try {
                const trackItems = await track.getTrackItems(1, false);
                console.log(`    ✓ Audio Track ${trackIndex}: ${trackItems.length} items`);

                // Process the items
                for (const item of trackItems) {
                  try {
                    const projectItem = await item.getProjectItem();
                    if (!projectItem) {
                      console.log(`      ⚠️ Skipping item - no project item`);
                      continue;
                    }

                    // Get timecode information using the correct methods
                    const startTime = await item.getStartTime();
                    const endTime = await item.getEndTime();
                    const inPoint = await item.getInPoint();
                    const outPoint = await item.getOutPoint();
                    const duration = await item.getDuration();
                    const clipName = await item.getName();

                    console.log(`      ✓ Clip: ${projectItem.name}`);
                    console.log(`        Timeline: ${startTime.seconds}s - ${endTime.seconds}s`);
                    console.log(`        In/Out: ${inPoint.seconds}s - ${outPoint.seconds}s`);
                    console.log(`        Duration: ${duration.seconds}s`);

                    // Generate a unique ID for this clip
                    const clipId = `clip_${seqIndex}_${trackIndex}_${allClipsList.length}`;

                    // Add to our clips list (we'll get file path from backend)
                    allClipsList.push({
                      id: clipId,
                      name: projectItem.name,
                      filePath: null, // Will be populated from backend
                      sequenceName: sequence.name,
                      trackType: 'audio',
                      trackIndex: trackIndex,
                      timelineStart: startTime.seconds,
                      timelineEnd: endTime.seconds,
                      inPoint: inPoint.seconds,
                      outPoint: outPoint.seconds,
                      duration: duration.seconds,
                      startTicks: startTime.ticks,
                      endTicks: endTime.ticks
                    });

                    console.log(`      ✓ Added clip ${clipId} to list`);
                  } catch (error) {
                    console.warn(`      ✗ Error processing audio item:`, error);
                  }
                }
              } catch (e) {
                console.log(`    ✗ getTrackItems failed for audio track ${trackIndex}: ${e.message}`);
              }
            } catch (trackError) {
              console.warn(`    Error processing audio track ${trackIndex}:`, trackError);
            }
          }




          } // end if sequences && sequences.length > 0
        } else {
        console.log(`⚠️ No sequences found in project`);
      }

    } catch (seqError) {
      console.warn("Could not access sequences:", seqError);
    }

    // Query backend for file paths
    if (allClipsList.length === 0) {
      console.log("\n🔍 No clips found via sequences - querying backend for all clips...");
    } else {
      console.log(`\n🔍 Querying backend for file paths of ${allClipsList.length} clips...`);
    }

    try {
      // Get unique clip names from our sequence extraction
      const clipNames = allClipsList.length > 0
        ? [...new Set(allClipsList.map(clip => clip.name))]
        : []; // Empty array = get all clips

      console.log(`   Clip names being sent to backend:`, clipNames);

      const response = await fetch(`${BACKEND_URL}/transcripts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({
          projectPath: projectPath,
          clipNames: clipNames
        })
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`✅ Backend returned ${data.transcripts?.length || 0} clips`);

        if (data.transcripts && data.transcripts.length > 0) {
          // If we already have clips from sequences, match file paths
          if (allClipsList.length > 0) {
            console.log(`\n🔗 Matching file paths to ${allClipsList.length} sequence clips...`);

            for (const transcript of data.transcripts) {
              console.log(`\n  📄 Backend clip: "${transcript.clipName}"`);
              console.log(`     Normalized: "${normalizeClipName(transcript.clipName)}"`);
              console.log(`     File path: ${transcript.filePath || 'no path'}`);

              // Find clips with matching name (using normalized comparison)
              const normalizedBackendName = normalizeClipName(transcript.clipName);
              const matchingClips = allClipsList.filter(clip =>
                normalizeClipName(clip.name) === normalizedBackendName
              );

              if (matchingClips.length > 0) {
                console.log(`     Matched to ${matchingClips.length} clip instance(s):`);

                for (const clip of matchingClips) {
                  clip.filePath = transcript.filePath || "";
                  clip.hasAudio = transcript.audioInfo ? true : false;
                  console.log(`       ✓ ${clip.id} (${clip.sequenceName}, ${clip.trackType} track ${clip.trackIndex})`);
                  console.log(`         Clip name: "${clip.name}" → normalized: "${normalizeClipName(clip.name)}"`);
                }
              } else {
                console.log(`     ⚠️ No matching clips found in sequences`);
                console.log(`     Available clip names (normalized):`);
                const uniqueNames = [...new Set(allClipsList.map(c => normalizeClipName(c.name)))];
                for (const name of uniqueNames) {
                  console.log(`       - "${name}"`);
                }
              }
            }

            // Check for clips without file paths
            const clipsWithoutPaths = allClipsList.filter(clip => !clip.filePath);
            if (clipsWithoutPaths.length > 0) {
              console.log(`\n  ⚠️ ${clipsWithoutPaths.length} clip(s) have no file path from backend:`);
              for (const clip of clipsWithoutPaths) {
                console.log(`     - ${clip.name} (${clip.id})`);
              }
            }
          } else {
            // No clips from sequences, use backend clips
            for (const transcript of data.transcripts) {
              const clipId = `clip_${Date.now()}_${Math.random()}`;
              allClipsList.push({
                id: clipId,
                name: transcript.clipName || "Unnamed",
                filePath: transcript.filePath || "",
                nodeId: clipId,
                hasAudio: transcript.audioInfo ? true : false,
                hasVideo: false
              });
              console.log(`  ✓ ${transcript.clipName}: ${transcript.filePath || 'no path'}`);
            }
          }
        }
      } else {
        const errorText = await response.text();
        console.warn("Backend request failed:", response.status, errorText);
      }
    } catch (backendError) {
      console.warn("Could not connect to backend:", backendError.message);
    }

    // Log sequence information with clips at their timecodes
    console.log("\n" + "=".repeat(80));
    console.log("📊 SEQUENCE SUMMARY");
    console.log("=".repeat(80));

    // Group clips by sequence
    const clipsBySequence = {};
    for (const clip of allClipsList) {
      if (!clipsBySequence[clip.sequenceName]) {
        clipsBySequence[clip.sequenceName] = [];
      }
      clipsBySequence[clip.sequenceName].push(clip);
    }

    // Log each sequence with its clips
    for (const [sequenceName, clips] of Object.entries(clipsBySequence)) {
      console.log(`\n📺 Sequence: ${sequenceName}`);
      console.log(`   Total clips: ${clips.length}`);

      // Sort clips by timeline start position
      clips.sort((a, b) => a.timelineStart - b.timelineStart);

      console.log(`   Clips (sorted by timeline position):`);
      for (const clip of clips) {
        const startTC = formatTimecode(clip.timelineStart);
        const endTC = formatTimecode(clip.timelineEnd);
        const durationTC = formatTimecode(clip.duration);

        console.log(`   ${clip.trackType === 'video' ? '🎥' : '🔊'} [${clip.trackType.toUpperCase()} Track ${clip.trackIndex}]`);
        console.log(`      Name: ${clip.name}`);
        console.log(`      Timeline: ${startTC} → ${endTC} (Duration: ${durationTC})`);
        console.log(`      File: ${clip.filePath || '⚠️ No file path'}`);
        console.log(`      ID: ${clip.id}`);
      }
    }

    console.log("\n" + "=".repeat(80));
    console.log(`✅ Total clips loaded: ${allClipsList.length}`);
    console.log("=".repeat(80) + "\n");

    // Update state
    allClips = allClipsList;
    selectedClips.clear();

    // Update UI
    updateClipsDisplay();
    updateClipsCount();

    if (allClips.length > 0) {
      statusContent.innerHTML = `
        <div class="success">
          ✅ <strong>Loaded ${allClips.length} clips from project</strong><br>
          <small>Select clips and click "Get File Paths" to retrieve paths</small>
        </div>
      `;
    } else {
      statusContent.innerHTML = `
        <div class="error">
          ⚠️ <strong>No clips found</strong><br>
          <small>Try adding clips to a sequence or check console for details</small>
        </div>
      `;
    }

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 5000);

  } catch (error) {
    console.error("❌ Error loading clips:", error);
    statusContent.innerHTML = `
      <div class="error">
        ❌ <strong>Error:</strong> ${escapeHtml(error.message)}<br>
        <small>Check console for details</small>
      </div>
    `;
  }
}

/**
 * Get file paths for selected clips from backend
 */
async function getFilePathsForSelectedClips() {
  if (selectedClips.size === 0) {
    alert("Please select at least one clip first");
    return;
  }

  const statusDiv = document.getElementById("status");
  const statusContent = document.getElementById("status-content");

  statusDiv.style.display = "block";
  statusContent.innerHTML = `
    <div class="status-info">
      ⏳ <strong>Getting file paths from backend...</strong><br>
      <small>Searching local file system</small>
    </div>
  `;

  try {
    const projectPath = window.currentProjectPath || "";
    const selectedClipNames = Array.from(selectedClips).map(clipId => {
      const clip = allClips.find(c => c.id === clipId);
      return clip ? clip.name : null;
    }).filter(name => name !== null);

    console.log(`📡 Querying backend for ${selectedClipNames.length} clips...`);
    console.log(`📁 Project path: ${projectPath}`);

    const response = await fetch(`${BACKEND_URL}/transcripts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({
        projectPath: projectPath,
        clipNames: selectedClipNames
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Backend returned ${data.transcripts?.length || 0} results`);

      // Update clip file paths
      if (data.transcripts && data.transcripts.length > 0) {
        let matchedCount = 0;

        for (const transcript of data.transcripts) {
          const clip = allClips.find(c =>
            c.name === transcript.clipName ||
            c.name.toLowerCase() === transcript.clipName?.toLowerCase()
          );

          if (clip && transcript.filePath) {
            clip.filePath = transcript.filePath;
            matchedCount++;
            console.log(`  ✓ ${clip.name} → ${clip.filePath}`);
          }
        }

        // Update UI
        updateClipsDisplay();

        statusContent.innerHTML = `
          <div class="success">
            ✅ <strong>Found ${matchedCount} file paths</strong><br>
            <small>File paths updated in the list below</small>
          </div>
        `;
      } else {
        statusContent.innerHTML = `
          <div class="error">
            ⚠️ <strong>No file paths found</strong><br>
            <small>Backend could not find files for selected clips</small>
          </div>
        `;
      }
    } else {
      const errorText = await response.text();
      console.warn("Backend request failed:", response.status, errorText);

      statusContent.innerHTML = `
        <div class="error">
          ❌ <strong>Backend request failed</strong><br>
          <small>Status: ${response.status}. Check console for details.</small>
        </div>
      `;
    }

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 5000);

  } catch (error) {
    console.error("❌ Error getting file paths:", error);
    statusContent.innerHTML = `
      <div class="error">
        ❌ <strong>Error:</strong> ${escapeHtml(error.message)}<br>
        <small>Make sure backend is running. Check console for details.</small>
      </div>
    `;
  }
}

/**
 * Send selected clips to webhook
 */
async function sendToWebhook() {
  if (selectedClips.size === 0) {
    alert("Please select at least one clip first");
    return;
  }

  const statusDiv = document.getElementById("status");
  const statusContent = document.getElementById("status-content");

  statusDiv.style.display = "block";
  statusContent.innerHTML = `
    <div class="status-info">
      ⏳ <strong>Sending to webhook...</strong><br>
      <small>Posting file paths</small>
    </div>
  `;

  try {
    // Get selected clips with file paths
    const selectedClipsData = Array.from(selectedClips).map(clipId => {
      const clip = allClips.find(c => c.id === clipId);
      return clip ? {
        name: clip.name,
        filePath: clip.filePath,
        nodeId: clip.nodeId,
        hasAudio: clip.hasAudio,
        hasVideo: clip.hasVideo
      } : null;
    }).filter(clip => clip !== null);

    console.log(`📡 Sending ${selectedClipsData.length} clips to webhook...`);

    const webhookUrl = "http://localhost:5678/webhook/c7b54aab-b27d-4832-bfc8-b03791cd441e";
    const webhookData = {
      clips: selectedClipsData,
      projectPath: window.currentProjectPath || "",
      timestamp: new Date().toISOString()
    };

    // Use backend as proxy to avoid UXP permission issues
    const response = await fetch(`${BACKEND_URL}/webhook-proxy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify({
        webhookUrl: webhookUrl,
        data: webhookData
      })
    });

    if (response.ok) {
      const result = await response.text();
      console.log("✅ Webhook response:", result);

      statusContent.innerHTML = `
        <div class="success">
          ✅ <strong>Sent ${selectedClipsData.length} clips to webhook</strong><br>
          <small>Check webhook for results</small>
        </div>
      `;
    } else {
      console.warn("Webhook request failed:", response.status);

      statusContent.innerHTML = `
        <div class="error">
          ❌ <strong>Webhook request failed</strong><br>
          <small>Status: ${response.status}</small>
        </div>
      `;
    }

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 5000);

  } catch (error) {
    console.error("❌ Error sending to webhook:", error);
    statusContent.innerHTML = `
      <div class="error">
        ❌ <strong>Error:</strong> ${escapeHtml(error.message)}<br>
        <small>Check console for details</small>
      </div>
    `;
  }
}

// ============================================================================
// UI DISPLAY FUNCTIONS
// ============================================================================

/**
 * Update clips display in UI
 */
function updateClipsDisplay() {
  const container = document.getElementById("clips-container");

  if (allClips.length === 0) {
    container.innerHTML = `
      <div class="empty">
        No clips loaded. Click "Load Clips from Project" to get started.
      </div>
    `;
    return;
  }

  let html = "";
  for (const clip of allClips) {
    const isSelected = selectedClips.has(clip.id);
    const hasPath = clip.filePath && clip.filePath.length > 0;
    const pathIndicator = hasPath
      ? `<span class="path-indicator" title="File path: ${escapeHtml(clip.filePath)}">📁</span>`
      : `<span class="no-path-indicator" title="No file path yet">⚠️</span>`;

    html += `
      <div class="clip-item ${isSelected ? 'selected' : ''}" data-clip-id="${escapeHtml(clip.id)}">
        <input type="checkbox" ${isSelected ? 'checked' : ''} />
        <span class="clip-name">${escapeHtml(clip.name)}</span>
        ${pathIndicator}
      </div>
    `;
  }

  container.innerHTML = html;

  // Add event listeners
  const clipItems = container.querySelectorAll(".clip-item");
  for (const item of clipItems) {
    const checkbox = item.querySelector("input[type='checkbox']");
    const clipId = item.getAttribute("data-clip-id");

    // Clicking the clip item toggles selection
    item.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") {
        checkbox.checked = !checkbox.checked;
        toggleClipSelection(clipId, checkbox.checked);
      }
    });

    // Checkbox change event
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      toggleClipSelection(clipId, checkbox.checked);
    });
  }
}

/**
 * Toggle clip selection
 */
function toggleClipSelection(clipId, selected) {
  if (selected) {
    selectedClips.add(clipId);
  } else {
    selectedClips.delete(clipId);
  }

  updateClipsDisplay();
  updateSelectedCount();
}

/**
 * Update clips count display
 */
function updateClipsCount() {
  const clipsCount = document.getElementById("clips-count");
  clipsCount.textContent = allClips.length === 0
    ? "No clips loaded"
    : `${allClips.length} clip${allClips.length !== 1 ? 's' : ''}`;
}

/**
 * Update selected count display
 */
function updateSelectedCount() {
  const selectedCount = document.getElementById("selected-count");
  selectedCount.textContent = `${selectedClips.size} selected`;
}

/**
 * Log selected clips to console
 */
function logSelectedClips() {
  if (selectedClips.size === 0) {
    console.log("No clips selected");
    return;
  }

  console.log(`\n📊 Selected Clips (${selectedClips.size}):`);
  console.log("=====================================");

  for (const clipId of selectedClips) {
    const clip = allClips.find(c => c.id === clipId);
    if (clip) {
      console.log(`\n📌 ${clip.name}`);
      console.log(`   File Path: ${clip.filePath || "(no path)"}`);
      console.log(`   Node ID: ${clip.nodeId}`);
      console.log(`   Has Audio: ${clip.hasAudio}`);
      console.log(`   Has Video: ${clip.hasVideo}`);
    }
  }

  console.log("\n=====================================\n");
}

/**
 * Clear all selections
 */
function clearSelection() {
  selectedClips.clear();
  updateClipsDisplay();
  updateSelectedCount();
  console.log("✓ Selection cleared");
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  console.log("🚀 StorySmith Plugin Loaded");

  // Screen references
  const welcomeScreen = document.getElementById("welcome-screen");
  const selectionScreen = document.getElementById("selection-screen");

  // Button event listeners for welcome screen
  document.getElementById("btnInitialize").addEventListener("click", async () => {
    console.log("✨ Initializing StorySmith...");

    // Hide welcome screen, show selection screen
    welcomeScreen.style.display = "none";
    selectionScreen.style.display = "block";

    console.log("📋 Ready for clip selection");
  });

  // Button event listeners for selection screen
  document.getElementById("btnProcessClips").addEventListener("click", async () => {
    console.log("⚙️ Processing selected clips...");
    await loadClipsFromProject();
  });

  document.getElementById("btnSendToWebhook").addEventListener("click", sendToWebhook);

  document.getElementById("btnReset").addEventListener("click", () => {
    // Clear selected clips
    selectedClips.clear();

    // Update UI to reflect cleared selection
    updateClipsDisplay();
    updateSelectedCount();

    console.log("✓ Selection cleared");
  });

  // Initialize UI
  updateClipsCount();
  updateSelectedCount();
});
