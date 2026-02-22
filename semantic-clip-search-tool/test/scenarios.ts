// Benchmark search scenarios with annotated ground truth.
// Each scenario defines:
//   query        — natural language search query
//   clipId       — expected clip that should appear in top-3 results
//   windowStart  — earliest acceptable timelineStart on hit (seconds from clip start)
//   windowEnd    — latest acceptable timelineStart on hit (seconds from clip start)
//   keyPhrases   — strings that must appear in matched chunk text (case-insensitive, any 1 of N)
//   description  — human-readable label for reporting

import type { SearchScenario } from './types.js';

export const scenarios: SearchScenario[] = [
  {
    id: 'S1',
    description: 'Huck hiding still watching the search party pass by on the island',
    query: 'person hiding quietly in the woods watching people search nearby',
    clipId: 'clip_bench_ch08',
    // Chapter 8 opens with the cannon scene; hiding in leaves is ~4–8 min in
    windowStart: 200,
    windowEnd: 600,
    keyPhrases: [
      'kept still',
      'hiding',
      'leaves',
      'set there',
      'cannon',
      'clump of bushes',
      'crept along',
    ],
  },

  {
    id: 'S2',
    description: 'Jim mistakes Huck for a ghost and begs him not to harm him',
    query: 'man thinks someone is a ghost and begs not to be hurt',
    clipId: 'clip_bench_ch08',
    // Jim ghost scene is roughly 12–16 min in (~720–960s)
    windowStart: 650,
    windowEnd: 1000,
    keyPhrases: [
      "doan' hurt me",
      'ghost',
      'ghos',
      'hain\'t ever done no harm',
      'ole jim',
      'awluz yo\' fren',
    ],
  },

  {
    id: 'S3',
    description: 'Colonel Grangerford described as a tall, slim, aristocratic gentleman',
    query: 'description of a gentleman who was tall slim aristocratic with dark eyes',
    clipId: 'clip_bench_ch18',
    // Ch18 opens with Col Grangerford description — ~1–4 min in (0–240s from clip start)
    windowStart: 0,
    windowEnd: 300,
    keyPhrases: [
      'grangerford',
      'gentleman',
      'tall and very slim',
      'darkish',
      'mahogany cane',
      'brass buttons',
      'liberty-pole',
    ],
  },

  {
    id: 'S4',
    description: 'Buck explains how a feud works and lists casualties on both sides',
    query: 'someone explaining how a feud starts with a quarrel and killing on both sides',
    clipId: 'clip_bench_ch18',
    // Feud explanation ~10–14 min in (600–840s from clip start)
    windowStart: 550,
    windowEnd: 900,
    keyPhrases: [
      'feud',
      'quarrel',
      'kills him',
      'thirty year ago',
      'shepherdson',
      'lawsuit',
      'buck-shot',
    ],
  },

  {
    id: 'S5',
    description: 'Imposters claiming to be the real Harvey Wilks when the actual relatives arrive',
    query: 'two men pretending to be relatives while the real relatives confront them',
    clipId: 'clip_bench_ch29',
    // Chapter 29 opens immediately with the real Harvey arriving — 0–5 min (0–300s)
    windowStart: 0,
    windowEnd: 400,
    keyPhrases: [
      'harvey wilks',
      'frauds',
      'rascals',
      'newcomers',
      'imposters',
      'two sets',
      'gentleman',
    ],
  },

  {
    id: 'S6',
    description: 'Huck escapes in the dark after the gold is found in the coffin at the graveyard',
    query: 'person escaping through a storm at night running away from a crowd',
    clipId: 'clip_bench_ch29',
    // Graveyard escape is ~17–21 min in (1020–1260s from clip start)
    windowStart: 950,
    windowEnd: 1382,
    keyPhrases: [
      'graveyard',
      'coffin',
      'gold',
      'hines',
      'lit out',
      'shinned for the road',
      'thunder',
      'canoe',
      'set her loose',
    ],
  },
];
