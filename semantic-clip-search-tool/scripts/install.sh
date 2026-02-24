#!/usr/bin/env bash
# install.sh — Full system setup for Premiere Semantic Search.
#
# Installs and configures all required dependencies:
#   1. Node.js ≥ 18
#   2. Xcode Command Line Tools (macOS) / build-essential (Linux)
#   3. CMake ≥ 3.26
#   4. ffmpeg
#   5. whisper.cpp (compiled with correct acceleration)
#   6. whisper model (base.en by default)
#   7. Ollama + required models (nomic-embed-text, llama3.2)
#   8. Python 3.8+
#   9. ChromaDB Python venv
#  10. npm install (Node dependencies)
#  11. .env file from .env.example
#
# Safe to re-run: each step checks before acting.
#
# Usage:
#   bash scripts/install.sh [--whisper-model <model>] [--skip-whisper] [--skip-ollama]
#
# Options:
#   --whisper-model <name>   Model to download (default: base.en)
#                            Options: tiny.en base.en small.en medium.en large-v3-turbo
#   --skip-whisper           Skip whisper.cpp build + model download
#   --skip-ollama            Skip Ollama install + model pull
#   --force-whisper          Rebuild whisper.cpp even if binary exists
set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────

WHISPER_MODEL_NAME="base.en"
SKIP_WHISPER=0
SKIP_OLLAMA=0
FORCE_WHISPER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --whisper-model)  WHISPER_MODEL_NAME="$2"; shift 2 ;;
    --skip-whisper)   SKIP_WHISPER=1; shift ;;
    --skip-ollama)    SKIP_OLLAMA=1; shift ;;
    --force-whisper)  FORCE_WHISPER=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
YELLOW='\033[33m'
CYAN='\033[36m'
RESET='\033[0m'

ok()    { printf "${GREEN}  ✓${RESET}  %s\n" "$*"; }
fail()  { printf "${RED}  ✗${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}  ⚠${RESET}  %s\n" "$*"; }
info()  { printf "${CYAN}  ▸${RESET}  %s\n" "$*"; }
step()  { printf "\n${BOLD}── %s${RESET}\n" "$*"; }
header(){ printf "\n${BOLD}${CYAN}%s${RESET}\n" "$*"; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="$(uname -s)"

# Track what needs manual follow-up
FOLLOWUP=()

# ── Header ────────────────────────────────────────────────────────────────────

header "╔══════════════════════════════════════════════╗"
header "║  Premiere Semantic Search — System Installer ║"
header "╚══════════════════════════════════════════════╝"
printf "\n"
info "Platform:    $PLATFORM"
info "Project dir: $ROOT"
printf "\n"

# ── 1. Node.js ────────────────────────────────────────────────────────────────

step "1. Node.js"

NODE_MIN=18
NODE_OK=0

if command -v node &>/dev/null; then
  NODE_VER="$(node --version 2>/dev/null | sed 's/^v//')"
  NODE_MAJOR="${NODE_VER%%.*}"
  if [[ "$NODE_MAJOR" -ge "$NODE_MIN" ]]; then
    ok "Node.js $NODE_VER (≥ $NODE_MIN required)"
    NODE_OK=1
  else
    warn "Node.js $NODE_VER found but $NODE_MIN+ required"
  fi
fi

if [[ "$NODE_OK" -eq 0 ]]; then
  if [[ "$PLATFORM" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      info "Installing Node.js via Homebrew..."
      brew install node
      ok "Node.js installed"
    else
      fail "Homebrew not found. Install Node.js manually:"
      printf "  https://nodejs.org/en/download\n"
      printf "  Or install Homebrew first: https://brew.sh\n"
      exit 1
    fi
  elif [[ "$PLATFORM" == "Linux" ]]; then
    # Use NodeSource LTS installer if available, else advise nvm
    if command -v curl &>/dev/null; then
      info "Installing Node.js 20 LTS via NodeSource..."
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
      sudo apt-get install -y nodejs
      ok "Node.js installed"
    else
      fail "Cannot install Node.js automatically."
      printf "  Install nvm: https://github.com/nvm-sh/nvm\n"
      printf "  Then: nvm install --lts\n"
      exit 1
    fi
  else
    fail "Unsupported platform: $PLATFORM"
    printf "  Install Node.js 18+ from: https://nodejs.org\n"
    exit 1
  fi
fi

# npm is bundled with Node; verify it works
if command -v npm &>/dev/null; then
  ok "npm $(npm --version)"
else
  fail "npm not found despite Node.js being present — reinstall Node.js"
  exit 1
fi

# ── 2. Build tools ────────────────────────────────────────────────────────────

step "2. Build tools"

if [[ "$PLATFORM" == "Darwin" ]]; then
  # Xcode Command Line Tools
  if xcode-select -p &>/dev/null 2>&1; then
    ok "Xcode Command Line Tools ($(xcode-select -p))"
  else
    info "Installing Xcode Command Line Tools (a dialog may appear)..."
    xcode-select --install 2>/dev/null || true
    # Wait for installation
    until xcode-select -p &>/dev/null 2>&1; do
      printf "  Waiting for Xcode CLT installation..."
      sleep 5
    done
    ok "Xcode Command Line Tools installed"
  fi

  # CMake
  if command -v cmake &>/dev/null; then
    CMAKE_VER="$(cmake --version | head -1 | awk '{print $3}')"
    ok "CMake $CMAKE_VER"
  else
    if command -v brew &>/dev/null; then
      info "Installing CMake via Homebrew..."
      brew install cmake
      ok "CMake $(cmake --version | head -1 | awk '{print $3}')"
    else
      fail "CMake not found. Install with: brew install cmake"
      exit 1
    fi
  fi

  # git (usually pre-installed on macOS with CLT)
  if command -v git &>/dev/null; then
    ok "git $(git --version | awk '{print $3}')"
  else
    info "Installing git via Homebrew..."
    brew install git
    ok "git installed"
  fi

elif [[ "$PLATFORM" == "Linux" ]]; then
  # build-essential, cmake, git
  MISSING_PKGS=()
  command -v gcc   &>/dev/null || MISSING_PKGS+=(build-essential)
  command -v cmake &>/dev/null || MISSING_PKGS+=(cmake)
  command -v git   &>/dev/null || MISSING_PKGS+=(git)

  if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
    info "Installing: ${MISSING_PKGS[*]}"
    sudo apt-get update -qq
    sudo apt-get install -y "${MISSING_PKGS[@]}"
    ok "Build tools installed"
  else
    ok "gcc/g++ $(gcc --version | head -1 | awk '{print $NF}')"
    ok "CMake $(cmake --version | head -1 | awk '{print $3}')"
    ok "git $(git --version | awk '{print $3}')"
  fi
fi

# ── 3. ffmpeg ─────────────────────────────────────────────────────────────────

step "3. ffmpeg"

if command -v ffmpeg &>/dev/null; then
  ok "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
  if [[ "$PLATFORM" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      info "Installing ffmpeg via Homebrew..."
      brew install ffmpeg
      ok "ffmpeg installed"
    else
      warn "ffmpeg not found. Install with: brew install ffmpeg"
      FOLLOWUP+=("Install ffmpeg: brew install ffmpeg")
    fi
  elif [[ "$PLATFORM" == "Linux" ]]; then
    info "Installing ffmpeg..."
    sudo apt-get install -y ffmpeg
    ok "ffmpeg installed"
  else
    warn "ffmpeg not found. Install it for your platform."
    FOLLOWUP+=("Install ffmpeg: https://ffmpeg.org/download.html")
  fi
fi

# ── 4. whisper.cpp ────────────────────────────────────────────────────────────

step "4. whisper.cpp"

if [[ "$SKIP_WHISPER" -eq 1 ]]; then
  warn "Skipping whisper.cpp (--skip-whisper)"
else
  WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
  WHISPER_BINARY="$WHISPER_DIR/build/bin/whisper-cli"

  if [[ -f "$WHISPER_BINARY" && "$FORCE_WHISPER" -eq 0 ]]; then
    ok "whisper.cpp binary: $WHISPER_BINARY"
  else
    info "Building whisper.cpp (this may take a few minutes)..."
    FORCE_FLAG=""
    [[ "$FORCE_WHISPER" -eq 1 ]] && FORCE_FLAG="--force"
    # shellcheck disable=SC2086
    bash "$ROOT/whisper-setup/build.sh" $FORCE_FLAG
  fi

  # Download model
  WHISPER_MODEL_FILE="$WHISPER_DIR/models/ggml-${WHISPER_MODEL_NAME}.bin"
  if [[ -f "$WHISPER_MODEL_FILE" ]]; then
    ok "Whisper model: $WHISPER_MODEL_NAME ($WHISPER_MODEL_FILE)"
  else
    info "Downloading whisper model: $WHISPER_MODEL_NAME"
    bash "$ROOT/whisper-setup/download-model.sh" "$WHISPER_MODEL_NAME"
  fi
fi

# ── 5. Ollama ─────────────────────────────────────────────────────────────────

step "5. Ollama"

if [[ "$SKIP_OLLAMA" -eq 1 ]]; then
  warn "Skipping Ollama (--skip-ollama)"
else
  if command -v ollama &>/dev/null; then
    ok "ollama $(ollama --version 2>/dev/null | head -1 || echo '(installed)')"
  else
    if [[ "$PLATFORM" == "Darwin" ]]; then
      if command -v brew &>/dev/null; then
        info "Installing Ollama via Homebrew..."
        brew install ollama
        ok "Ollama installed"
      else
        info "Downloading Ollama installer..."
        curl -fsSL https://ollama.com/install.sh | sh
        ok "Ollama installed"
      fi
    elif [[ "$PLATFORM" == "Linux" ]]; then
      info "Installing Ollama..."
      curl -fsSL https://ollama.com/install.sh | sh
      ok "Ollama installed"
    else
      fail "Cannot auto-install Ollama on $PLATFORM"
      printf "  Download from: https://ollama.com/download\n"
      FOLLOWUP+=("Install Ollama: https://ollama.com/download")
    fi
  fi

  # Ensure Ollama is running to pull models
  OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
  OLLAMA_RUNNING=0

  if curl -sf "${OLLAMA_URL}/api/tags" &>/dev/null; then
    OLLAMA_RUNNING=1
    ok "Ollama is running at ${OLLAMA_URL}"
  else
    info "Starting Ollama server in background..."
    ollama serve &>/dev/null &
    OLLAMA_PID=$!
    # Give it a moment to start
    for i in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1
      if curl -sf "${OLLAMA_URL}/api/tags" &>/dev/null; then
        OLLAMA_RUNNING=1
        ok "Ollama started (pid $OLLAMA_PID)"
        break
      fi
    done
    if [[ "$OLLAMA_RUNNING" -eq 0 ]]; then
      warn "Could not connect to Ollama after 10s — model pull skipped"
      FOLLOWUP+=("Start Ollama then pull models from .env.example: ollama pull \$OLLAMA_EMBED_MODEL && ollama pull \$OLLAMA_LLM_MODEL")
    fi
  fi

  if [[ "$OLLAMA_RUNNING" -eq 1 ]]; then
    # Read models from .env.example so this list stays in sync with the project config.
    # Falls back to known defaults if the file is absent or the vars are unset.
    EMBED_MODEL="$(grep -E '^OLLAMA_EMBED_MODEL=' "$ROOT/.env.example" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
    LLM_MODEL="$(grep -E '^OLLAMA_LLM_MODEL=' "$ROOT/.env.example" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
    EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
    LLM_MODEL="${LLM_MODEL:-llama3.2}"

    for MODEL in "$EMBED_MODEL" "$LLM_MODEL"; do
      # ollama list output format: "model:tag   ID   size   modified"
      if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$MODEL"; then
        ok "Model: ${MODEL}"
      else
        info "Pulling model: ${MODEL} (this may take a while)..."
        ollama pull "$MODEL"
        ok "Model: ${MODEL} (pulled)"
      fi
    done
  fi
fi

# ── 6. Python ─────────────────────────────────────────────────────────────────

step "6. Python 3"

PYTHON_OK=0
for PY_CMD in python3 python; do
  if command -v "$PY_CMD" &>/dev/null; then
    PY_VER="$($PY_CMD --version 2>&1 | awk '{print $2}')"
    PY_MAJOR="${PY_VER%%.*}"
    PY_MINOR="${PY_VER#*.}"; PY_MINOR="${PY_MINOR%%.*}"
    if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 8 ]]; then
      ok "Python $PY_VER (via $PY_CMD)"
      PYTHON_OK=1
      break
    else
      warn "Python $PY_VER found but 3.8+ required (via $PY_CMD)"
    fi
  fi
done

if [[ "$PYTHON_OK" -eq 0 ]]; then
  if [[ "$PLATFORM" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      info "Installing Python 3 via Homebrew..."
      brew install python3
      ok "Python 3 installed"
    else
      fail "Python 3.8+ required. Install from: https://www.python.org/downloads/"
      exit 1
    fi
  elif [[ "$PLATFORM" == "Linux" ]]; then
    info "Installing Python 3..."
    sudo apt-get install -y python3 python3-venv python3-pip
    ok "Python 3 installed"
  else
    fail "Python 3.8+ required. Install from: https://www.python.org/downloads/"
    exit 1
  fi
fi

# Ensure python3-venv is available on Linux (needed for venv creation)
if [[ "$PLATFORM" == "Linux" ]]; then
  if ! python3 -m venv --help &>/dev/null 2>&1; then
    info "Installing python3-venv..."
    sudo apt-get install -y python3-venv
    ok "python3-venv installed"
  fi
fi

# ── 7. ChromaDB Python venv ───────────────────────────────────────────────────

step "7. ChromaDB"

bash "$ROOT/chromadb/setup.sh"

# ── 8. npm install ────────────────────────────────────────────────────────────

step "8. Node dependencies"

cd "$ROOT"

if [[ -d "node_modules" ]]; then
  ok "node_modules already present"
  info "Running npm install to ensure up to date..."
  npm install --silent
  ok "npm install complete"
else
  info "Running npm install..."
  npm install
  ok "npm install complete"
fi

# ── 9. .env file ──────────────────────────────────────────────────────────────

step "9. Environment file"

ENV_FILE="$ROOT/.env"
ENV_EXAMPLE="$ROOT/.env.example"

if [[ -f "$ENV_FILE" ]]; then
  ok ".env already exists"
else
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  info "Created .env from .env.example"
  warn ".env has been created — update WHISPER_BIN and WHISPER_MODEL paths below"
fi

# Patch .env with detected whisper paths if they are still at placeholder values
WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
WHISPER_BINARY="$WHISPER_DIR/build/bin/whisper-cli"
WHISPER_MODEL_FILE="$WHISPER_DIR/models/ggml-${WHISPER_MODEL_NAME}.bin"

if [[ "$SKIP_WHISPER" -eq 0 && -f "$WHISPER_BINARY" ]]; then
  # Only update if .env still has the placeholder paths
  if grep -q "WHISPER_BIN=/usr/local/bin/whisper" "$ENV_FILE"; then
    sed -i.bak "s|WHISPER_BIN=.*|WHISPER_BIN=$WHISPER_BINARY|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
    ok ".env: WHISPER_BIN updated to $WHISPER_BINARY"
  fi
  if grep -q "WHISPER_MODEL=/usr/local/share" "$ENV_FILE" && [[ -f "$WHISPER_MODEL_FILE" ]]; then
    sed -i.bak "s|WHISPER_MODEL=.*|WHISPER_MODEL=$WHISPER_MODEL_FILE|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
    ok ".env: WHISPER_MODEL updated to $WHISPER_MODEL_FILE"
  fi
fi

# ── 10. Final status check ────────────────────────────────────────────────────

step "10. Final status"
printf "\n"

STATUS_OK=1

# Node
if command -v node &>/dev/null; then
  ok "node       $(node --version)"
else
  fail "node       NOT FOUND"; STATUS_OK=0
fi

# npm
if command -v npm &>/dev/null; then
  ok "npm        $(npm --version)"
else
  fail "npm        NOT FOUND"; STATUS_OK=0
fi

# cmake
if command -v cmake &>/dev/null; then
  ok "cmake      $(cmake --version | head -1 | awk '{print $3}')"
else
  warn "cmake      NOT FOUND (needed to rebuild whisper.cpp)"
fi

# ffmpeg
if command -v ffmpeg &>/dev/null; then
  ok "ffmpeg     $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
else
  warn "ffmpeg     NOT FOUND (needed for audio conversion)"
fi

# whisper
WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
WHISPER_BINARY="$WHISPER_DIR/build/bin/whisper-cli"
if [[ "$SKIP_WHISPER" -eq 1 ]]; then
  warn "whisper    skipped"
elif [[ -f "$WHISPER_BINARY" ]]; then
  ok "whisper    $WHISPER_BINARY"
else
  fail "whisper    NOT FOUND at $WHISPER_BINARY"; STATUS_OK=0
fi

# whisper model
if [[ "$SKIP_WHISPER" -eq 1 ]]; then
  warn "wh-model   skipped"
elif [[ -f "$WHISPER_MODEL_FILE" ]]; then
  ok "wh-model   $WHISPER_MODEL_FILE"
else
  fail "wh-model   NOT FOUND at $WHISPER_MODEL_FILE"; STATUS_OK=0
fi

# ollama
if [[ "$SKIP_OLLAMA" -eq 1 ]]; then
  warn "ollama     skipped"
elif command -v ollama &>/dev/null; then
  ok "ollama     $(ollama --version 2>/dev/null | head -1 || echo 'installed')"
else
  fail "ollama     NOT FOUND"; STATUS_OK=0
fi

# chromadb venv
CHROMA_BIN="$ROOT/chromadb/.venv/bin/chroma"
if [[ -f "$CHROMA_BIN" ]]; then
  ok "chromadb   $("$CHROMA_BIN" --version)"
else
  fail "chromadb   venv not found at $CHROMA_BIN"; STATUS_OK=0
fi

# node_modules
if [[ -d "$ROOT/node_modules" ]]; then
  ok "node_mods  $ROOT/node_modules"
else
  fail "node_mods  NOT FOUND (run npm install)"; STATUS_OK=0
fi

# .env
if [[ -f "$ROOT/.env" ]]; then
  ok ".env       $ROOT/.env"
else
  fail ".env       NOT FOUND"; STATUS_OK=0
fi

# ── Follow-up actions ─────────────────────────────────────────────────────────

if [[ ${#FOLLOWUP[@]} -gt 0 ]]; then
  printf "\n${YELLOW}${BOLD}Manual steps required:${RESET}\n"
  for item in "${FOLLOWUP[@]}"; do
    printf "  ${YELLOW}→${RESET} %s\n" "$item"
  done
fi

# ── Final message ─────────────────────────────────────────────────────────────

printf "\n"
if [[ "$STATUS_OK" -eq 1 && ${#FOLLOWUP[@]} -eq 0 ]]; then
  printf "${GREEN}${BOLD}✓ Installation complete!${RESET}\n\n"
  printf "Next steps:\n"
  printf "  1. Review .env and confirm WHISPER_BIN / WHISPER_MODEL paths\n"
  printf "  2. Start the stack:  npm run start:full\n"
  printf "  3. Open the TUI:     npm run tui\n"
elif [[ "$STATUS_OK" -eq 1 ]]; then
  printf "${YELLOW}${BOLD}⚠ Installation mostly complete — see manual steps above.${RESET}\n"
else
  printf "${RED}${BOLD}✗ Some components failed to install — review errors above.${RESET}\n"
  exit 1
fi
printf "\n"
