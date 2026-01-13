/*************************************************************************
 * Extract Captions from Premiere Pro Sequence - Standalone ExtendScript
 * 
 * This script can be run directly in Premiere Pro via:
 * - ExtendScript Toolkit
 * - File > Scripts > Run Script
 * - Or from the Scripts panel
 * 
 * It extracts all captions from the active sequence's caption tracks
 * and saves them to a JSON file.
 * 
 * Output format: JSON array with objects like:
 * [{ "start": <seconds>, "end": <seconds>, "text": "<caption>" }, ...]
 **************************************************************************/

(function() {
  try {
    // Step 1: Get the active project and sequence
    var project = app.project;
    if (!project) {
      alert("No active project found. Please open a project in Premiere Pro.");
      return;
    }
    
    var seq = project.activeSequence;
    if (!seq) {
      alert("No active sequence found. Please open a sequence in Premiere Pro.");
      return;
    }
    
    // Step 2: Initialize variables for caption extraction
    var captionsArray = [];
    var timebase = seq.timebase || 254016000000; // Default timebase if not available
    
    // Step 3: Loop through all video tracks AND audio tracks to find caption tracks
    // Some setups may have caption clips on audio tracks (e.g., audio-only sequences)
    var numVideoTracks = seq.videoTracks ? seq.videoTracks.numTracks : 0;
    var numAudioTracks = seq.audioTracks ? seq.audioTracks.numTracks : 0;
    
    if (numVideoTracks === 0 && numAudioTracks === 0) {
      alert("No video or audio tracks found in the sequence.");
      return;
    }
    
    // Helper function to process a track (video or audio)
    function processTrack(track, trackType, trackName) {
      if (!track) return;
      
      // Check if this track is a caption track
      var isCaptionTrack = false;
      
      // Check if track is marked as a caption track
      if (track.isCaptionTrack === true) {
        isCaptionTrack = true;
      }
      // Check track name for caption/subtitle indicators
      else if (track.name) {
        var trackNameLower = track.name.toLowerCase();
        if (trackNameLower.indexOf("caption") !== -1 || 
            trackNameLower.indexOf("subtitle") !== -1 ||
            trackNameLower.indexOf("c1") !== -1 ||
            trackNameLower.indexOf("c2") !== -1 ||
            trackNameLower.indexOf("c3") !== -1) {
          isCaptionTrack = true;
        }
      }
      
      // Skip non-caption tracks
      if (!isCaptionTrack) return;
      
      // Loop through all clips in the caption track
      if (!track.clips) return;
      
      var numClips = track.clips.numItems || 0;
      
      for (var c = 0; c < numClips; c++) {
        try {
          var clip = track.clips[c];
          if (!clip) continue;
          
          // Extract caption data from each clip
          var captionData = {
            start: null,
            end: null,
            text: null,
            trackType: trackType,
            trackName: trackName || track.name || "Unnamed"
          };
          
          // Get start time (convert ticks to seconds)
          try {
            if (clip.start && clip.start.ticks !== undefined) {
              captionData.start = clip.start.ticks / timebase;
            } else if (clip.start !== undefined) {
              captionData.start = clip.start;
            } else if (clip.inPoint !== undefined) {
              if (clip.inPoint.ticks !== undefined) {
                captionData.start = clip.inPoint.ticks / timebase;
              } else {
                captionData.start = clip.inPoint;
              }
            }
          } catch (e) {
            // Start time not available
          }
          
          // Get end time (convert ticks to seconds)
          try {
            if (clip.end && clip.end.ticks !== undefined) {
              captionData.end = clip.end.ticks / timebase;
            } else if (clip.end !== undefined) {
              captionData.end = clip.end;
            } else if (clip.outPoint !== undefined) {
              if (clip.outPoint.ticks !== undefined) {
                captionData.end = clip.outPoint.ticks / timebase;
              } else {
                captionData.end = clip.outPoint;
              }
            }
          } catch (e) {
            // End time not available
          }
          
          // Get caption text from components
          try {
            if (clip.components && clip.components.numItems > 0) {
              // Loop through all components to find the caption component
              for (var k = 0; k < clip.components.numItems; k++) {
                try {
                  var comp = clip.components[k];
                  if (!comp) continue;
                  
                  // Check if this component is for captions
                  if (comp.displayName === "Captions" || 
                      comp.displayName === "Subtitle" ||
                      comp.displayName === "Text") {
                    
                    // Get text from component properties
                    if (comp.properties && comp.properties.length > 0) {
                      var textProp = comp.properties[0];
                      
                      // Try to get the text value
                      if (textProp && typeof textProp.getValue === 'function') {
                        captionData.text = textProp.getValue();
                      } else if (textProp && textProp.value !== undefined) {
                        captionData.text = textProp.value;
                      }
                      
                      // If we found text, break out of component loop
                      if (captionData.text) break;
                    }
                  }
                } catch (e) {
                  // Continue to next component if there's an error
                  continue;
                }
              }
              
              // If we didn't find text in a "Captions" component, try first component
              if (!captionData.text && clip.components.numItems > 0) {
                try {
                  var firstComp = clip.components[0];
                  if (firstComp && firstComp.properties && firstComp.properties.length > 0) {
                    var firstProp = firstComp.properties[0];
                    if (firstProp && typeof firstProp.getValue === 'function') {
                      captionData.text = firstProp.getValue();
                    } else if (firstProp && firstProp.value !== undefined) {
                      captionData.text = firstProp.value;
                    }
                  }
                } catch (e) {
                  // Fallback failed
                }
              }
            }
          } catch (e) {
            // Components access failed
          }
          
          // Add caption to array if we have text
          if (captionData.text !== null && 
              captionData.text !== "" && 
              captionData.text !== "undefined") {
            
            captionsArray.push({
              start: captionData.start,
              end: captionData.end,
              text: String(captionData.text),
              trackType: captionData.trackType,
              trackName: captionData.trackName
            });
          }
        } catch (e) {
          // Skip this clip if there's an error
          continue;
        }
      }
    }
    
    // Process all video tracks
    for (var t = 0; t < numVideoTracks; t++) {
      try {
        var track = seq.videoTracks[t];
        processTrack(track, "video", track ? track.name : null);
      } catch (e) {
        // Skip this track if there's an error
        continue;
      }
    }
    
    // Process all audio tracks (some setups may have caption clips on audio tracks)
    for (var t = 0; t < numAudioTracks; t++) {
      try {
        var track = seq.audioTracks[t];
        processTrack(track, "audio", track ? track.name : null);
      } catch (e) {
        // Skip this track if there's an error
        continue;
      }
    }
    
    // Step 9: Output results
    if (captionsArray.length === 0) {
      alert("No captions found. Make sure you have a caption track (like C1) with caption clips in your active sequence.");
      return;
    }
    
    // Step 10: Save to JSON file
    // Prompt user to select where to save the JSON file
    var saveFile = File.saveDialog("Save captions as JSON", "*.json");
    if (!saveFile) {
      alert("No file selected. Script cancelled.");
      return;
    }
    
    // Create JSON object with metadata
    // Each caption now includes trackType (video/audio) and trackName
    var jsonData = {
      success: true,
      sequenceName: seq.name || "Unnamed",
      totalCaptions: captionsArray.length,
      captions: captionsArray
    };
    
    // Convert to JSON string with pretty formatting
    var jsonString = JSON.stringify(jsonData, null, 2);
    
    // Write to file
    saveFile.encoding = "UTF-8";
    saveFile.open("w");
    saveFile.write(jsonString);
    saveFile.close();
    
    // Success message
    alert("Successfully extracted " + captionsArray.length + " captions from sequence: " + seq.name + "\n\nSaved to: " + saveFile.fsName);
    
    // Also output to console for debugging
    $.writeln("Extracted " + captionsArray.length + " captions from sequence: " + seq.name);
    $.writeln("Saved to: " + saveFile.fsName);
    
  } catch (e) {
    // Error handling
    var errorMsg = "Error extracting captions: " + e.toString();
    if (e.line) {
      errorMsg += " (Line: " + e.line + ")";
    }
    alert(errorMsg);
    $.writeln(errorMsg);
  }
})();

