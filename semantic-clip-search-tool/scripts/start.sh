#!/usr/bin/env bash
# start.sh — Validate all infrastructure and start the API server.
#
# Checks (in order):
#   1. ChromaDB reachable on :8000
#   2. Ollama reachable on :11434
#   3. Required Ollama models present (nomic-embed-text, llama3.2)
#
# If ChromaDB is not up, starts it here (records its PID).
# If Ollama is not up, starts it here (records its PID).
# PIDs of services started by this script are written to .pids so that
# stop.sh can stop only them — never touching pre-existing instances.
#
# Usage:
#   npm run start:full
#   bash scripts/start.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHROMA_URL="${CHROMA_URL:-http://localhost:8000}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
PORT="${PORT:-3100}"
PIDFILE="$ROOT/.pids"
LOG_DIR="$ROOT/logs"

cd "$ROOT"

BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail() { printf "${RED}✗${RESET} %s\n" "$*"; }
warn() { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
info() { printf "${BOLD}▸${RESET} %s\n" "$*"; }

printf "\n${BOLD}=== Premiere Semantic Search ===${RESET}\n\n"

# ── Pidfile helpers ───────────────────────────────────────────────────────────
# Each line in .pids:  <service-name> <pid>

pidfile_set() {
  local name="$1" pid="$2"
  # Remove any existing entry for this service then append
  if [[ -f "$PIDFILE" ]]; then
    grep -v "^${name} " "$PIDFILE" > "${PIDFILE}.tmp" 2>/dev/null || true
    mv "${PIDFILE}.tmp" "$PIDFILE"
  fi
  printf "%s %s\n" "$name" "$pid" >> "$PIDFILE"
}

# ── 0. ChromaDB venv ──────────────────────────────────────────────────────────

CHROMA_BIN="$ROOT/chromadb/.venv/bin/chroma"
if [[ -f "$CHROMA_BIN" ]]; then
  ok "ChromaDB venv  $("$CHROMA_BIN" --version)"
else
  warn "ChromaDB venv not found — running setup..."
  bash "$ROOT/chromadb/setup.sh"
fi

DATA_DIR="$ROOT/data/chroma"

# ── 1. ChromaDB ───────────────────────────────────────────────────────────────

if curl -sf "${CHROMA_URL}/api/v2/heartbeat" > /dev/null 2>&1; then
  ok "ChromaDB  ${CHROMA_URL}  (already running — will not be stopped by stop:full)"
else
  info "ChromaDB not running — starting..."
  mkdir -p "$DATA_DIR" "$LOG_DIR"
  CHROMA_LOG="$LOG_DIR/chroma.log"

  "$CHROMA_BIN" run --path "$DATA_DIR" >> "$CHROMA_LOG" 2>&1 &
  CHROMA_PID=$!
  disown "$CHROMA_PID"

  # Wait up to 10 s for ChromaDB to respond
  CHROMA_UP=0
  for i in $(seq 1 20); do
    sleep 0.5
    if curl -sf "${CHROMA_URL}/api/v2/heartbeat" > /dev/null 2>&1; then
      CHROMA_UP=1; break
    fi
  done

  if [[ "$CHROMA_UP" -eq 0 ]]; then
    fail "ChromaDB did not start within 10s — check $CHROMA_LOG"
    exit 1
  fi

  pidfile_set "chromadb" "$CHROMA_PID"
  ok "ChromaDB  ${CHROMA_URL}  (started — PID ${CHROMA_PID})"
fi

# ── 2. Ollama ─────────────────────────────────────────────────────────────────

if curl -sf "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
  ok "Ollama    ${OLLAMA_URL}  (already running — will not be stopped by stop:full)"
else
  if ! command -v ollama &>/dev/null; then
    fail "Ollama not installed. Run bash scripts/install.sh"
    exit 1
  fi
  info "Ollama not running — starting..."
  OLLAMA_LOG="$LOG_DIR/ollama.log"
  mkdir -p "$LOG_DIR"
  ollama serve >> "$OLLAMA_LOG" 2>&1 &
  OLLAMA_PID=$!
  disown "$OLLAMA_PID"

  # Wait up to 10 s
  OLLAMA_UP=0
  for i in $(seq 1 20); do
    sleep 0.5
    if curl -sf "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
      OLLAMA_UP=1; break
    fi
  done

  if [[ "$OLLAMA_UP" -eq 0 ]]; then
    fail "Ollama did not start within 10s — check $OLLAMA_LOG"
    exit 1
  fi

  pidfile_set "ollama" "$OLLAMA_PID"
  ok "Ollama    ${OLLAMA_URL}  (started — PID ${OLLAMA_PID})"
fi

# ── 3. Ollama models ──────────────────────────────────────────────────────────

for model in nomic-embed-text llama3.2; do
  if ollama list 2>/dev/null | grep -q "^${model}"; then
    ok "Model     ${model}"
  else
    info "Pulling ${model}..."
    ollama pull "$model"
    ok "Model     ${model} (pulled)"
  fi
done

# ── 4. Start API server ───────────────────────────────────────────────────────

printf "\n"
ok "All services up — starting API server on :${PORT}"
info "PID file: ${PIDFILE}"
printf "\n"

# Write our own PID so stop.sh can kill the API server too.
# The API server replaces this process (exec), so $$ is the final PID.
pidfile_set "api" "$$"

exec npx tsx src/api/server.ts
