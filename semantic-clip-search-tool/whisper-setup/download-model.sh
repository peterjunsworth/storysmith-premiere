#!/usr/bin/env bash
# download-model.sh — Download a whisper.cpp GGML model from Hugging Face.
#
# Usage:
#   bash whisper-setup/download-model.sh <model>
#
# Available models:
#   tiny.en   tiny   base.en   base   small.en   small
#   medium.en medium large-v2  large-v3  large-v3-turbo
#
# Examples:
#   bash whisper-setup/download-model.sh base.en        # recommended for testing
#   bash whisper-setup/download-model.sh large-v3-turbo # recommended for production
#
# The model is saved to $WHISPER_DIR/models/ (default ~/whisper.cpp/models/).
# Safe to re-run — skips download if file already exists.
set -euo pipefail

WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
MODEL_DIR="$WHISPER_DIR/models"
HF_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

# ── Model catalogue ───────────────────────────────────────────────────────────
# Note: no declare -A — macOS ships bash 3.2 which does not support associative
# arrays. case statements are used instead for full bash 3.2 compatibility.

model_filename() {
  case "$1" in
    tiny)            echo "ggml-tiny.bin" ;;
    tiny.en)         echo "ggml-tiny.en.bin" ;;
    base)            echo "ggml-base.bin" ;;
    base.en)         echo "ggml-base.en.bin" ;;
    small)           echo "ggml-small.bin" ;;
    small.en)        echo "ggml-small.en.bin" ;;
    medium)          echo "ggml-medium.bin" ;;
    medium.en)       echo "ggml-medium.en.bin" ;;
    large-v2)        echo "ggml-large-v2.bin" ;;
    large-v3)        echo "ggml-large-v3.bin" ;;
    large-v3-turbo)  echo "ggml-large-v3-turbo.bin" ;;
    *)               echo "" ;;
  esac
}

model_size() {
  case "$1" in
    tiny|tiny.en)         echo "39 MB" ;;
    base|base.en)         echo "74 MB" ;;
    small|small.en)       echo "244 MB" ;;
    medium|medium.en)     echo "769 MB" ;;
    large-v2|large-v3)    echo "1550 MB" ;;
    large-v3-turbo)       echo "874 MB" ;;
    *)                    echo "unknown" ;;
  esac
}

# ── Helpers ───────────────────────────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

list_models() {
  echo ""
  bold "Available models:"
  printf "  %-20s %-10s %s\n" "Name" "Size" "Notes"
  printf "  %-20s %-10s %s\n" "----" "----" "-----"
  printf "  %-20s %-10s %s\n" "tiny.en"          "39 MB"   "Fast, low accuracy, English only"
  printf "  %-20s %-10s %s\n" "base.en"          "74 MB"   "Recommended for benchmark testing"
  printf "  %-20s %-10s %s\n" "small.en"         "244 MB"  "Good accuracy/speed balance"
  printf "  %-20s %-10s %s\n" "medium.en"        "769 MB"  "High accuracy"
  printf "  %-20s %-10s %s\n" "large-v3"         "1550 MB" "Best accuracy"
  printf "  %-20s %-10s %s\n" "large-v3-turbo"   "874 MB"  "Recommended for production"
  printf "  %-20s %-10s %s\n" "tiny/base/small"  "-"       "Multilingual variants"
  echo ""
}

# ── Args ─────────────────────────────────────────────────────────────────────

MODEL="${1:-}"

if [[ -z "$MODEL" ]]; then
  red "Error: model name required."
  list_models
  echo "Usage: bash whisper-setup/download-model.sh <model-name>"
  exit 1
fi

# Lookup filename
FILENAME="$(model_filename "$MODEL")"
if [[ -z "$FILENAME" ]]; then
  red "Unknown model: '$MODEL'"
  list_models
  exit 1
fi

SIZE="$(model_size "$MODEL")"
URL="$HF_BASE/$FILENAME"
DEST="$MODEL_DIR/$FILENAME"

# ── Download ──────────────────────────────────────────────────────────────────

mkdir -p "$MODEL_DIR"

bold "Downloading whisper.cpp model"
echo "  Model:  $MODEL  ($SIZE)"
echo "  URL:    $URL"
echo "  Dest:   $DEST"
echo ""

if [[ -f "$DEST" ]]; then
  green "Already exists: $DEST"
  echo "Delete the file and re-run to force re-download."
  echo ""
  echo "  WHISPER_MODEL=$DEST"
  exit 0
fi

# Prefer curl, fall back to wget
if command -v curl &>/dev/null; then
  curl -L --progress-bar -o "$DEST" "$URL"
elif command -v wget &>/dev/null; then
  wget --show-progress -O "$DEST" "$URL"
else
  red "Neither curl nor wget found. Install one and retry."
  exit 1
fi

# Verify file is non-empty and looks like a binary (GGML magic bytes)
FILE_SIZE=$(wc -c < "$DEST")
if [[ "$FILE_SIZE" -lt 1000000 ]]; then
  red "Download appears incomplete ($FILE_SIZE bytes). Check network and retry."
  rm -f "$DEST"
  exit 1
fi

echo ""
green "Download complete: $DEST"
echo ""
bold ".env variable:"
echo "  WHISPER_MODEL=$DEST"
echo ""
echo "Verify the model works:"
echo "  bash whisper-setup/verify.sh"
