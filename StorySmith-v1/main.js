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

    // Try to get all sequences and extract clips from them
    try {
      const sequences = project.sequences;
      console.log(`📋 Sequences available: ${sequences ? 'yes' : 'no'}`);
      console.log(`📋 Sequences length: ${sequences?.length || 0}`);

      if (sequences && sequences.length > 0) {
        for (let seqIndex = 0; seqIndex < sequences.length; seqIndex++) {
          const sequence = sequences[seqIndex];
          console.log(`\n  Processing sequence ${seqIndex}: ${sequence.name}`);

          // Get clips from video tracks
          if (sequence.videoTracks) {
            const videoTracks = sequence.videoTracks;
            console.log(`    Video tracks: ${videoTracks.length}`);

            for (let trackIndex = 0; trackIndex < videoTracks.length; trackIndex++) {
              const track = videoTracks[trackIndex];
              const clips = track.clips;
              console.log(`      Track ${trackIndex}: ${clips.length} clips`);

              for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
                const clip = clips[clipIndex];
                const projectItem = clip.projectItem;

                if (projectItem) {
                  const clipId = projectItem.nodeId || `clip_${Date.now()}_${Math.random()}`;
                  const clipName = projectItem.name || clip.name || "Unnamed";

                  // Check if we already have this clip (avoid duplicates)
                  if (!allClipsList.find(c => c.name === clipName)) {
                    allClipsList.push({
                      id: clipId,
                      name: clipName,
                      filePath: "", // Will be filled by backend
                      nodeId: projectItem.nodeId,
                      hasAudio: false,
                      hasVideo: true
                    });
                    console.log(`        ✓ Found clip: ${clipName}`);
                  }
                }
              }
            }
          } else {
            console.log(`    No video tracks`);
          }

          // Get clips from audio tracks
          if (sequence.audioTracks) {
            const audioTracks = sequence.audioTracks;
            console.log(`    Audio tracks: ${audioTracks.length}`);

            for (let trackIndex = 0; trackIndex < audioTracks.length; trackIndex++) {
              const track = audioTracks[trackIndex];
              const clips = track.clips;
              console.log(`      Track ${trackIndex}: ${clips.length} clips`);

              for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
                const clip = clips[clipIndex];
                const projectItem = clip.projectItem;

                if (projectItem) {
                  const clipId = projectItem.nodeId || `clip_${Date.now()}_${Math.random()}`;
                  const clipName = projectItem.name || clip.name || "Unnamed";

                  // Check if we already have this clip (avoid duplicates)
                  const existingClip = allClipsList.find(c => c.name === clipName);
                  if (existingClip) {
                    existingClip.hasAudio = true;
                  } else {
                    allClipsList.push({
                      id: clipId,
                      name: clipName,
                      filePath: "", // Will be filled by backend
                      nodeId: projectItem.nodeId,
                      hasAudio: true,
                      hasVideo: false
                    });
                    console.log(`        ✓ Found clip: ${clipName}`);
                  }
                }
              }
            }
          } else {
            console.log(`    No audio tracks`);
          }
        }

        console.log(`\n✅ Found ${allClipsList.length} unique clips across all sequences`);
      } else {
        console.log(`⚠️ No sequences found in project`);
      }

    } catch (seqError) {
      console.warn("Could not access sequences:", seqError);
    }

    // If no clips found via sequences, query backend for ALL clips
    if (allClipsList.length === 0) {
      console.log("\n🔍 No clips found via sequences - querying backend for all clips...");

      try {
        const response = await fetch(`${BACKEND_URL}/transcripts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': 'true'
          },
          body: JSON.stringify({
            projectPath: projectPath,
            clipNames: [] // Empty array = get all clips
          })
        });

        if (response.ok) {
          const data = await response.json();
          console.log(`✅ Backend returned ${data.transcripts?.length || 0} clips`);

          if (data.transcripts && data.transcripts.length > 0) {
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
        } else {
          const errorText = await response.text();
          console.warn("Backend request failed:", response.status, errorText);
        }
      } catch (backendError) {
        console.warn("Could not connect to backend:", backendError.message);
      }
    }

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

  // Button event listeners
  document.getElementById("btnLoadClips").addEventListener("click", loadClipsFromProject);
  document.getElementById("btnGetPaths").addEventListener("click", getFilePathsForSelectedClips);
  document.getElementById("btnSendToWebhook").addEventListener("click", sendToWebhook);
  document.getElementById("btnLogSelected").addEventListener("click", logSelectedClips);
  document.getElementById("btnClearSelection").addEventListener("click", clearSelection);

  // Initialize UI
  updateClipsCount();
  updateSelectedCount();
});
