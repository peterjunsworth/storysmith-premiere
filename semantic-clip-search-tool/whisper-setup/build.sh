#!/usr/bin/env bash
# build.sh — Compile whisper.cpp with the correct acceleration for this machine.
#
# Usage:
#   bash whisper-setup/build.sh [--force]
#
# --force   Re-run cmake even if a binary already exists.
#
# Reads acceleration from the environment or auto-detects:
#   WHISPER_ACCELERATION=metal|cuda|rocm|cpu   (optional override)
#   WHISPER_DIR=~/whisper.cpp                  (clone destination, default ~/whisper.cpp)
set -euo pipefail

FORCE=0
for arg in "$@"; do
  [[ "$arg" == "--force" ]] && FORCE=1
done

# ── Config ─────────────────────────────────────────────────────────────────────

WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"
WHISPER_REPO="https://github.com/ggerganov/whisper.cpp"
BINARY="$WHISPER_DIR/build/bin/whisper-cli"

# ── Colour helpers ─────────────────────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ── Platform detection ─────────────────────────────────────────────────────────

detect_acceleration() {
  # Honour explicit override
  if [[ -n "${WHISPER_ACCELERATION:-}" ]]; then
    echo "$WHISPER_ACCELERATION"
    return
  fi

  local platform
  platform="$(uname -s)"

  case "$platform" in
    Darwin)
      local macos_ver
      macos_ver="$(sw_vers -productVersion)"
      local major
      major="${macos_ver%%.*}"
      if [[ "$major" -ge 13 ]]; then
        echo "metal"
      else
        echo "cpu"
      fi
      ;;
    Linux)
      # CUDA: nvidia-smi + nvcc both present
      if command -v nvidia-smi &>/dev/null && command -v nvcc &>/dev/null; then
        echo "cuda"
      # ROCm: rocminfo present
      elif command -v rocminfo &>/dev/null; then
        echo "rocm"
      else
        echo "cpu"
      fi
      ;;
    *)
      echo "cpu"
      ;;
  esac
}

# ── cmake flag selection ───────────────────────────────────────────────────────

cmake_flags_for() {
  local accel="$1"
  case "$accel" in
    metal) echo "-DGGML_METAL=1" ;;
    cuda)
      local sm
      sm="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '.')"
      if [[ -n "$sm" ]]; then
        echo "-DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=$sm"
      else
        echo "-DGGML_CUDA=1"
      fi
      ;;
    rocm) echo "-DGGML_HIP=1" ;;
    cpu)
      # AVX2 if available on Linux
      if [[ "$(uname -s)" == "Linux" ]] && grep -q avx2 /proc/cpuinfo 2>/dev/null; then
        echo "-DGGML_AVX2=ON"
      else
        echo ""
      fi
      ;;
    *) echo "" ;;
  esac
}

# ── Jobs ───────────────────────────────────────────────────────────────────────

cpu_jobs() {
  if command -v nproc &>/dev/null; then
    nproc
  elif command -v sysctl &>/dev/null; then
    sysctl -n hw.logicalcpu
  else
    echo "4"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────────

bold "whisper.cpp build script"

ACCEL="$(detect_acceleration)"
CMAKE_FLAGS="$(cmake_flags_for "$ACCEL")"
JOBS="$(cpu_jobs)"

echo "  Target dir:    $WHISPER_DIR"
echo "  Acceleration:  $ACCEL"
echo "  cmake flags:   ${CMAKE_FLAGS:-<none>}"
echo "  Build jobs:    $JOBS"

# ── Early exit if binary already exists ──────────────────────────────────────

if [[ -f "$BINARY" && "$FORCE" -eq 0 ]]; then
  green "\nBinary already exists: $BINARY"
  echo "Run with --force to rebuild."
  echo ""
  echo "  WHISPER_BIN=$BINARY"
  exit 0
fi

# ── Clone or update repo ──────────────────────────────────────────────────────

step "Repository"
if [[ -d "$WHISPER_DIR/.git" ]]; then
  echo "Already cloned at $WHISPER_DIR — pulling latest..."
  git -C "$WHISPER_DIR" pull --ff-only
else
  echo "Cloning $WHISPER_REPO → $WHISPER_DIR ..."
  git clone "$WHISPER_REPO" "$WHISPER_DIR"
fi

# ── CMake configure ───────────────────────────────────────────────────────────

step "Configure"
cd "$WHISPER_DIR"

# shellcheck disable=SC2086
cmake -B build $CMAKE_FLAGS

# ── Build ─────────────────────────────────────────────────────────────────────

step "Build (this may take 1–3 minutes)"
cmake --build build --config Release -j"$JOBS"

# ── Verify binary ─────────────────────────────────────────────────────────────

step "Verify"
if [[ -f "$BINARY" ]]; then
  green "Build successful: $BINARY"
  "$BINARY" --version 2>/dev/null || true
else
  red "Build failed — binary not found at expected path: $BINARY"
  echo "Check cmake output above for errors."
  exit 1
fi

# ── Print env vars ────────────────────────────────────────────────────────────

MODEL_PATH="$WHISPER_DIR/models/ggml-base.en.bin"
THREADS="$(( JOBS < 8 ? JOBS : 8 ))"

bold "\n.env variables to add:"
echo ""
echo "  WHISPER_BIN=$BINARY"
echo "  WHISPER_MODEL=$MODEL_PATH"
echo "  WHISPER_THREADS=$THREADS"
echo ""
echo "Download a model next:"
echo "  bash whisper-setup/download-model.sh base.en"
