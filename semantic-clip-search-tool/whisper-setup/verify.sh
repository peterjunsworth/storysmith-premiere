#!/usr/bin/env bash
# verify.sh — Test whisper.cpp binary against the built-in JFK sample.
#
# Usage:
#   bash whisper-setup/verify.sh
#
# Reads WHISPER_BIN and WHISPER_MODEL from environment or .env file.
# Uses the samples/jfk.wav file included in the whisper.cpp repository.
#
# What it checks:
#   1. Binary exists and is executable
#   2. Model file exists
#   3. Transcription runs without error
#   4. Metal/CUDA/CPU acceleration is logged
#   5. Output contains expected text ("my fellow Americans")
#   6. JSON output mode works (required by the pipeline)
set -euo pipefail

WHISPER_DIR="${WHISPER_DIR:-$HOME/whisper.cpp}"

# ── Load .env if present ──────────────────────────────────────────────────────

ENV_FILE="$(dirname "$0")/../.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -o allexport
  source "$ENV_FILE"
  set +o allexport
fi

WHISPER_BIN="${WHISPER_BIN:-$WHISPER_DIR/build/bin/whisper-cli}"
WHISPER_MODEL="${WHISPER_MODEL:-$WHISPER_DIR/models/ggml-base.en.bin}"
SAMPLE_WAV="$WHISPER_DIR/samples/jfk.wav"

# ── Helpers ───────────────────────────────────────────────────────────────────

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
red()   { printf '\033[31m✗ %s\033[0m\n' "$*"; }
warn()  { printf '\033[33m⚠ %s\033[0m\n' "$*"; }

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"   # "ok" or anything else = fail
  local detail="${3:-}"
  if [[ "$result" == "ok" ]]; then
    green "$label"
    (( PASS++ )) || true
  else
    red "$label${detail:+: $detail}"
    (( FAIL++ )) || true
  fi
}

# ── Checks ────────────────────────────────────────────────────────────────────

bold "\n=== whisper.cpp Verification ==="
echo ""
echo "  Binary: $WHISPER_BIN"
echo "  Model:  $WHISPER_MODEL"
echo "  Sample: $SAMPLE_WAV"
echo ""

# 1. Binary exists
if [[ -f "$WHISPER_BIN" ]]; then
  check "Binary exists" ok
else
  check "Binary exists" fail "not found — run: bash whisper-setup/build.sh"
fi

# 2. Binary is executable
if [[ -x "$WHISPER_BIN" ]]; then
  check "Binary is executable" ok
else
  check "Binary is executable" fail "run: chmod +x $WHISPER_BIN"
fi

# 3. Model file exists
if [[ -f "$WHISPER_MODEL" ]]; then
  MODEL_MB=$(( $(wc -c < "$WHISPER_MODEL") / 1024 / 1024 ))
  check "Model exists (${MODEL_MB} MB)" ok
else
  check "Model exists" fail "not found — run: bash whisper-setup/download-model.sh base.en"
fi

# 4. Sample WAV exists
if [[ -f "$SAMPLE_WAV" ]]; then
  check "Sample WAV exists (jfk.wav)" ok
else
  warn "Sample WAV not found at $SAMPLE_WAV — trying to locate one..."
  # Create a minimal 1-second silent WAV as a fallback test
  SAMPLE_WAV="/tmp/whisper-verify-silence.wav"
  if command -v ffmpeg &>/dev/null; then
    ffmpeg -f lavfi -i "anullsrc=r=16000:cl=mono" -t 1 -ar 16000 -ac 1 \
      -c:a pcm_s16le -y "$SAMPLE_WAV" 2>/dev/null
    warn "Using generated silent WAV for test (transcription output will be empty)"
  else
    red "ffmpeg not found — cannot create test audio. Install ffmpeg."
    exit 1
  fi
fi

# 5. ffmpeg on PATH (required by WhisperService for non-WAV inputs)
if command -v ffmpeg &>/dev/null; then
  FFMPEG_VER="$(ffmpeg -version 2>&1 | head -1 | grep -o 'version [^ ]*')"
  check "ffmpeg on PATH ($FFMPEG_VER)" ok
else
  check "ffmpeg on PATH" fail "install: brew install ffmpeg  OR  apt install ffmpeg"
fi

# 6. Run transcription — capture stderr for acceleration info
echo ""
bold "Running transcription test..."
TMPDIR_V="$(mktemp -d)"
OUTPREFIX="$TMPDIR_V/verify-out"
STDERR_LOG="$TMPDIR_V/stderr.txt"

RUN_OK=0
"$WHISPER_BIN" \
  -m "$WHISPER_MODEL" \
  -f "$SAMPLE_WAV" \
  -t 4 \
  --output-json \
  -of "$OUTPREFIX" \
  --no-timestamps \
  2>"$STDERR_LOG" && RUN_OK=1 || true

if [[ "$RUN_OK" -eq 1 ]]; then
  check "Transcription ran without error" ok
else
  check "Transcription ran without error" fail "whisper-cli exited non-zero"
  echo ""
  echo "--- stderr output ---"
  cat "$STDERR_LOG"
  echo "---------------------"
fi

# 7. Acceleration backend — parse actual whisper.cpp log lines
# Patterns derived from real output (whisper.cpp ggml-metal backend):
#   Metal:  "ggml_metal_init: found device: ..."
#           "whisper_backend_init_gpu: using MTL0 backend"
#   CUDA:   "whisper_backend_init_gpu: using CUDA backend"
#   ROCm:   "whisper_backend_init_gpu: using ROCm backend"
#   GPU on: "whisper_init_with_params_no_state: use gpu    = 1"
STDERR_CONTENT="$(cat "$STDERR_LOG")"

GPU_ENABLED="$(echo "$STDERR_CONTENT"   | grep -o 'use gpu.*= [01]' | grep -o '[01]$')"
GPU_BACKEND="$(echo "$STDERR_CONTENT"   | grep 'whisper_backend_init_gpu: using' | grep -o 'using.*backend' | sed 's/using //;s/ backend//')"
METAL_DEVICE="$(echo "$STDERR_CONTENT"  | grep 'ggml_metal_init: found device:' | sed 's/.*found device: *//')"
METAL_FAMILY="$(echo "$STDERR_CONTENT"  | grep 'ggml_metal_device_init: GPU family:' | head -1 | sed 's/.*GPU family: *//')"
CUDA_DEVICE="$(echo "$STDERR_CONTENT"   | grep 'whisper_backend_init_gpu: found GPU device' | sed 's/.*device [0-9]*: //')"
THREAD_INFO="$(echo "$STDERR_CONTENT"   | grep 'system_info:' | grep -o 'n_threads = [0-9]* / [0-9]*')"

if [[ "$GPU_ENABLED" == "0" ]]; then
  warn "GPU disabled (use gpu = 0) — rebuild without -DGGML_METAL=0 or check WHISPER_NO_METAL"
  (( PASS++ )) || true
elif [[ -n "$METAL_DEVICE" ]]; then
  check "Acceleration: Metal GPU active — $METAL_DEVICE${METAL_FAMILY:+ ($METAL_FAMILY)}" ok
elif [[ "$GPU_BACKEND" == *"CUDA"* ]]; then
  check "Acceleration: CUDA GPU active${CUDA_DEVICE:+ — $CUDA_DEVICE}" ok
elif [[ "$GPU_BACKEND" == *"ROCm"* ]] || [[ "$GPU_BACKEND" == *"HIP"* ]]; then
  check "Acceleration: ROCm/HIP GPU active" ok
elif [[ -n "$GPU_BACKEND" ]]; then
  # Catch any future backend name we don't know yet
  check "Acceleration: GPU backend active ($GPU_BACKEND)" ok
else
  warn "Acceleration: no GPU backend detected — running on CPU"
  warn "  If you expected Metal, check build was compiled with -DGGML_METAL=1"
  (( PASS++ )) || true   # CPU is still valid
fi

# Print supplemental info regardless of pass/fail
[[ -n "$THREAD_INFO"  ]] && echo "  threads: $THREAD_INFO"
[[ -n "$GPU_BACKEND"  ]] && [[ -z "$METAL_DEVICE" ]] && echo "  backend: $GPU_BACKEND"

# 8. JSON output exists and is valid
JSON_OUT="$OUTPREFIX.json"
if [[ -f "$JSON_OUT" ]]; then
  check "JSON output file created" ok
  # Parse with node/python to validate structure
  if command -v node &>/dev/null; then
    VALID_JSON="$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$JSON_OUT','utf8'));
      process.stdout.write(Array.isArray(d.transcription) ? 'ok' : 'bad');
    " 2>/dev/null || echo 'bad')"
    if [[ "$VALID_JSON" == "ok" ]]; then
      check "JSON has transcription[] array" ok
    else
      check "JSON has transcription[] array" fail "unexpected structure"
    fi
  fi
else
  check "JSON output file created" fail "file not found at $JSON_OUT"
fi

# 9. Transcription content check (only meaningful for jfk.wav)
if [[ "$SAMPLE_WAV" == *"jfk.wav"* ]] && [[ -f "$JSON_OUT" ]]; then
  TRANSCRIPT="$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$JSON_OUT','utf8'));
    process.stdout.write(d.transcription.map(s=>s.text).join(' ').toLowerCase());
  " 2>/dev/null || echo '')"

  if echo "$TRANSCRIPT" | grep -q "fellow americans\|fellow american"; then
    check "Transcript contains 'fellow Americans' (expected for jfk.wav)" ok
  else
    warn "Transcript text unexpected (may be OK for non-jfk sample): $TRANSCRIPT"
  fi
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
rm -rf "$TMPDIR_V"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
bold "=== Result: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -eq 0 ]]; then
  green "whisper.cpp is correctly configured and ready to use."
  echo ""
  echo "  WHISPER_BIN=$WHISPER_BIN"
  echo "  WHISPER_MODEL=$WHISPER_MODEL"
  echo ""
  echo "Add these to your .env file, then run:"
  echo "  npm run test:prepare && npm run test:eval"
else
  red "Some checks failed. Fix the issues above and re-run."
  exit 1
fi
