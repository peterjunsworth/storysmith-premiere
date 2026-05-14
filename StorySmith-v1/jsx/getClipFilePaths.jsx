/*************************************************************************
 * Get File Paths Directly from Project Items
 *
 * This ExtendScript function retrieves file paths with proper slashes
 * directly from Premiere Pro's project items, bypassing the Media Cache
 * database which corrupts paths by replacing separators with spaces.
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

    var results = [];

    // Recursive function to traverse all project items
    function traverseProjectItems(bin) {
      try {
        var numChildren = bin.children.numItems;

        for (var i = 0; i < numChildren; i++) {
          try {
            var item = bin.children[i];
            if (!item) continue;

            // Check if this is a bin (folder) - recurse into it
            if (item.type === 2) { // ProjectItemType.BIN
              traverseProjectItems(item);
              continue;
            }

            // Skip sequences
            if (item.type === 4) { // ProjectItemType.SEQUENCE
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

            // Skip items without media
            if (!hasVideo && !hasAudio) {
              continue;
            }

            var clipName = item.name || "Unnamed";
            var filePath = "";

            // Try to get the full OS file path with proper slashes
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
                } else if (item.file.fullName) {
                  filePath = item.file.fullName;
                  $.writeln("DEBUG [file.fullName]: " + clipName + " -> " + filePath);
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

            // Only add items that have a valid file path
            if (filePath && filePath.length > 0) {
              results.push({
                clipName: clipName,
                filePath: filePath,
                hasAudio: hasAudio,
                hasVideo: hasVideo
              });
            }

          } catch (e) {
            // Error processing item, skip it
            $.writeln("Error processing item " + i + ": " + e.toString());
          }
        }
      } catch (e) {
        $.writeln("Error traversing bin: " + e.toString());
      }
    }

    // Start traversal from root project
    traverseProjectItems(project.rootItem);

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
