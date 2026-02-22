import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../types/index.js';

export interface TimedSegment {
  text: string;
  startMs: number;   // milliseconds from audio start
  endMs: number;
}

interface WhisperJsonOutput {
  transcription: Array<{
    text: string;
    offsets?: { from: number; to: number };  // ms, present when timestamps enabled
  }>;
}

export class WhisperService {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async transcribe(inputFilePath: string): Promise<TimedSegment[]> {
    const ext = extname(inputFilePath).toLowerCase();
    let wavPath = inputFilePath;
    let tempWav: string | null = null;

    // Convert to 16kHz mono WAV if not already WAV
    if (ext !== '.wav') {
      tempWav = join(tmpdir(), `whisper-${Date.now()}-${basename(inputFilePath, ext)}.wav`);
      await this.convertToWav(inputFilePath, tempWav);
      wavPath = tempWav;
    }

    try {
      return await this.runWhisper(wavPath);
    } finally {
      if (tempWav) {
        await fs.unlink(tempWav).catch(() => {});
      }
    }
  }

  private convertToWav(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y',
        outputPath,
      ];

      console.log(`[Whisper] Converting to WAV: ffmpeg ${args.join(' ')}`);

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stderr: string[] = [];

      proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-5).join('')}`));
        }
      });

      proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    });
  }

  private async runWhisper(wavPath: string): Promise<TimedSegment[]> {
    // Output JSON to a temp file: whisper writes <prefix>.json
    const outPrefix = join(tmpdir(), `whisper-out-${Date.now()}`);
    const outJsonPath = `${outPrefix}.json`;

    // Timestamps are enabled by default (no --no-timestamps flag).
    // whisper.cpp JSON output includes offsets.from / offsets.to in milliseconds.
    const args = [
      '-m', this.config.whisperModel,
      '-f', wavPath,
      '-t', String(this.config.whisperThreads),
      '--output-json',
      '-of', outPrefix,
    ];

    console.log(`[Whisper] Running: ${this.config.whisperBin} ${args.join(' ')}`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.config.whisperBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: string[] = [];
      const stderr: string[] = [];

      proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
      proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`whisper exited ${code}: ${stderr.slice(-10).join('')}`));
        }
      });

      proc.on('error', (err) => reject(new Error(`whisper spawn failed: ${err.message}. Is WHISPER_BIN set?`)));
    });

    try {
      const raw = await fs.readFile(outJsonPath, 'utf-8');
      const parsed: WhisperJsonOutput = JSON.parse(raw);
      return parsed.transcription.map((seg) => ({
        text: seg.text.trim(),
        startMs: seg.offsets?.from ?? 0,
        endMs: seg.offsets?.to ?? 0,
      }));
    } finally {
      await fs.unlink(outJsonPath).catch(() => {});
    }
  }
}
