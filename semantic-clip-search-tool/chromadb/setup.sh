#!/usr/bin/env bash
# setup.sh — Create the Python venv and install ChromaDB.
#
# Safe to re-run: skips installation if the venv already exists and
# the installed chromadb version satisfies requirements.txt.
#
# Usage:
#   bash chromadb/setup.sh
#
# After running, the chroma CLI is available at:
#   chromadb/.venv/bin/chroma
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/.venv"
REQ="$SCRIPT_DIR/requirements.txt"

BOLD='\033[1m'
GREEN='\033[32m'
RESET='\033[0m'

ok()   { printf "${GREEN}✓${RESET} %s\n" "$*"; }
info() { printf "${BOLD}▸${RESET} %s\n" "$*"; }

# ── Python check ──────────────────────────────────────────────────────────────

if ! command -v python3 &>/dev/null; then
  printf '\033[31m✗\033[0m python3 not found — install Python 3.8+ first\n'
  exit 1
fi
PYTHON_VER="$(python3 --version)"
ok "Python: $PYTHON_VER"

# ── Venv ──────────────────────────────────────────────────────────────────────

if [[ ! -d "$VENV" ]]; then
  info "Creating virtual environment at chromadb/.venv ..."
  python3 -m venv "$VENV"
  ok "Virtual environment created"
else
  ok "Virtual environment already exists"
fi

# ── Install / upgrade ─────────────────────────────────────────────────────────

info "Installing packages from requirements.txt ..."
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$REQ"

CHROMA_VER="$("$VENV/bin/chroma" --version 2>/dev/null || echo 'unknown')"
ok "ChromaDB installed: $CHROMA_VER"

printf '\n'
printf '  chroma CLI:  %s/bin/chroma\n' "$VENV"
printf '  Start DB:    npm run db:up\n'
printf '\n'
