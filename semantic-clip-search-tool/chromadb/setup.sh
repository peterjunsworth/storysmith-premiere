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

# ChromaDB (pydantic v1 compat layer) does not support Python 3.14+.
# Preferred: 3.13. Acceptable: 3.12, 3.11. Falls back to install via Homebrew.
TARGET_PYTHON_VERSION="3.13"

PYTHON_BIN=""
for candidate in python3.13 python3.12 python3.11; do
  if command -v "$candidate" &>/dev/null; then
    PYTHON_BIN="$candidate"
    break
  fi
done

if [[ -z "$PYTHON_BIN" ]]; then
  printf '\033[33m⚠\033[0m  No compatible Python found (3.11–3.13). Installing Python %s...\n' "$TARGET_PYTHON_VERSION"

  # Ensure Homebrew is available
  if ! command -v brew &>/dev/null; then
    info "Homebrew not found — installing..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add brew to PATH for the remainder of this script (Apple Silicon / Intel)
    if [[ -x /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -x /usr/local/bin/brew ]]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
  ok "Homebrew: $(brew --version | head -1)"

  info "Installing python@${TARGET_PYTHON_VERSION} via Homebrew..."
  brew install "python@${TARGET_PYTHON_VERSION}"
  PYTHON_BIN="python${TARGET_PYTHON_VERSION}"
fi

PYTHON_VER="$("$PYTHON_BIN" --version)"
ok "Python: $PYTHON_VER (via $PYTHON_BIN)"

# ── Venv ──────────────────────────────────────────────────────────────────────

if [[ ! -d "$VENV" ]]; then
  info "Creating virtual environment at chromadb/.venv ..."
  "$PYTHON_BIN" -m venv "$VENV"
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
