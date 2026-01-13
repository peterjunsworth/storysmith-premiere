/*************************************************************************
 * Get Clips from Premiere Pro Project
 * 
 * This ExtendScript function retrieves all video and audio clips
 * from the active Premiere Pro project and returns them as JSON.
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
    
    var clips = [];
    var rootItem = project.rootItem;
    
    // Recursively search through all items in the project
    function searchItems(item) {
      if (!item) return;
      
      try {
        // Check if item has media (video or audio)
        // This is more reliable than checking item.type
        var hasMedia = false;
        var hasVideo = false;
        var hasAudio = false;
        
        try {
          hasVideo = item.hasVideo === true;
        } catch (e) {
          // hasVideo property might not exist or throw error
        }
        
        try {
          hasAudio = item.hasAudio === true;
        } catch (e) {
          // hasAudio property might not exist or throw error
        }
        
        hasMedia = hasVideo || hasAudio;
        
        // Also check item type as fallback
        // ProjectItemType.CLIP = 1, ProjectItemType.BIN = 2, ProjectItemType.FILE = 3
        var itemType = -1;
        try {
          itemType = item.type;
        } catch (e) {
          // type property might not be accessible
        }
        
        // Check if it's a bin (we want to skip bins)
        var isBin = false;
        try {
          isBin = (itemType === 2); // ProjectItemType.BIN = 2
        } catch (e) {}
        
        // Include item if it has media OR if it's a file/clip type
        // ProjectItemType.CLIP = 1, FILE = 3, BIN = 2, SEQUENCE = 4
        var isMediaItem = false;
        
        // Check if it's a media file type
        if (itemType === 1 || itemType === 3) {
          isMediaItem = true;
        }
        // Also check if it has video or audio properties
        else if (hasMedia) {
          isMediaItem = true;
        }
        // As a last resort, check file extension
        else if (itemType !== 2 && itemType !== 4 && item.name) {
          var name = item.name.toLowerCase();
          var mediaExtensions = ['.mp4', '.mov', '.avi', '.mxf', '.wav', '.mp3', '.aac', '.m4a', '.aiff'];
          for (var extIdx = 0; extIdx < mediaExtensions.length; extIdx++) {
            if (name.indexOf(mediaExtensions[extIdx]) > -1) {
              isMediaItem = true;
              break;
            }
          }
        }
        
        if (isMediaItem && !isBin && itemType !== 4) {
          var clipInfo = {
            id: item.nodeId ? item.nodeId.toString() : (item.name + "_" + clips.length),
            name: item.name || "Unnamed",
            type: hasVideo ? "video" : (hasAudio ? "audio" : "unknown"),
            hasVideo: hasVideo,
            hasAudio: hasAudio,
            filePath: "",
            duration: 0,
            itemType: itemType
          };
          
          // Try to get media path
          try {
            if (item.getMediaPath) {
              clipInfo.filePath = item.getMediaPath();
            }
          } catch (e) {
            // getMediaPath might not be available
          }
          
          // Try to get duration
          try {
            if (item.getOutPoint && item.getInPoint) {
              clipInfo.duration = item.getOutPoint() - item.getInPoint();
            }
          } catch (e) {
            // Duration methods might not be available
          }
          
          clips.push(clipInfo);
        }
        
        // Recursively search children (bins)
        if (item.children) {
          try {
            var numChildren = item.children.numItems;
            if (numChildren && numChildren > 0) {
              for (var i = 0; i < numChildren; i++) {
                try {
                  var childItem = item.children[i];
                  if (childItem) {
                    searchItems(childItem);
                  }
                } catch (e) {
                  // Skip this child if there's an error
                }
              }
            }
          } catch (e) {
            // children might not be accessible
          }
        }
      } catch (itemError) {
        // Continue searching even if one item fails
      }
    }
    
    // Start search from root
    if (rootItem) {
      searchItems(rootItem);
    }
    
    return JSON.stringify({
      success: true,
      clips: clips,
      totalCount: clips.length
    });
    
  } catch (e) {
    return JSON.stringify({
      success: false,
      error: e.toString() + " (Line: " + e.line + ")"
    });
  }
})();

