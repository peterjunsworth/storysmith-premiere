import type { Config } from '../types/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotEnv(): void {
  // Try CWD first, then look two levels up (for scripts run from subdirs)
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '..', '.env'),
  ];
  for (const envPath of candidates) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match && !(match[1] in process.env)) {
          process.env[match[1]] = match[2].trim();
        }
      }
      break; // stop after first found
    } catch {
      // .env is optional
    }
  }
}

loadDotEnv();

export function loadConfig(): Config {
  return {
    whisperBin: process.env.WHISPER_BIN ?? 'whisper',
    whisperModel: process.env.WHISPER_MODEL ?? '/usr/local/share/whisper/ggml-base.en.bin',
    whisperThreads: parseInt(process.env.WHISPER_THREADS ?? '4', 10),
    whisperConcurrency: parseInt(process.env.WHISPER_CONCURRENCY ?? '1', 10),

    ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
    ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
    ollamaLlmModel: process.env.OLLAMA_LLM_MODEL ?? 'llama3.2',

    chromaUrl: process.env.CHROMA_URL ?? 'http://localhost:8000',

    port: parseInt(process.env.PORT ?? '3100', 10),
    serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? '3100'}`,

    timelineWatchGlob: process.env.TIMELINE_WATCH_GLOB ?? './data/timelines/**/*.json',

    claraNHypotheses: parseInt(process.env.CLARA_N_HYPOTHESES ?? '4', 10),
  };
}
