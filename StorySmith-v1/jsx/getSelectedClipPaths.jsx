/*************************************************************************
 * Get File Paths from Selected Project Items
 * 
 * This ExtendScript function retrieves the full OS file paths
 * for all selected clips in the Project panel.
 **************************************************************************/

(function() {
  try {
    var project = app.project;
    
    if (!project) {
      return JSON.stringify({
        success: false,
        error: "No active project found"
      });
    }
    
    // Get selected items from the project panel
    var selectedItems = app.project.getSelection();
    
    if (!selectedItems || selectedItems.length === 0) {
      return JSON.stringify({
        success: false,
        error: "No items selected in Project panel",
        results: []
      });
    }
    
    var results = [];
    
    // ProjectItemType constants
    // CLIP = 1, BIN = 2, FILE = 3, SEQUENCE = 4
    var ProjectItemType = {
      CLIP: 1,
      BIN: 2,
      FILE: 3,
      SEQUENCE: 4
    };
    
    // Loop through each selected item
    for (var i = 0; i < selectedItems.length; i++) {
      try {
        var item = selectedItems[i];
        if (!item) continue;
        
        var itemType = -1;
        try {
          itemType = item.type;
        } catch (e) {
          // Type might not be accessible
        }
        
        // Skip bins and sequences - we only want media clips
        if (itemType === ProjectItemType.BIN || itemType === ProjectItemType.SEQUENCE) {
          continue;
        }
        
        // Check if item has media (video or audio)
        var hasVideo = false;
        var hasAudio = false;
        
        try {
          hasVideo = item.hasVideo === true;
        } catch (e) {
          // hasVideo might not be accessible
        }
        
        try {
          hasAudio = item.hasAudio === true;
        } catch (e) {
          // hasAudio might not be accessible
        }
        
        // Skip items that don't have media (like titles, adjustment layers, etc.)
        if (!hasVideo && !hasAudio) {
          // Check file extension as fallback
          var name = (item.name || "").toLowerCase();
          var mediaExtensions = ['.mp4', '.mov', '.avi', '.mxf', '.wav', '.mp3', '.aac', '.m4a', '.aiff', '.mts', '.m2ts', '.flv', '.mkv', '.webm'];
          var hasMediaExtension = false;
          for (var extIdx = 0; extIdx < mediaExtensions.length; extIdx++) {
            if (name.indexOf(mediaExtensions[extIdx]) > -1) {
              hasMediaExtension = true;
              // Set hasAudio or hasVideo based on extension
              var audioExts = ['.wav', '.mp3', '.aac', '.m4a', '.aiff', '.flac', '.ogg', '.wma'];
              var videoExts = ['.mp4', '.mov', '.avi', '.mxf', '.mts', '.m2ts', '.flv', '.mkv', '.webm'];
              for (var aIdx = 0; aIdx < audioExts.length; aIdx++) {
                if (name.indexOf(audioExts[aIdx]) > -1) {
                  hasAudio = true;
                  break;
                }
              }
              for (var vIdx = 0; vIdx < videoExts.length; vIdx++) {
                if (name.indexOf(videoExts[vIdx]) > -1) {
                  hasVideo = true;
                  break;
                }
              }
              break;
            }
          }
          
          // Skip if no media extension either
          if (!hasMediaExtension) {
            continue;
          }
        }
        
        var clipName = item.name || "Unnamed";
        var filePath = "";

        // Try to get the full OS file path
        try {
          // Method 1: getMediaPath() - most reliable for project items
          if (item.getMediaPath && typeof item.getMediaPath === 'function') {
            filePath = item.getMediaPath();
            $.writeln("DEBUG [getMediaPath]: " + clipName + " -> " + filePath);
          }

          // Method 2: path property (if available)
          if (!filePath && item.path) {
            filePath = item.path;
            $.writeln("DEBUG [path property]: " + clipName + " -> " + filePath);
          }

          // Method 3: file property
          if (!filePath && item.file) {
            if (item.file.fsName) {
              filePath = item.file.fsName;
              $.writeln("DEBUG [file.fsName]: " + clipName + " -> " + filePath);
            } else if (item.file.toString) {
              filePath = item.file.toString();
              $.writeln("DEBUG [file.toString]: " + clipName + " -> " + filePath);
            } else if (typeof item.file === 'string') {
              filePath = item.file;
              $.writeln("DEBUG [file string]: " + clipName + " -> " + filePath);
            }
          }

          // Method 4: Try getFilePath() if available
          if (!filePath && item.getFilePath && typeof item.getFilePath === 'function') {
            filePath = item.getFilePath();
            $.writeln("DEBUG [getFilePath]: " + clipName + " -> " + filePath);
          }
        } catch (e) {
          // Error getting file path - item may be offline or generated media
          $.writeln("DEBUG [ERROR getting path]: " + clipName + " -> " + e.toString());
          filePath = "";
        }
        
        // Add to results
        results.push({
          clipName: clipName,
          filePath: filePath || "",
          hasAudio: hasAudio,
          hasVideo: hasVideo
        });
        
      } catch (e) {
        // Error processing item, skip it
        $.writeln("Error processing selected item " + i + ": " + e.toString());
      }
    }
    
    // Return JSON string
    return JSON.stringify({
      success: true,
      results: results,
      total: results.length
    });
    
  } catch (e) {
    return JSON.stringify({
      success: false,
      error: e.toString() + " (Line: " + (e.line || "unknown") + ")",
      results: []
    });
  }
})();



