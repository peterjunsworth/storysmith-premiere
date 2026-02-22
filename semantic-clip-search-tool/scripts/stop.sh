#!/usr/bin/env bash
# stop.sh — Stop only the services that start.sh launched for this project.
#
# Reads .pids (written by start.sh) to find which PIDs were started here.
# Services that were already running when start:full was invoked are left alone.
#
# Services stopped (only if started by this project):
#   api       — Node.js API server (src/api/server.ts)
#   chromadb  — ChromaDB Python process
#   ollama    — Ollama serve process
#
# Usage:
#   npm run stop:full
#   bash scripts/stop.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/.pids"
PORT="${PORT:-3100}"
CHROMA_URL="${CHROMA_URL:-http://localhost:8000}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
DIM='\033[2m'
RESET='\033[0m'

ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
info()  { printf "${BOLD}▸${RESET} %s\n" "$*"; }
skip()  { printf "${DIM}–${RESET} %s\n" "$*"; }

printf "\n${BOLD}=== Premiere Semantic Search — Stop ===${RESET}\n\n"

# ── Pidfile lookup ────────────────────────────────────────────────────────────

pid_for() {
  local name="$1"
  if [[ -f "$PIDFILE" ]]; then
    awk -v svc="$name" '$1 == svc { print $2 }' "$PIDFILE"
  fi
}

# Stop one service by name.
# Returns 0 whether the process was running or not (idempotent).
stop_service() {
  local name="$1"
  local display="$2"
  local pid
  pid="$(pid_for "$name")"

  if [[ -z "$pid" ]]; then
    skip "$display  — not in .pids (was not started by start:full, leaving alone)"
    return
  fi

  # Check the process is still alive
  if ! kill -0 "$pid" 2>/dev/null; then
    skip "$display  PID $pid — already gone"
    # Clean the stale entry
    grep -v "^${name} " "$PIDFILE" > "${PIDFILE}.tmp" 2>/dev/null || true
    mv "${PIDFILE}.tmp" "$PIDFILE"
    return
  fi

  info "Stopping $display  (PID $pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait up to 5 s for graceful exit
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [[ $waited -lt 50 ]]; do
    sleep 0.1
    (( waited++ )) || true
  done

  if kill -0 "$pid" 2>/dev/null; then
    warn "$display  did not exit after 5s — sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.2
  fi

  if kill -0 "$pid" 2>/dev/null; then
    fail "$display  PID $pid — could not be stopped"
  else
    ok "$display  stopped  (PID $pid)"
    # Remove entry from pidfile
    grep -v "^${name} " "$PIDFILE" > "${PIDFILE}.tmp" 2>/dev/null || true
    mv "${PIDFILE}.tmp" "$PIDFILE"
  fi
}

# ── Stop services (reverse start order) ──────────────────────────────────────

stop_service "api"      "API server  :${PORT}"
stop_service "chromadb" "ChromaDB    ${CHROMA_URL}"
stop_service "ollama"   "Ollama      ${OLLAMA_URL}"

# ── Clean up empty pidfile ────────────────────────────────────────────────────

if [[ -f "$PIDFILE" ]]; then
  # If the file is now empty (or only whitespace), remove it
  if [[ ! -s "$PIDFILE" ]] || ! grep -qE '\S' "$PIDFILE" 2>/dev/null; then
    rm -f "$PIDFILE"
    info "Removed empty .pids file"
  else
    warn "Some entries remain in .pids — services not started by this script are untouched"
    printf "${DIM}"
    sed 's/^/  /' "$PIDFILE"
    printf "${RESET}"
  fi
fi

printf "\n"
ok "Done."
printf "\n"
