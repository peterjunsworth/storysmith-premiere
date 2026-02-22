import type { Config } from '../types/index.js';

const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const RESET = '\x1b[0m';

function ok(msg: string)   { process.stdout.write(`${GREEN}✓${RESET} ${msg}\n`); }
function fail(msg: string) { process.stdout.write(`${RED}✗${RESET} ${msg}\n`); }
function hint(msg: string) { process.stdout.write(`  ${msg}\n`); }

async function ping(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check that ChromaDB and Ollama are reachable.
 * Prints status for each service and exits with code 1 if any are down.
 * Call at the top of CLI commands and before starting the server.
 */
export async function checkDeps(config: Config): Promise<void> {
  process.stdout.write(`${BOLD}Checking services...${RESET}\n`);

  let failed = false;

  // ChromaDB — v2 API (v1 is deprecated in chromadb >=1.4.0)
  const chromaOk = await ping(`${config.chromaUrl}/api/v2/heartbeat`);
  if (chromaOk) {
    ok(`ChromaDB  ${config.chromaUrl}`);
  } else {
    fail(`ChromaDB not reachable at ${config.chromaUrl}`);
    hint('Run:  npm run db:up');
    failed = true;
  }

  // Ollama
  const ollamaOk = await ping(`${config.ollamaUrl}/api/tags`);
  if (ollamaOk) {
    ok(`Ollama    ${config.ollamaUrl}`);
  } else {
    fail(`Ollama not reachable at ${config.ollamaUrl}`);
    hint('Run:  ollama serve');
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }
}
