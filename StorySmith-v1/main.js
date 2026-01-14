/**************************************************************************
 * StorySmith - Sequence-Based Clip Management
 * Load clips from Premiere Pro sequences and retrieve file paths
 **************************************************************************/

// Global object for Premiere Pro API
const ppro = require("premierepro");

// Backend URL for file path retrieval
const BACKEND_URL = "https://42c2ac9a3068.ngrok-free.app";

// ============================================================================
// STATE
// ============================================================================

// All clips loaded from project sequences
let allClips = [];

// Selected sequence names (for Load & Send tab)
const selectedClips = new Set();

// Selected sequences for search (separate from Load & Send selection)
const selectedSearchSequences = new Set();

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
        } // end for loop through sequences
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
            // No clips from sequences - backend clips won't have sequence context
            console.log(`  ⚠️ No clips found in sequences, but backend returned ${data.transcripts.length} file(s)`);
            console.log(`     These files cannot be used without sequence information`);
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
    updateSearchSequencesDisplay();

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
 * Send selected sequences to webhook
 */
async function sendToWebhook() {
  if (selectedClips.size === 0) {
    alert("Please select at least one sequence first");
    return;
  }

  const statusDiv = document.getElementById("status");
  const statusContent = document.getElementById("status-content");

  statusDiv.style.display = "block";
  statusContent.innerHTML = `
    <div class="status-info">
      ⏳ <strong>Sending to webhook...</strong><br>
      <small>Posting sequence information</small>
    </div>
  `;

  try {
    // Build sequence data with all clips for selected sequences
    const sequences = [];

    for (const sequenceName of selectedClips) {
      // Get all clips in this sequence
      const clipsInSequence = allClips.filter(clip => clip.sequenceName === sequenceName);

      if (clipsInSequence.length > 0) {
        // Sort clips by timeline start position
        clipsInSequence.sort((a, b) => a.timelineStart - b.timelineStart);

        // Calculate sequence total duration
        const totalDuration = clipsInSequence.reduce((sum, clip) => sum + (clip.duration || 0), 0);

        // Count clip types
        const videoCount = clipsInSequence.filter(c => c.trackType === 'video').length;
        const audioCount = clipsInSequence.filter(c => c.trackType === 'audio').length;

        sequences.push({
          sequenceName: sequenceName,
          totalClips: clipsInSequence.length,
          videoClips: videoCount,
          audioClips: audioCount,
          totalDuration: totalDuration,
          clips: clipsInSequence.map(clip => ({
            id: clip.id,
            name: clip.name,
            filePath: clip.filePath,
            trackType: clip.trackType,
            trackIndex: clip.trackIndex,
            timelineStart: clip.timelineStart,
            timelineEnd: clip.timelineEnd,
            inPoint: clip.inPoint,
            outPoint: clip.outPoint,
            duration: clip.duration,
            startTicks: clip.startTicks,
            endTicks: clip.endTicks,
            hasAudio: clip.hasAudio,
            hasVideo: clip.hasVideo
          }))
        });
      }
    }

    const totalClips = sequences.reduce((sum, seq) => sum + seq.totalClips, 0);
    console.log(`📡 Sending ${sequences.length} sequences with ${totalClips} total clips to webhook...`);

    const webhookUrl = "http://localhost:5678/webhook/c7b54aab-b27d-4832-bfc8-b03791cd441e";
    const webhookData = {
      sequences: sequences,
      projectPath: window.currentProjectPath || "",
      timestamp: new Date().toISOString()
    };

    // Log the complete data being sent
    console.log("\n" + "=".repeat(80));
    console.log("📤 WEBHOOK DATA BEING SENT");
    console.log("=".repeat(80));
    console.log(JSON.stringify(webhookData, null, 2));
    console.log("=".repeat(80) + "\n");

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
          ✅ <strong>Sent ${sequences.length} sequence${sequences.length !== 1 ? 's' : ''} to webhook</strong><br>
          <small>${totalClips} total clips • Check webhook for results</small>
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
 * Update UI display to show sequences (grouped clips)
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

  // Group clips by sequence
  const clipsBySequence = {};
  for (const clip of allClips) {
    if (!clipsBySequence[clip.sequenceName]) {
      clipsBySequence[clip.sequenceName] = [];
    }
    clipsBySequence[clip.sequenceName].push(clip);
  }

  let html = "";
  for (const [sequenceName, clips] of Object.entries(clipsBySequence)) {
    const isSelected = selectedClips.has(sequenceName);

    // Calculate sequence statistics
    const clipsWithPaths = clips.filter(c => c.filePath && c.filePath.length > 0).length;
    const totalClips = clips.length;
    const allHavePaths = clipsWithPaths === totalClips;
    const pathIndicator = allHavePaths
      ? `<span class="path-indicator" title="${clipsWithPaths}/${totalClips} clips have file paths">📁</span>`
      : `<span class="no-path-indicator" title="${clipsWithPaths}/${totalClips} clips have file paths">⚠️</span>`;

    // Calculate total duration
    const totalDuration = clips.reduce((sum, clip) => sum + (clip.duration || 0), 0);
    const durationText = formatTimecode(totalDuration);

    // Count video and audio clips
    const videoCount = clips.filter(c => c.trackType === 'video').length;
    const audioCount = clips.filter(c => c.trackType === 'audio').length;

    html += `
      <div class="clip-item ${isSelected ? 'selected' : ''}" data-sequence-name="${escapeHtml(sequenceName)}">
        <input type="checkbox" ${isSelected ? 'checked' : ''} />
        <div class="sequence-info">
          <span class="clip-name">${escapeHtml(sequenceName)}</span>
          <span class="sequence-details">
            ${totalClips} clip${totalClips !== 1 ? 's' : ''} (🎥${videoCount} 🔊${audioCount}) • ${durationText}
          </span>
        </div>
        ${pathIndicator}
      </div>
    `;
  }

  container.innerHTML = html;

  // Add event listeners
  const clipItems = container.querySelectorAll(".clip-item");
  for (const item of clipItems) {
    const checkbox = item.querySelector("input[type='checkbox']");
    const sequenceName = item.getAttribute("data-sequence-name");

    // Clicking the clip item toggles selection
    item.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") {
        checkbox.checked = !checkbox.checked;
        toggleClipSelection(sequenceName, checkbox.checked);
      }
    });

    // Checkbox change event
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      toggleClipSelection(sequenceName, checkbox.checked);
    });
  }
}

/**
 * Toggle sequence selection
 */
function toggleClipSelection(sequenceName, selected) {
  if (selected) {
    selectedClips.add(sequenceName);
  } else {
    selectedClips.delete(sequenceName);
  }

  updateClipsDisplay();
  updateSelectedCount();
}

/**
 * Update sequences count display
 */
function updateClipsCount() {
  const clipsCount = document.getElementById("clips-count");

  if (allClips.length === 0) {
    clipsCount.textContent = "No sequences loaded";
    return;
  }

  // Count unique sequences
  const uniqueSequences = new Set(allClips.map(clip => clip.sequenceName));
  const sequenceCount = uniqueSequences.size;

  clipsCount.textContent = sequenceCount === 0
    ? "No sequences loaded"
    : `${sequenceCount} sequence${sequenceCount !== 1 ? 's' : ''}`;
}

/**
 * Update selected count display
 */
function updateSelectedCount() {
  const selectedCount = document.getElementById("selected-count");
  selectedCount.textContent = `${selectedClips.size} selected`;
}

/**
 * Update search sequences display (for Search tab)
 */
function updateSearchSequencesDisplay() {
  const container = document.getElementById("search-sequences-container");

  if (allClips.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <small>No sequences loaded yet</small>
      </div>
    `;
    return;
  }

  // Get unique sequences
  const uniqueSequences = [...new Set(allClips.map(clip => clip.sequenceName))];

  let html = "";
  for (const sequenceName of uniqueSequences) {
    const isSelected = selectedSearchSequences.has(sequenceName);

    html += `
      <div class="search-sequence-item" data-sequence-name="${escapeHtml(sequenceName)}">
        <input type="checkbox" ${isSelected ? 'checked' : ''} />
        <span class="search-sequence-name">${escapeHtml(sequenceName)}</span>
      </div>
    `;
  }

  container.innerHTML = html;

  // Add event listeners
  const sequenceItems = container.querySelectorAll(".search-sequence-item");
  for (const item of sequenceItems) {
    const checkbox = item.querySelector("input[type='checkbox']");
    const sequenceName = item.getAttribute("data-sequence-name");

    // Clicking the item toggles selection
    item.addEventListener("click", (e) => {
      if (e.target.tagName !== "INPUT") {
        checkbox.checked = !checkbox.checked;
        toggleSearchSequenceSelection(sequenceName, checkbox.checked);
      }
    });

    // Checkbox change event
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      toggleSearchSequenceSelection(sequenceName, checkbox.checked);
    });
  }
}

/**
 * Toggle search sequence selection
 */
function toggleSearchSequenceSelection(sequenceName, selected) {
  if (selected) {
    selectedSearchSequences.add(sequenceName);
  } else {
    selectedSearchSequences.delete(sequenceName);
  }
}

/**
 * Select all sequences for search
 */
function selectAllSearchSequences() {
  const uniqueSequences = [...new Set(allClips.map(clip => clip.sequenceName))];
  selectedSearchSequences.clear();
  uniqueSequences.forEach(seq => selectedSearchSequences.add(seq));
  updateSearchSequencesDisplay();
  console.log(`✓ Selected all ${selectedSearchSequences.size} sequences for search`);
}

/**
 * Deselect all sequences for search
 */
function deselectAllSearchSequences() {
  selectedSearchSequences.clear();
  updateSearchSequencesDisplay();
  console.log("✓ Deselected all sequences for search");
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

/**
 * Send search query to API
 */
async function searchSequences() {
  const searchQuery = document.getElementById("searchQuery").value.trim();

  if (!searchQuery) {
    alert("Please enter a search query");
    return;
  }

  if (selectedSearchSequences.size === 0) {
    alert("Please select at least one sequence to search");
    return;
  }

  const statusDiv = document.getElementById("search-status");
  const statusContent = document.getElementById("search-status-content");
  const resultsDiv = document.getElementById("search-results");
  const resultsContent = document.getElementById("search-results-content");

  // Hide previous results
  resultsDiv.style.display = "none";

  // Show loading status
  statusDiv.style.display = "block";
  statusContent.innerHTML = `
    <div class="status-info">
      ⏳ <strong>Searching sequences...</strong><br>
      <small>Query: "${escapeHtml(searchQuery)}" in ${selectedSearchSequences.size} sequence(s)</small>
    </div>
  `;

  try {
    console.log(`🔍 Searching for: "${searchQuery}"`);
    console.log(`📋 Searching in sequences:`, Array.from(selectedSearchSequences));

    // Placeholder API URL - replace with actual endpoint
    const searchApiUrl = "https://api.placeholder.com/search";

    const response = await fetch(searchApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: searchQuery,
        sequences: Array.from(selectedSearchSequences),
        projectPath: window.currentProjectPath || "",
        timestamp: new Date().toISOString()
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log("✅ Search results:", data);

      // Hide status
      statusDiv.style.display = "none";

      // Display results
      if (data.results && data.results.length > 0) {
        let resultsHtml = "";

        for (const result of data.results) {
          resultsHtml += `
            <div class="search-result-item" data-sequence="${escapeHtml(result.sequenceName)}" data-timecode="${result.timecode || 0}">
              <div class="search-result-title">${escapeHtml(result.sequenceName)}</div>
              <div class="search-result-details">
                ${result.timecode ? `⏱️ ${formatTimecode(result.timecode)} • ` : ''}
                ${result.clipName ? `📁 ${escapeHtml(result.clipName)}` : ''}
              </div>
              ${result.snippet ? `<div class="search-result-snippet">${escapeHtml(result.snippet)}</div>` : ''}
            </div>
          `;
        }

        resultsContent.innerHTML = resultsHtml;
        resultsDiv.style.display = "block";

        // Add click handlers to results
        const resultItems = resultsContent.querySelectorAll(".search-result-item");
        resultItems.forEach(item => {
          item.addEventListener("click", () => {
            const sequenceName = item.getAttribute("data-sequence");
            const timecode = parseFloat(item.getAttribute("data-timecode") || "0");
            console.log(`📍 Navigate to: ${sequenceName} at ${formatTimecode(timecode)}`);
            // TODO: Add navigation logic to jump to sequence/timecode in Premiere
          });
        });
      } else {
        resultsContent.innerHTML = `
          <div class="empty-state">
            No results found for "${escapeHtml(searchQuery)}"
          </div>
        `;
        resultsDiv.style.display = "block";
      }
    } else {
      console.warn("Search request failed:", response.status);

      statusContent.innerHTML = `
        <div class="error">
          ❌ <strong>Search request failed</strong><br>
          <small>Status: ${response.status}. The search API may not be available yet.</small>
        </div>
      `;

      setTimeout(() => {
        statusDiv.style.display = "none";
      }, 5000);
    }

  } catch (error) {
    console.error("❌ Error searching sequences:", error);

    statusContent.innerHTML = `
      <div class="error">
        ❌ <strong>Error:</strong> ${escapeHtml(error.message)}<br>
        <small>The search API is not configured yet. This is a placeholder endpoint.</small>
      </div>
    `;

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 5000);
  }
}

/**
 * Switch between tabs
 */
function switchTab(tabName) {
  // Update tab buttons
  const tabButtons = document.querySelectorAll(".tab-button");
  tabButtons.forEach(button => {
    if (button.getAttribute("data-tab") === tabName) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
  });

  // Update tab content
  const tabContents = document.querySelectorAll(".tab-content");
  tabContents.forEach(content => {
    if (content.id === tabName) {
      content.classList.add("active");
    } else {
      content.classList.remove("active");
    }
  });

  console.log(`📑 Switched to tab: ${tabName}`);

  // Auto-load sequences when Load & Send tab is activated and no sequences loaded yet
  if (tabName === "load-tab" && allClips.length === 0) {
    console.log("⚙️ Auto-loading sequences from project...");
    setTimeout(() => {
      loadClipsFromProject();
    }, 100);
  }
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

    // Auto-load sequences when first entering the app
    console.log("⚙️ Auto-loading sequences from project...");
    setTimeout(() => {
      loadClipsFromProject();
    }, 100);
  });

  // Tab switching
  const tabButtons = document.querySelectorAll(".tab-button");
  tabButtons.forEach(button => {
    button.addEventListener("click", () => {
      const tabName = button.getAttribute("data-tab");
      switchTab(tabName);
    });
  });

  // Button event listeners for Load & Send tab
  document.getElementById("btnProcessClips").addEventListener("click", async () => {
    console.log("⚙️ Loading clips from sequences...");
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

  // Button event listeners for Search tab
  document.getElementById("btnSelectAllSearch").addEventListener("click", selectAllSearchSequences);

  document.getElementById("btnDeselectAllSearch").addEventListener("click", deselectAllSearchSequences);

  document.getElementById("btnSearch").addEventListener("click", async () => {
    console.log("🔍 Searching sequences...");
    await searchSequences();
  });

  // Enter key in search textarea triggers search
  document.getElementById("searchQuery").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      searchSequences();
    }
  });

  // Initialize UI
  updateClipsCount();
  updateSelectedCount();
});
