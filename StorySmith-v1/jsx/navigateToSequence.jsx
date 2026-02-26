/*************************************************************************
 * Navigate to Sequence and Set Playhead Position
 *
 * This ExtendScript opens a sequence by name and sets the playhead to
 * a specific timecode position in seconds.
 *
 * Parameters (passed as JSON string):
 * {
 *   "sequenceName": "Sequence 01",
 *   "timecodeSeconds": 123.456
 * }
 *
 * Returns JSON string:
 * { "success": true } or { "success": false, "error": "message" }
 **************************************************************************/

(function(paramsJson) {
  try {
    // Parse parameters
    var params = JSON.parse(paramsJson);
    var targetSequenceName = params.sequenceName;
    var timecodeSeconds = params.timecodeSeconds;

    if (!targetSequenceName || timecodeSeconds === undefined) {
      return JSON.stringify({
        success: false,
        error: "Missing required parameters: sequenceName and timecodeSeconds"
      });
    }

    // Get the active project
    var project = app.project;
    if (!project) {
      return JSON.stringify({
        success: false,
        error: "No active project found"
      });
    }

    // Find the target sequence by name
    var targetSequence = null;
    var numSequences = project.sequences.numSequences;

    for (var i = 0; i < numSequences; i++) {
      var seq = project.sequences[i];
      if (seq.name === targetSequenceName) {
        targetSequence = seq;
        break;
      }
    }

    if (!targetSequence) {
      return JSON.stringify({
        success: false,
        error: "Sequence '" + targetSequenceName + "' not found in project"
      });
    }

    // Open the sequence (make it active)
    project.activeSequence = targetSequence;

    // Convert seconds to ticks
    // Premiere Pro uses ticks for precise timing
    var timebase = targetSequence.timebase || 254016000000;
    var targetTicks = Math.round(timecodeSeconds * timebase);

    // Set the player position
    // In ExtendScript, we set the sequence's player position directly
    targetSequence.setPlayerPosition(targetTicks.toString());

    return JSON.stringify({
      success: true,
      sequenceName: targetSequenceName,
      timecodeSeconds: timecodeSeconds,
      ticks: targetTicks.toString()
    });

  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error.toString()
    });
  }
})($argument);
