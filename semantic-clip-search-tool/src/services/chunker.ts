import type { TimedSegment } from './whisper.js';

const CHUNK_SIZE_WORDS = 120;
const OVERLAP_WORDS = 20;
const SENTENCE_END = /[.!?]/;

export interface TimedChunk {
  text: string;
  chunkIndex: number;
  startMs: number;   // milliseconds from audio start (first segment in chunk)
  endMs: number;     // milliseconds from audio start (last segment in chunk)
}

export class ChunkService {
  chunk(segments: TimedSegment[]): TimedChunk[] {
    if (segments.length === 0) return [];

    // Flatten segments into an array of timed words
    interface TimedWord { word: string; segStartMs: number; segEndMs: number }
    const timedWords: TimedWord[] = [];
    for (const seg of segments) {
      const words = seg.text.split(/\s+/).filter((w) => w.length > 0);
      for (const word of words) {
        timedWords.push({ word, segStartMs: seg.startMs, segEndMs: seg.endMs });
      }
    }

    if (timedWords.length === 0) return [];

    const chunks: TimedChunk[] = [];
    let start = 0;

    while (start < timedWords.length) {
      const end = Math.min(start + CHUNK_SIZE_WORDS, timedWords.length);
      let sliceEnd = end;

      // Walk back to the nearest sentence boundary if not at end of text
      if (end < timedWords.length) {
        for (let i = end - 1; i >= start + OVERLAP_WORDS; i--) {
          if (SENTENCE_END.test(timedWords[i].word)) {
            sliceEnd = i + 1;
            break;
          }
        }
      }

      const slice = timedWords.slice(start, sliceEnd);
      chunks.push({
        text: slice.map((w) => w.word).join(' '),
        chunkIndex: chunks.length,
        startMs: slice[0].segStartMs,
        endMs: slice[slice.length - 1].segEndMs,
      });

      // Advance with overlap: next chunk starts OVERLAP_WORDS before end
      const nextStart = sliceEnd - OVERLAP_WORDS;
      start = nextStart > start ? nextStart : sliceEnd;

      if (start >= timedWords.length) break;
    }

    return chunks;
  }
}
