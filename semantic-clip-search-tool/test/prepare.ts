#!/usr/bin/env tsx
/**
 * prepare.ts — Download benchmark audio clips and build timeline.json
 *
 * Usage:
 *   tsx test/prepare.ts
 *
 * Downloads 3 LibriVox chapters of Huckleberry Finn (~20 MB each) from
 * archive.org, converts to 16 kHz mono WAV via ffmpeg, and writes
 * test/fixtures/timeline.json with absolute paths pointing at the WAV files.
 *
 * Requires: ffmpeg on PATH.
 * Safe to re-run — skips download if WAV already exists.
 */

import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline as streamPipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const AUDIO_DIR = resolve(FIXTURES, 'audio');
const TIMELINE_TEMPLATE = resolve(FIXTURES, 'timeline.json');

// ── Clip definitions ─────────────────────────────────────────────────────────

interface ClipDef {
  id: string;
  filename: string;   // wav output filename
  mp3Url: string;
  approxDurationSec: number;  // for timeline.json
}

const CLIPS: ClipDef[] = [
  {
    id: 'clip_bench_ch08',
    filename: 'huckfinn_08_twain_apc.wav',
    mp3Url: 'https://archive.org/download/huck_finn_librivox/huckfinn_08_twain_apc.mp3',
    approxDurationSec: 1389,   // 23 min 09 sec
  },
  {
    id: 'clip_bench_ch18',
    filename: 'huckfinn_18_twain_apc.wav',
    mp3Url: 'https://archive.org/download/huck_finn_librivox/huckfinn_18_twain_apc.mp3',
    approxDurationSec: 1652,   // 27 min 32 sec
  },
  {
    id: 'clip_bench_ch29',
    filename: 'huckfinn_29_twain_apc.wav',
    mp3Url: 'https://archive.org/download/huck_finn_librivox/huckfinn_29_twain_apc.mp3',
    approxDurationSec: 1382,   // 23 min 02 sec
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`  Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error('No response body');
  const out = createWriteStream(destPath);
  await streamPipeline(res.body as any, out);
}

function convertToWav(mp3Path: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-i', mp3Path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errs: string[] = [];
    proc.stderr.on('data', (d: Buffer) => errs.push(d.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${errs.slice(-3).join('')}`));
    });
    proc.on('error', (e) => reject(new Error(`ffmpeg not found: ${e.message}`)));
  });
}

async function getWavDuration(wavPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'csv=p=0', wavPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('close', () => resolve(parseFloat(out.trim()) || 0));
    proc.on('error', () => resolve(0));  // ffprobe not critical
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

await fs.mkdir(AUDIO_DIR, { recursive: true });

console.log('=== Benchmark Audio Preparation ===\n');

const durations: Record<string, number> = {};

for (const clip of CLIPS) {
  const wavPath = resolve(AUDIO_DIR, clip.filename);
  const mp3Path = resolve(AUDIO_DIR, clip.filename.replace('.wav', '.mp3'));

  process.stdout.write(`[${clip.id}] ${clip.filename}\n`);

  if (await fs.access(wavPath).then(() => true).catch(() => false)) {
    console.log('  WAV already exists — skipping download');
    const dur = await getWavDuration(wavPath);
    durations[clip.id] = dur || clip.approxDurationSec;
    console.log(`  Duration: ${(durations[clip.id] / 60).toFixed(1)} min\n`);
    continue;
  }

  // Download MP3
  await downloadFile(clip.mp3Url, mp3Path);
  console.log(`  Saved MP3 → ${mp3Path}`);

  // Convert to 16 kHz mono WAV
  process.stdout.write('  Converting to WAV (16 kHz mono)...');
  await convertToWav(mp3Path, wavPath);
  console.log(' done');

  // Remove intermediate MP3 to save space
  await fs.unlink(mp3Path);

  const dur = await getWavDuration(wavPath);
  durations[clip.id] = dur || clip.approxDurationSec;
  console.log(`  Duration: ${(durations[clip.id] / 60).toFixed(1)} min\n`);
}

// ── Patch timeline.json with real absolute paths and measured durations ──────

const raw = await fs.readFile(TIMELINE_TEMPLATE, 'utf-8');

// Replace __FIXTURES_DIR__ placeholder
let patched = raw.replaceAll('__FIXTURES_DIR__', FIXTURES);

// Rebuild accurate timelineStart/End values from measured durations
const timelineJson = JSON.parse(patched);
let cursor = 0;

for (const clip of timelineJson.sequences[0].clips) {
  if (!clip.hasAudio) continue;
  const dur = durations[clip.id] ?? clip.duration;
  clip.timelineStart = cursor;
  clip.timelineEnd = cursor + dur;
  clip.outPoint = dur;
  clip.duration = dur;
  cursor += dur;
}
timelineJson.sequences[0].totalDuration = cursor;

const outPath = resolve(FIXTURES, 'timeline.json');
await fs.writeFile(outPath, JSON.stringify(timelineJson, null, 2));

console.log(`=== timeline.json written: ${outPath} ===`);
console.log('\nAll clips ready. Run the eval with:');
console.log('  tsx test/run-eval.ts\n');
