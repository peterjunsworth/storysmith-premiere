/**************************************************************************
 * StorySmith - Sequence-Based Clip Management
 * Load clips from Premiere Pro sequences and retrieve file paths
 **************************************************************************/

// Global object for Premiere Pro API
const ppro = require("premierepro");

// Backend URL for file path retrieval
const BACKEND_URL = "https://4cbc-2601-740-8600-8a30-f8d8-6249-de40-ec68.ngrok-free.app";
const SERVER_URL = "http://localhost:3100";

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
  console.log("🎬 Loading clips from project...");

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
      const sequences = await project.getSequences();

      if (sequences && sequences.length > 0) {
        for (let seqIndex = 0; seqIndex < sequences.length; seqIndex++) {
          const sequence = sequences[seqIndex];

          // Get sequence time range using the correct method
          let endTime = null;
          try {
            endTime = await sequence.getEndTime();

            // Skip empty sequences
            if (endTime.ticks === 0) {
              continue;
            }
          } catch (e) {
            continue;
          }

          // Get clips from video tracks
          const videoTrackCount = await sequence.getVideoTrackCount();

          for (let trackIndex = 0; trackIndex < videoTrackCount; trackIndex++) {
            try {
              const track = await sequence.getVideoTrack(trackIndex);

              // Use the correct parameters: (Type: 1 for Clips, IncludeEmpty: false)
              try {
                const trackItems = await track.getTrackItems(1, false);

                // Process the items
                for (const item of trackItems) {
                  try {
                    const projectItem = await item.getProjectItem();
                    if (!projectItem) {
                      continue;
                    }

                    // Get timecode information using the correct methods
                    const startTime = await item.getStartTime();
                    const endTime = await item.getEndTime();
                    const inPoint = await item.getInPoint();
                    const outPoint = await item.getOutPoint();
                    const duration = await item.getDuration();
                    const clipName = await item.getName();

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

                  } catch (error) {
                    console.warn(`Error processing video item:`, error);
                  }
                }
              } catch (e) {
                console.warn(`getTrackItems failed for video track ${trackIndex}:`, e.message);
              }
            } catch (trackError) {
              console.warn(`Error processing video track ${trackIndex}:`, trackError);
            }
          }

          // Get clips from audio tracks
          const audioTrackCount = await sequence.getAudioTrackCount();

          for (let trackIndex = 0; trackIndex < audioTrackCount; trackIndex++) {
            try {
              const track = await sequence.getAudioTrack(trackIndex);

              try {
                const trackItems = await track.getTrackItems(1, false);

                // Process the items
                for (const item of trackItems) {
                  try {
                    const projectItem = await item.getProjectItem();
                    if (!projectItem) {
                      continue;
                    }

                    // Get timecode information using the correct methods
                    const startTime = await item.getStartTime();
                    const endTime = await item.getEndTime();
                    const inPoint = await item.getInPoint();
                    const outPoint = await item.getOutPoint();
                    const duration = await item.getDuration();
                    const clipName = await item.getName();

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

                  } catch (error) {
                    console.warn(`Error processing audio item:`, error);
                  }
                }
              } catch (e) {
                console.warn(`getTrackItems failed for audio track ${trackIndex}:`, e.message);
              }
            } catch (trackError) {
              console.warn(`Error processing audio track ${trackIndex}:`, trackError);
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
      console.log("No clips found in sequences");
    } else {
      console.log(`Found ${allClipsList.length} clips, querying backend for file paths...`);
    }

    try {
      // Get unique clip names from our sequence extraction
      const clipNames = allClipsList.length > 0
        ? [...new Set(allClipsList.map(clip => clip.name))]
        : []; // Empty array = get all clips

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

        if (data.transcripts && data.transcripts.length > 0) {
          // If we already have clips from sequences, match file paths
          if (allClipsList.length > 0) {
            for (const transcript of data.transcripts) {
              // Find clips with matching name (using normalized comparison)
              const normalizedBackendName = normalizeClipName(transcript.clipName);
              const matchingClips = allClipsList.filter(clip =>
                normalizeClipName(clip.name) === normalizedBackendName
              );

              if (matchingClips.length > 0) {
                for (const clip of matchingClips) {
                  clip.filePath = transcript.filePath || "";
                  clip.hasAudio = transcript.audioInfo ? true : false;
                }
              }
            }

            // Check for clips without file paths
            const clipsWithoutPaths = allClipsList.filter(clip => !clip.filePath);
            if (clipsWithoutPaths.length > 0) {
              console.log(`${clipsWithoutPaths.length} clip(s) have no file path from backend`);
            }
          } else {
            console.log(`No clips found in sequences, but backend returned ${data.transcripts.length} file(s)`);
          }
        }
      } else {
        const errorText = await response.text();
        console.warn("Backend request failed:", response.status, errorText);
      }
    } catch (backendError) {
      console.warn("Could not connect to backend:", backendError.message);
    }

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

    const webhookUrl = `${SERVER_URL}/index`;
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
    const response = await fetch(`${webhookUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true'
      },
      body: JSON.stringify(webhookData)
    });

    if (response.ok) {
      const result = await response.json();
      console.log("✅ Webhook response:", result);

      // If server accepted the job, start polling its progress
      if (result && result.jobId) {
        startJobProgressPolling(result.jobId, 5000);
      }

      statusContent.innerHTML = `
        <div class="success">
          ✅ <strong>Sent ${sequences.length} sequence${sequences.length !== 1 ? 's' : ''} to webhook</strong><br>
          <small>${totalClips} total clips • Check webhook for results</small>
        </div>
      `;
    } else {
      console.warn("Webhook request failed:", response);

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
// JOB PROGRESS POLLING
// ============================================================================

async function fetchJobProgress(jobId) {
  try {
    const url = `${SERVER_URL}/status/progress/${encodeURIComponent(jobId)}`;
    console.debug(`fetchJobProgress -> ${url}`);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function formatElapsedMs(ms) {
  if (!ms || ms <= 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function updateJobProgressDisplay(result) {
  const el = document.getElementById('job-progress-content');
  if (!el) return;

  if (!result) {
    el.innerHTML = '';
    return;
  }

  if (result.ok) {
    const d = result.data;
    // store latest job progress for UI mapping
    window._storysmith_lastJobProgress = d;
    const state = d.state || d.status || 'unknown';
    const pct = typeof d.percentComplete === 'number' ? `${d.percentComplete}%` : '';
    const clips = (typeof d.completedClips === 'number' && typeof d.totalClips === 'number')
      ? `${d.completedClips}/${d.totalClips}`
      : '';
    const chunks = d.chunksPercentComplete ? `${d.chunksPercentComplete}%` : '';
    const elapsed = d.elapsedMs ? formatElapsedMs(d.elapsedMs) : (d.startedAt ? formatElapsedMs(Date.now() - new Date(d.startedAt).getTime()) : '');

    el.innerHTML = `🔄 Job ${escapeHtml(d.jobId || '')} — <strong>${escapeHtml(state)}</strong>`
      + (pct ? ` • ${pct}` : '')
      + (clips ? ` • clips ${escapeHtml(clips)}` : '')
      + (chunks ? ` • chunks ${escapeHtml(chunks)}` : '')
      + (elapsed ? ` • ${escapeHtml(elapsed)}` : '');
    el.style.color = state === 'complete' || state === 'done' ? 'green' : '#333';
  } else {
    el.innerHTML = `❌ Job status unavailable (${escapeHtml(result.error || 'unknown')})`;
    el.style.color = 'crimson';
  }

  // refresh sequences UI so per-sequence badges can update
  try { updateClipsDisplay(); } catch (e) { /* ignore */ }
}

function startJobProgressPolling(jobId, intervalMs = 5000) {
  // clear existing poller
  if (window._storysmith_jobPoller) {
    clearInterval(window._storysmith_jobPoller);
    window._storysmith_jobPoller = null;
  }

  // immediate fetch
  (async () => {
    const r = await fetchJobProgress(jobId);
    updateJobProgressDisplay(r);
    if (r.ok && (r.data.state === 'complete' || r.data.state === 'done' || r.data.percentComplete === 100)) {
      // stop immediately if already complete
      stopJobProgressPolling();
    }
  })();

  const id = setInterval(async () => {
    const r = await fetchJobProgress(jobId);
    updateJobProgressDisplay(r);
    if (r.ok && (r.data.state === 'complete' || r.data.state === 'done' || r.data.percentComplete === 100)) {
      stopJobProgressPolling();
    }
  }, intervalMs);

  window._storysmith_jobPoller = id;
  window._storysmith_currentJobId = jobId;
}

function stopJobProgressPolling() {
  if (window._storysmith_jobPoller) {
    clearInterval(window._storysmith_jobPoller);
    window._storysmith_jobPoller = null;
  }
  // leave final state visible but clear current job id
  window._storysmith_currentJobId = null;
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

    // Per-sequence progress badge from last job progress (if available)
    let progressBadge = '';
    const jobProgress = window._storysmith_lastJobProgress;
    if (jobProgress && Array.isArray(jobProgress.clips)) {
      // Sum clip-level totals for this sequence using clip ids
      const clipIds = clips.map(c => c.id);
      let totalChunks = 0;
      let embeddedChunks = 0;
      let completedClips = 0;

      for (const cp of jobProgress.clips) {
        if (clipIds.includes(cp.clipId)) {
          totalChunks += cp.totalChunks || 0;
          embeddedChunks += cp.embeddedChunks || 0;
          if (cp.stage === 'done') completedClips++;
        }
      }

      if (totalChunks > 0) {
        const pct = Math.round((embeddedChunks / totalChunks) * 100);
        progressBadge = `<span class="sequence-progress" title="${embeddedChunks}/${totalChunks} chunks embedded">${pct}%</span>`;
      } else if (clips.length > 0) {
        // fallback to clip completion ratio
        const pct = Math.round((completedClips / clips.length) * 100);
        if (pct > 0) progressBadge = `<span class="sequence-progress" title="${completedClips}/${clips.length} clips">${pct}%</span>`;
      }
    }

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
        ${progressBadge}
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
}

/**
 * Deselect all sequences for search
 */
function deselectAllSearchSequences() {
  selectedSearchSequences.clear();
  updateSearchSequencesDisplay();
}

// ============================================================================
// INFRA STATUS POLLING
// ============================================================================

async function fetchServerStatus() {
  try {
    const res = await fetch(`${SERVER_URL}/status/progress`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function updateInfraStatusDisplay(result) {
  const el = document.getElementById('infra-status-content');
  if (!el) return;

  if (result.ok) {
    const d = result.data;
    const allGood = d.chromaOk && d.ollamaOk;
    if (allGood) {
      el.innerHTML = `✅ Service online — Chroma & Ollama OK`;
      el.style.color = 'green';
    } else {
      const parts = [];
      parts.push(d.chromaOk ? 'Chroma OK' : 'Chroma ✖');
      parts.push(d.ollamaOk ? 'Ollama OK' : 'Ollama ✖');
      el.innerHTML = `⚠️ Service partial — ${parts.join(' • ')}`;
      el.style.color = '#b36b00';
    }
  } else {
    el.innerHTML = `❌ Service unreachable (${escapeHtml(result.error || 'unknown')})`;
    el.style.color = 'crimson';
  }
}

function startInfraStatusPolling(intervalMs = 5000) {
  // run immediately, then every interval
  (async () => {
    // If a job is active, prefer fetching job progress
    const jobId = window._storysmith_currentJobId;
    if (jobId) {
      const r = await fetchJobProgress(jobId);
      // update both job progress and infra area (so infra area shows job state)
      updateJobProgressDisplay(r);
    } else {
      const r = await fetchServerStatus();
      updateInfraStatusDisplay(r);
    }
  })();

  const id = setInterval(async () => {
    const jobId = window._storysmith_currentJobId;
    if (jobId) {
      const r = await fetchJobProgress(jobId);
      updateJobProgressDisplay(r);
    } else {
      const r = await fetchServerStatus();
      updateInfraStatusDisplay(r);
    }
  }, intervalMs);

  // keep ref so it can be cleared if needed
  window._storysmith_statusPoller = id;
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
    </div>
  `;

  try {
    console.log(`🔍 Searching for: "${searchQuery}"`);

    // API URL
    const searchApiUrl = `${SERVER_URL}/search`;

    const response = await fetch(searchApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: searchQuery,
        topK: 10,
        expandQuery: false,
        // projectId is optional; include if available
        projectId: window.currentProjectPath || undefined
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log("✅ Search results:", data);

      // Hide status
      statusDiv.style.display = "none";

      // The server returns a SearchResponse with `hits: TimelineHit[]`
      const hits = data.hits || [];

      if (hits.length > 0) {
        let resultsHtml = "";

        for (const hit of hits) {
          const title = hit.filePath ? hit.filePath.split('/').pop() : hit.clipId || 'Result';
          const timecode = typeof hit.timelineStart === 'number' ? formatTimecode(hit.timelineStart) : '';
          const snippet = hit.chunkText || '';

          resultsHtml += `
            <div class="search-result-item" data-clipid="${escapeHtml(hit.clipId || '')}" data-timecode="${hit.timelineStart || 0}">
              <div class="search-result-title">${escapeHtml(title)}</div>
              <div class="search-result-details">
                ${timecode ? `⏱️ ${timecode} • ` : ''}
                ${hit.filePath ? `📁 ${escapeHtml(hit.filePath)}` : ''}
              </div>
              ${snippet ? `<div class="search-result-snippet">${escapeHtml(snippet)}</div>` : ''}
            </div>
          `;
        }

        resultsContent.innerHTML = resultsHtml;
        resultsDiv.style.display = "block";

        // Add click handlers to results
        const resultItems = resultsContent.querySelectorAll(".search-result-item");
        resultItems.forEach(item => {
          item.addEventListener("click", () => {
            const clipId = item.getAttribute("data-clipid");
            const timecode = parseFloat(item.getAttribute("data-timecode") || "0");
            console.log(`📍 Navigate to clip: ${clipId} at ${formatTimecode(timecode)}`);
            // Navigation to Premiere sequences is not implemented here
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

  // Auto-load sequences when Load & Send tab is activated and no sequences loaded yet
  if (tabName === "load-tab" && allClips.length === 0) {
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
    // Hide welcome screen, show selection screen
    welcomeScreen.style.display = "none";
    selectionScreen.style.display = "block";

    // Auto-load sequences when first entering the app
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
  // document.getElementById("btnSelectAllSearch").addEventListener("click", selectAllSearchSequences);

  // document.getElementById("btnDeselectAllSearch").addEventListener("click", deselectAllSearchSequences);

  document.getElementById("btnSearch").addEventListener("click", searchSequences);

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

  // Start polling the backend status endpoint every 5s
  startInfraStatusPolling(5000);
});
