// Shared types for the benchmark test suite

export interface SearchScenario {
  id: string;
  description: string;
  query: string;
  clipId: string;
  windowStart: number;   // seconds from clip start — earliest valid hit
  windowEnd: number;     // seconds from clip start — latest valid hit
  keyPhrases: string[];  // any one of these must appear in the matched chunk text
}

export interface TranscriptComparisonResult {
  clipId: string;
  referenceWordCount: number;
  generatedWordCount: number;
  wer: number;                  // word error rate 0.0–1.0
  werPercent: string;
  commonWordsRatio: number;
  sampleReference: string;      // first 200 chars of reference
  sampleGenerated: string;      // first 200 chars of generated
}

export interface ScenarioResult {
  scenarioId: string;
  description: string;
  query: string;
  expectedClipId: string;
  topHitClipId: string | null;
  topHitScore: number | null;
  // Absolute Premiere timeline position from the chunk metadata (seconds)
  absoluteStart: number | null;
  absoluteEnd: number | null;
  // Position within the clip (seconds from clip audio start, derived from absoluteStart)
  clipRelativeStart: number | null;
  // Clip-level fields from ChromaDB metadata
  clipTimelineOffset: number;               // clip's timelineStart in Premiere
  chunkStartMs: number | null;              // chunk start within clip (ms)
  chunkEndMs: number | null;                // chunk end within clip (ms)
  hitInCorrectClip: boolean;               // top hit lands in expected clip
  hitInTimeWindow: boolean;                 // clipRelativeStart within [windowStart, windowEnd]
  keyPhraseMatched: boolean;               // any key phrase found in chunk text
  chunkText: string;
  top3ClipIds: string[];
  top3InCorrectClip: boolean;              // any of top-3 in correct clip
  passed: boolean;                         // all three: correct clip + window + phrase
}

export interface BenchmarkReport {
  runAt: string;
  durationMs: number;
  transcriptComparisons: TranscriptComparisonResult[];
  scenarios: ScenarioResult[];
  summary: {
    totalScenarios: number;
    passed: number;
    hitAt1: number;           // top-1 in correct clip
    hitAt3: number;           // top-3 contains correct clip
    windowAccuracy: number;   // % hits within timestamp window (of correct-clip hits)
    phraseMatchRate: number;  // % hits containing a key phrase
    avgTopScore: number;
    avgWer: number;
  };
}
