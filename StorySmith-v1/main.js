/**************************************************************************
 * StorySmith - Sequence-Based Clip Management
 * Load clips from Premiere Pro sequences and retrieve file paths
 **************************************************************************/

// Global object for Premiere Pro API
const ppro = require("premierepro");

// Server URL for all backend requests
const SERVER_URL = "http://localhost:3100";

// ============================================================================
// STATE
// ============================================================================

// All clips loaded from project sequences
let allClips = [];

// Selected sequence names (for Load & Send tab)
const selectedClips = new Set();

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Get file paths directly from Premiere using JSX
 * Returns array of { clipName, filePath, hasAudio, hasVideo }
 */
async function getFilePathsFromPremiere() {
  try {
    // Read the JSX script
    const fs = require('fs');
    const path = require('path');
    const jsxPath = path.join(__dirname, 'jsx', 'getClipFilePaths.jsx');
    const jsxScript = fs.readFileSync(jsxPath, 'utf-8');

    // Execute the JSX script in Premiere Pro
    const result = await ppro.evalES(jsxScript);

    // Parse the JSON response
    const data = JSON.parse(result);

    if (data.success) {
      console.log(`✅ Got ${data.total} file paths directly from Premiere`);
      return data.results;
    } else {
      console.error('❌ JSX script failed:', data.error);
      return [];
    }
  } catch (error) {
    console.error('❌ Error executing JSX script:', error);
    return [];
  }
}

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
          let sequenceEndTime = null;
          try {
            sequenceEndTime = await sequence.getEndTime();

            // Skip empty sequences
            if (sequenceEndTime.ticks === 0) {
              continue;
            }
          } catch (e) {
            continue;
          }

          console.log(`📺 Processing sequence "${sequence.name}" (end: ${sequenceEndTime.seconds}s)`);

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

                    // Check if the clip is disabled (muted/hidden)
                    let isEnabled = true;
                    try {
                      isEnabled = await item.isEnabled();
                      if (!isEnabled) {
                        console.log(`⏭️  Skipping disabled video clip "${projectItem.name}" at ${startTime.seconds}s`);
                        continue;
                      }
                    } catch (e) {
                      // If isEnabled() fails, assume it's enabled
                    }

                    console.log(`✅ Video clip "${projectItem.name}" at ${startTime.seconds}s (enabled: ${isEnabled})`);

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

                    // Check if the clip is disabled (muted/hidden)
                    let isEnabled = true;
                    try {
                      isEnabled = await item.isEnabled();
                      if (!isEnabled) {
                        console.log(`⏭️  Skipping disabled audio clip "${projectItem.name}" at ${startTime.seconds}s`);
                        continue;
                      }
                    } catch (e) {
                      // If isEnabled() fails, assume it's enabled
                    }

                    console.log(`✅ Audio clip "${projectItem.name}" at ${startTime.seconds}s (enabled: ${isEnabled})`);

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

    // Query backend for file paths from database (with enhanced fixFilePath)
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

      const response = await fetch(`${SERVER_URL}/transcripts`, {
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
        console.log("📥 Backend response:", JSON.stringify(data, null, 2));

        if (data.transcripts && data.transcripts.length > 0) {
          console.log(`Backend returned ${data.transcripts.length} transcripts`);
          // If we already have clips from sequences, match file paths
          if (allClipsList.length > 0) {
            for (const transcript of data.transcripts) {
              // Find clips with matching name (using normalized comparison)
              const normalizedBackendName = normalizeClipName(transcript.clipName);
              const matchingClips = allClipsList.filter(clip =>
                normalizeClipName(clip.name) === normalizedBackendName
              );

              console.log(`Matching "${transcript.clipName}" (normalized: "${normalizedBackendName}") → found ${matchingClips.length} clips`);

              if (matchingClips.length > 0) {
                for (const clip of matchingClips) {
                  clip.filePath = transcript.filePath || "";
                  clip.hasAudio = transcript.audioInfo ? true : false;
                  console.log(`  ✓ Set filePath for "${clip.name}" → "${clip.filePath}"`);
                }
              } else {
                console.log(`  ✗ No matching clips found for "${transcript.clipName}"`);
              }
            }

            // Check for clips without file paths
            const clipsWithoutPaths = allClipsList.filter(clip => !clip.filePath);
            if (clipsWithoutPaths.length > 0) {
              console.log(`${clipsWithoutPaths.length} clip(s) have no file path from backend`);
              clipsWithoutPaths.forEach(clip => {
                console.log(`  - "${clip.name}" (normalized: "${normalizeClipName(clip.name)}")`);
              });
            }
          } else {
            console.log(`No clips found in sequences, but backend returned ${data.transcripts.length} file(s)`);
          }
        } else {
          console.log("Backend returned no transcripts or empty array");
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

    if (allClips.length > 0) {
      statusContent.innerHTML = `
        <div class="success">
          ✅ <strong>Loaded project sequences</strong><br>
          <small>Select sequences for processing</small>
        </div>
      `;
    } else {
      statusContent.innerHTML = `
        <div class="error">
          ⚠️ <strong>No sequences found</strong><br>
          <small>Try adding sequences to the project</small>
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
 * Build sequence data from selected sequences or specific sequence names
 * @param {Set<string> | string[]} sequenceNames - Sequence names to build data for
 * @returns {Array} Array of sequence objects with clips
 */
function buildSequenceData(sequenceNames) {
  const sequences = [];
  const namesToProcess = Array.isArray(sequenceNames) ? sequenceNames : Array.from(sequenceNames);

  for (const sequenceName of namesToProcess) {
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

  return sequences;
}

/**
 * Send sequence data to the indexing endpoint
 * @param {Array} sequences - Sequence data to send
 * @param {Object} statusElements - Status display elements (statusDiv, statusContent)
 * @returns {Promise<Object>} Response data
 */
async function sendSequencesToIndex(sequences, statusElements = null) {
  const totalClips = sequences.reduce((sum, seq) => sum + seq.totalClips, 0);
  console.log(`📡 Sending ${sequences.length} sequences with ${totalClips} total clips to index...`);

  const webhookUrl = `${SERVER_URL}/index`;
  const webhookData = {
    sequences: sequences,
    projectPath: window.currentProjectPath || "",
    timestamp: new Date().toISOString()
  };

  // Log the complete data being sent
  console.log("\n" + "=".repeat(80));
  console.log("📤 INDEX DATA BEING SENT");
  console.log("=".repeat(80));
  console.log(JSON.stringify(webhookData, null, 2));
  console.log("=".repeat(80) + "\n");

  const response = await fetch(`${webhookUrl}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true'
    },
    body: JSON.stringify(webhookData)
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  const result = await response.json();
  console.log("✅ Index response:", result);

  // Track which sequences are being processed
  if (!window._storysmith_processingSequences) {
    window._storysmith_processingSequences = new Set();
  }
  sequences.forEach(seq => window._storysmith_processingSequences.add(seq.sequenceName));

  // Refresh the display to show "Processing" badges
  updateClipsDisplay();

  // If server accepted the job, start polling its progress
  if (result && result.jobId) {
    startJobProgressPolling(result.jobId, 5000);
    // Also restart infra status polling in case it was stopped
    startInfraStatusPolling(5000);
  }

  return { result, totalClips, sequences };
}

/**
 * Reindex a specific sequence by re-gathering and re-sending its data
 * @param {string} sequenceName - Name of the sequence to reindex
 */
async function reindexSequence(sequenceName) {
  console.log(`🔄 Reindexing sequence: "${sequenceName}"`);

  const statusDiv = document.getElementById("status");
  const statusContent = document.getElementById("status-content");

  statusDiv.style.display = "block";
  statusContent.innerHTML = `
    <div class="status-info">
      🔄 <strong>Reindexing "${sequenceName}"...</strong><br>
      <small>Re-gathering fresh sequence data from Premiere</small>
    </div>
  `;

  try {
    // Re-gather clips from the project to ensure completely fresh data
    console.log("🔄 Re-gathering clips from project for reindex...");
    await loadClipsFromProject();

    // Update status
    statusContent.innerHTML = `
      <div class="status-info">
        🔄 <strong>Reindexing "${sequenceName}"...</strong><br>
        <small>Sending updated sequence data to index</small>
      </div>
    `;

    // Build sequence data for just this sequence
    const sequences = buildSequenceData([sequenceName]);

    if (sequences.length === 0) {
      throw new Error(`No clips found for sequence "${sequenceName}"`);
    }

    // Send to index endpoint
    const { totalClips } = await sendSequencesToIndex(sequences);

    statusContent.innerHTML = `
      <div class="success">
        ✅ <strong>Reindexed "${sequenceName}"</strong><br>
        <small>${totalClips} clips sent for processing</small>
      </div>
    `;

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 5000);

  } catch (error) {
    console.error("❌ Error reindexing sequence:", error);
    statusContent.innerHTML = `
      <div class="error">
        ❌ <strong>Reindex failed:</strong> ${escapeHtml(error.message)}<br>
        <small>Check console for details</small>
      </div>
    `;

    setTimeout(() => {
      statusDiv.style.display = "none";
    }, 5000);
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
      ⏳ <strong>Re-gathering sequence data...</strong><br>
      <small>Ensuring up-to-date clip information</small>
    </div>
  `;

  try {
    // Store the current selection
    const sequencesToSend = Array.from(selectedClips);

    // Re-gather clips from the project to ensure up-to-date data
    console.log("🔄 Re-gathering clips from project before sending...");
    await loadClipsFromProject();

    // Restore the selection after reloading
    sequencesToSend.forEach(seq => selectedClips.add(seq));
    updateClipsDisplay();

    // Update status
    statusContent.innerHTML = `
      <div class="status-info">
        ⏳ <strong>Sending to webhook...</strong><br>
        <small>Posting sequence information</small>
      </div>
    `;

    // Build sequence data with all clips for selected sequences
    const sequences = buildSequenceData(selectedClips);

    // Send to index endpoint
    const { totalClips } = await sendSequencesToIndex(sequences);

    statusContent.innerHTML = `
      <div class="success">
        ✅ <strong>Sent ${sequences.length} sequence${sequences.length !== 1 ? 's' : ''} to webhook</strong><br>
        <small>${totalClips} total clips • Check webhook for results</small>
      </div>
    `;

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

function startJobProgressPolling(jobId, intervalMs = 5000) {
  // clear existing poller
  if (window._storysmith_jobPoller) {
    clearInterval(window._storysmith_jobPoller);
    window._storysmith_jobPoller = null;
  }

  // immediate fetch
  (async () => {
    const r = await fetchJobProgress(jobId);
    if (r.ok && (r.data.state === 'complete' || r.data.state === 'done' || r.data.percentComplete === 100)) {
      // stop immediately if already complete
      stopJobProgressPolling();
    }
  })();

  const id = setInterval(async () => {
    const r = await fetchJobProgress(jobId);
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
    const statusData = window._storysmith_lastJobProgress;
    const processingSequences = window._storysmith_processingSequences || new Set();

    // Check if this sequence is being processed or has progress data
    const isBeingProcessed = processingSequences.has(sequenceName);

    if (statusData && Array.isArray(statusData.jobs)) {
      // Find the most recent job for this sequence where totalClips > 0
      const sequenceJobs = statusData.jobs
        .filter(job => job.sequenceName === sequenceName && job.totalClips > 0)
        .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      if (sequenceJobs.length > 0) {
        const latestJob = sequenceJobs[0];
        const percentComplete = latestJob.percentComplete || 0;
        const isComplete = latestJob.state === 'done' && percentComplete === 100;

        console.log(`[Badge] Sequence: "${sequenceName}", state: ${latestJob.state}, percent: ${percentComplete}, isComplete: ${isComplete}`);

        // Remove from processing set if complete
        if (isComplete && processingSequences.has(sequenceName)) {
          processingSequences.delete(sequenceName);
          console.log(`[Badge] Removed "${sequenceName}" from processing set`);
        }

        const statusClass = isComplete ? 'sequence-progress-complete' : 'sequence-progress-processing';
        const statusText = isComplete ? 'Complete' : 'Processing';
        const tooltip = `${latestJob.embeddedChunks || 0}/${latestJob.totalChunks || 0} chunks embedded (${percentComplete}%)`;

        if (isComplete) {
          progressBadge = `
            <span class="${statusClass}" title="${tooltip}">${statusText}</span>
            <button class="reindex-btn" data-sequence="${escapeHtml(sequenceName)}" title="Reindex this sequence">
              🔄 Reindex
            </button>
          `;
        } else {
          progressBadge = `<span class="${statusClass}" title="${tooltip}">${statusText}</span>`;
        }
      } else if (isBeingProcessed) {
        // Show "Processing" even with no progress yet
        progressBadge = `<span class="sequence-progress-processing" title="Job submitted, awaiting progress data">Processing</span>`;
      }
    } else if (isBeingProcessed) {
      // Sequence was submitted but no progress data yet - show "Processing"
      progressBadge = `<span class="sequence-progress-processing" title="Job submitted, awaiting progress data">Processing</span>`;
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
      if (e.target.tagName !== "INPUT" && !e.target.classList.contains('reindex-btn')) {
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

  // Add event listeners to reindex buttons
  const reindexButtons = container.querySelectorAll('.reindex-btn');
  reindexButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const sequenceName = button.getAttribute('data-sequence');
      if (sequenceName) {
        reindexSequence(sequenceName);
      }
    });
  });
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

  // Enable/disable buttons based on selection
  const sendButton = document.getElementById("btnSendToWebhook");
  const resetButton = document.getElementById("btnReset");

  if (sendButton) {
    sendButton.disabled = selectedClips.size === 0;
  }

  if (resetButton) {
    resetButton.disabled = selectedClips.size === 0;
  }
}

/**
 * Update sequence status display in Search tab
 */
async function updateSequenceStatusDisplay() {
  const container = document.getElementById('sequence-status-list');
  const searchQuery = document.getElementById('searchQuery');
  const searchButton = document.getElementById('btnSearch');

  if (!container) return;

  // Show loading state
  container.innerHTML = '<div class="empty-state"><small>Loading sequence status...</small></div>';

  try {
    // Fetch current status
    const res = await fetch(`${SERVER_URL}/status/progress`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    const statusData = await res.json();

    // Get unique sequences from allClips
    const uniqueSequences = new Set(allClips.map(clip => clip.sequenceName));

    if (uniqueSequences.size === 0) {
      container.innerHTML = '<div class="empty-state"><small>No sequences loaded yet</small></div>';
      searchQuery.disabled = true;
      searchButton.disabled = true;
      return;
    }

    // Build status display
    let html = '';
    let hasCompleteSequence = false;

    for (const sequenceName of uniqueSequences) {
      // Find the most recent job for this sequence where totalClips > 0
      const sequenceJobs = statusData.jobs
        ? statusData.jobs
            .filter(job => job.sequenceName === sequenceName && job.totalClips > 0)
            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
        : [];

      let badge = '';
      let isComplete = false;

      if (sequenceJobs.length > 0) {
        const latestJob = sequenceJobs[0];
        const percentComplete = latestJob.percentComplete || 0;
        isComplete = latestJob.state === 'done' && percentComplete === 100;

        if (isComplete) {
          hasCompleteSequence = true;
          badge = `
            <span class="sequence-progress-complete">Complete</span>
            <button class="reindex-btn" data-sequence="${escapeHtml(sequenceName)}" title="Reindex this sequence">
              🔄 Reindex
            </button>
          `;
        } else {
          badge = '<span class="sequence-progress-processing">Processing</span>';
        }
      } else {
        // No job found - not processed yet
        badge = '<span class="sequence-progress-processing" style="opacity: 0.5;">Not Indexed</span>';
      }

      html += `
        <div class="sequence-status-item">
          <span class="sequence-status-name">${escapeHtml(sequenceName)}</span>
          <span class="sequence-status-badge">${badge}</span>
        </div>
      `;
    }

    container.innerHTML = html;

    // Add event listeners to reindex buttons
    const reindexButtons = container.querySelectorAll('.reindex-btn');
    reindexButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const sequenceName = button.getAttribute('data-sequence');
        if (sequenceName) {
          reindexSequence(sequenceName);
        }
      });
    });

    // Enable/disable search based on whether any sequence is complete
    searchQuery.disabled = !hasCompleteSequence;
    searchButton.disabled = !hasCompleteSequence;

    if (!hasCompleteSequence) {
      searchQuery.placeholder = 'Search is disabled until at least one sequence is indexed';
    } else {
      searchQuery.placeholder = "e.g., 'Find moments where we discuss AI and machine learning' or 'Show me the intro section'";
    }

  } catch (error) {
    console.error('Error fetching sequence status:', error);
    container.innerHTML = '<div class="empty-state"><small>Error loading status</small></div>';
    searchQuery.disabled = true;
    searchButton.disabled = true;
  }
}

/**
 * Update search sequences display (for Search tab)
 */
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

function areAllJobsComplete(statusData) {
  // Check if all jobs are in a terminal state
  if (!statusData || !statusData.jobs || statusData.jobs.length === 0) {
    return true; // No jobs means nothing to poll
  }

  // Check if there are any active jobs
  if (statusData.activeJobs > 0) {
    return false;
  }

  // Only check jobs with actual clips (ignore empty placeholder jobs)
  const realJobs = statusData.jobs.filter(job => job.totalClips > 0);

  if (realJobs.length === 0) {
    return true; // No real jobs to track
  }

  // Check if all real jobs are done (percentComplete === 100 or state === 'done')
  return realJobs.every(job =>
    job.state === 'done' ||
    job.state === 'complete' ||
    job.percentComplete === 100
  );
}

function updateInfraStatusDisplay(result) {
  const el = document.getElementById('infra-status-content');
  if (!el) return;

  if (result.ok) {
    const d = result.data;
    const allGood = d.chromaOk && d.ollamaOk;
    /*if (allGood) {
      el.innerHTML = `✅ Service online — Chroma & Ollama OK`;
      el.style.color = 'green';
    } else {
      const parts = [];
      parts.push(d.chromaOk ? 'Chroma OK' : 'Chroma ✖');
      parts.push(d.ollamaOk ? 'Ollama OK' : 'Ollama ✖');
      el.innerHTML = `⚠️ Service partial — ${parts.join(' • ')}`;
      el.style.color = '#b36b00';
    }*/

    // Store the status data for progress badge display
    window._storysmith_lastJobProgress = d;

    // Update the clips display to refresh progress badges
    updateClipsDisplay();

    // Check if all jobs are complete and stop polling if so
    if (areAllJobsComplete(d)) {
      stopInfraStatusPolling();
    }
  } else {
    el.innerHTML = `❌ Service unreachable (${escapeHtml(result.error || 'unknown')})`;
    el.style.color = 'crimson';
  }
}

function stopInfraStatusPolling() {
  if (window._storysmith_statusPoller) {
    clearInterval(window._storysmith_statusPoller);
    window._storysmith_statusPoller = null;
    console.log('✅ All jobs complete - stopped status polling');
  }
}

function startInfraStatusPolling(intervalMs = 5000) {
  // Stop existing poller if running
  if (window._storysmith_statusPoller) {
    clearInterval(window._storysmith_statusPoller);
    window._storysmith_statusPoller = null;
  }

  console.log('🔄 Starting status polling...');

  // run immediately, then every interval
  (async () => {
    // If a job is active, prefer fetching job progress
    const jobId = window._storysmith_currentJobId;
    if (jobId) {
      await fetchJobProgress(jobId);
      // Job progress fetched but not displayed
    } else {
      const r = await fetchServerStatus();
      updateInfraStatusDisplay(r);
    }
  })();

  const id = setInterval(async () => {
    const jobId = window._storysmith_currentJobId;
    if (jobId) {
      await fetchJobProgress(jobId);
      // Job progress fetched but not displayed
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
 * Navigate to a specific sequence and timecode in Premiere Pro
 * @param {string} sequenceName - Name of the sequence to activate
 * @param {number} timecodeSeconds - Timecode in seconds to navigate to
 */
async function navigateToSequence(sequenceName, timecodeSeconds) {
  console.log(`[Navigation] Navigating to sequence "${sequenceName}" at ${formatTimecode(timecodeSeconds)}`);

  try {
    const project = await ppro.Project.getActiveProject();
    const sequences = await project.getSequences();

    // Find the target sequence
    let targetSequence = null;
    for (let i = 0; i < sequences.length; i++) {
      if (sequences[i].name === sequenceName) {
        targetSequence = sequences[i];
        console.log(`[Navigation] Found sequence at index ${i}`);
        break;
      }
    }

    if (!targetSequence) {
      throw new Error(`Sequence "${sequenceName}" not found in project`);
    }

    // Open the sequence
    await project.openSequence(targetSequence);
    console.log(`[Navigation] ✅ Opened sequence in timeline`);

    // Try to set playhead position
    // Calculate ticks from seconds
    const ticksPerSecond = 254016000000;
    const targetTicks = Math.round(timecodeSeconds * ticksPerSecond);
    const ticksString = targetTicks.toString();

    console.log(`[Navigation] Attempting to set playhead to ${timecodeSeconds}s (${ticksString} ticks)`);

    // Give Premiere a moment to finish opening the sequence
    await new Promise(resolve => setTimeout(resolve, 300));

    console.log(`[Navigation] Setting playhead to ${formatTimecode(timecodeSeconds)} (${timecodeSeconds}s)`);

    // setPlayerPosition() requires a TickTime object
    // Use ppro.TickTime.createWithSeconds() to create one
    try {
      const tickTime = ppro.TickTime.createWithSeconds(timecodeSeconds);
      console.log(`[Navigation] Created TickTime:`, tickTime);
      console.log(`[Navigation]   - seconds: ${tickTime.seconds}`);
      console.log(`[Navigation]   - ticks: ${tickTime.ticks}`);

      await targetSequence.setPlayerPosition(tickTime);
      console.log(`[Navigation] ✅ Playhead positioned at ${formatTimecode(timecodeSeconds)}!`);

      return {
        success: true,
        sequenceName: sequenceName,
        timecode: formatTimecode(timecodeSeconds),
        opened: true,
        playheadSet: true
      };
    } catch (err) {
      console.error(`[Navigation] ❌ Failed to set playhead:`, err);
      throw err;
    }

  } catch (error) {
    console.error(`[Navigation] Error:`, error);
    throw new Error(`Failed to navigate to sequence: ${error.message}`);
  }
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
    const projectId = window.currentProjectPath.replace(/[^a-zA-Z0-9]/g, '_').slice(-40);
    const projectName = window.currentProjectPath.split('/').pop() ?? 'unknown';

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
        projectId: projectId || undefined
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
          // Find the clip in allClips to get sequence name
          const clip = allClips.find(c => c.id === hit.clipId);
          const sequenceName = clip ? clip.sequenceName : 'Unknown Sequence';

          // Extract clip name from filePath
          const clipName = hit.filePath ? hit.filePath.split('/').pop() : hit.clipId || 'Result';

          // Convert absoluteStart and absoluteEnd (seconds) to timecodes
          const inTimecode = typeof hit.absoluteStart === 'number' ? formatTimecode(hit.absoluteStart) : '';
          const outTimecode = typeof hit.absoluteEnd === 'number' ? formatTimecode(hit.absoluteEnd) : '';

          const snippet = hit.chunkText || '';

          resultsHtml += `
            <div class="search-result-item" data-clipid="${escapeHtml(hit.clipId || '')}" data-timecode="${hit.absoluteStart || 0}">
              <div class="search-result-title-row">
                <div class="search-result-title">${escapeHtml(sequenceName)}</div>
                <button class="view-in-sequence-btn"
                        data-sequence-name="${escapeHtml(sequenceName)}"
                        data-timecode="${hit.absoluteStart || 0}">
                  View in Sequence
                </button>
              </div>
              <div class="search-result-details">
                ${inTimecode && outTimecode ? `⏱️ ${inTimecode} - ${outTimecode}` : ''}
                ${clipName ? ` • 🎬 ${escapeHtml(clipName)}` : ''}
              </div>
              ${snippet ? `<div class="search-result-snippet">${escapeHtml(snippet)}</div>` : ''}
            </div>
          `;
        }

        resultsContent.innerHTML = resultsHtml;
        resultsDiv.style.display = "block";

        // Add click handlers to "View in Sequence" buttons
        const viewButtons = resultsContent.querySelectorAll(".view-in-sequence-btn");
        viewButtons.forEach(button => {
          button.addEventListener("click", async (e) => {
            e.stopPropagation(); // Prevent parent click handler

            const sequenceName = button.getAttribute("data-sequence-name");
            const timecode = parseFloat(button.getAttribute("data-timecode") || "0");

            console.log(`🎯 Navigating to sequence "${sequenceName}" at ${formatTimecode(timecode)}`);

            try {
              await navigateToSequence(sequenceName, timecode);
            } catch (error) {
              console.error("❌ Failed to navigate to sequence:", error);
              // TODO: Show error message to user
            }
          });
        });

        // Add click handlers to result items (for future use)
        const resultItems = resultsContent.querySelectorAll(".search-result-item");
        resultItems.forEach(item => {
          item.addEventListener("click", () => {
            const clipId = item.getAttribute("data-clipid");
            const timecode = parseFloat(item.getAttribute("data-timecode") || "0");
            console.log(`📍 Result clicked: ${clipId} at ${formatTimecode(timecode)}`);
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

  // Update sequence status when Search tab is activated
  if (tabName === "search-tab") {
    updateSequenceStatusDisplay();
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
  document.getElementById("btnRefreshSequences").addEventListener("click", async () => {
    console.log("🔄 Refreshing sequences from project...");
    try {
      await loadClipsFromProject();
      console.log(`✅ Refresh complete - ${allClips.length} clips loaded from ${new Set(allClips.map(c => c.sequenceName)).size} sequences`);
    } catch (error) {
      console.error("❌ Error refreshing sequences:", error);
    }
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
