# whisper.cpp Setup Guide

Setup guide for compiling whisper.cpp with hardware acceleration.
This tool uses whisper.cpp (not the Python `openai-whisper` package) because it runs locally via `child_process.spawn`, gives full control over Metal/CUDA/CPU flags, and produces JSON output the pipeline reads directly.

---

## Quick start

```bash
# 1. Detect your platform and recommended flags
tsx whisper-setup/check-acceleration.ts

# 2. Build whisper.cpp for your platform
bash whisper-setup/build.sh

# 3. Download a model
bash whisper-setup/download-model.sh base.en

# 4. Verify the build
bash whisper-setup/verify.sh
```

---

## Platform support matrix

| Platform | Chip | Acceleration | Backend flag |
|----------|------|-------------|--------------|
| macOS 13+ | Apple Silicon (M1/M2/M3/M4) | Metal GPU | `GGML_METAL=1` |
| macOS 13+ | Intel + AMD GPU | Metal GPU | `GGML_METAL=1` |
| macOS 12 | Any | CPU only | _(none)_ |
| Linux | NVIDIA | CUDA | `GGML_CUDA=1` |
| Linux | AMD | ROCm/HIP | `GGML_HIP=1` |
| Linux | Any | CPU (AVX2) | _(none)_ |
| Windows | NVIDIA | CUDA | `GGML_CUDA=1` |
| Windows | Any | CPU | _(none)_ |

The `check-acceleration.ts` script detects your platform and prints the correct build command.

---

## macOS — Metal (recommended)

Metal is Apple's GPU compute API. On Apple Silicon it runs whisper on the Neural Engine / GPU, giving ~4–8x speedup over CPU. It works on Intel Macs with a discrete or integrated GPU too.

### Prerequisites

| Tool | Install |
|------|---------|
| Xcode Command Line Tools | `xcode-select --install` |
| CMake ≥ 3.26 | `brew install cmake` |
| git | pre-installed or `brew install git` |

No CUDA, no Python, no pip required.

### Build

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_METAL=1
cmake --build build --config Release -j$(sysctl -n hw.logicalcpu)
```

The binary is at `build/bin/whisper-cli`.
A Metal shader file `ggml-metal.metal` is compiled into the binary automatically.

### Verify Metal is active

```bash
./build/bin/whisper-cli -m models/ggml-base.en.bin -f samples/jfk.wav 2>&1 | grep -i metal
```

Expected output contains:
```
whisper_init_state: using Metal for GPU acceleration
ggml_metal_init: allocating
```

If you see `using Metal` — Metal is active.
If you see `no Metal device found` — fall back to CPU build (drop `-DGGML_METAL=1`).

---

## macOS — CPU-only fallback

If Metal is unavailable (macOS < 13, headless CI, VM):

```bash
cmake -B build
cmake --build build --config Release -j$(sysctl -n hw.logicalcpu)
```

whisper.cpp uses BLAS/Accelerate automatically on macOS for SIMD acceleration even without Metal.

---

## Linux — CUDA (NVIDIA)

### Prerequisites

| Tool | Install |
|------|---------|
| CUDA Toolkit ≥ 11.8 | [developer.nvidia.com/cuda-downloads](https://developer.nvidia.com/cuda-downloads) |
| cuDNN (optional) | improves some ops |
| CMake ≥ 3.26 | `apt install cmake` or `snap install cmake` |
| git, gcc/g++ | `apt install git build-essential` |

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_CUDA=1
cmake --build build --config Release -j$(nproc)
```

### Verify CUDA

```bash
./build/bin/whisper-cli -m models/ggml-base.en.bin -f samples/jfk.wav 2>&1 | grep -i cuda
```

Expected: `whisper_init_state: using CUDA for GPU acceleration`

---

## Linux — CPU (AVX2/AVX512)

```bash
cmake -B build -DGGML_AVX2=ON
cmake --build build --config Release -j$(nproc)
```

whisper.cpp auto-detects AVX2/AVX512 at runtime if you don't set flags; setting `-DGGML_AVX2=ON` forces it to link the vectorised kernels at compile time.

---

## Windows — CUDA

Install [CUDA Toolkit](https://developer.nvidia.com/cuda-downloads), then in a Developer Command Prompt or PowerShell with VS Build Tools:

```powershell
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build -DGGML_CUDA=1 -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Binary: `build\bin\Release\whisper-cli.exe`

---

## Models

whisper.cpp uses GGML-quantised model files. They are **not** compatible with Python `openai-whisper` `.pt` files.

### Download a model

```bash
# built-in helper script
bash whisper-setup/download-model.sh <model-name>

# or manually from Hugging Face
curl -L -o models/ggml-base.en.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
```

### Model comparison

| Model | Size | VRAM | Relative speed | WER (LibriSpeech) | Use case |
|-------|------|------|--------------|--------------------|----------|
| `tiny.en` | 39 MB | ~0.4 GB | ~32x | ~8% | Fast tests, low accuracy |
| `base.en` | 74 MB | ~0.7 GB | ~16x | ~5.5% | **Recommended for benchmarks** |
| `small.en` | 244 MB | ~1.5 GB | ~6x | ~4.2% | Good accuracy/speed balance |
| `medium.en` | 769 MB | ~3.5 GB | ~2x | ~3.3% | High accuracy |
| `large-v3` | 1550 MB | ~6 GB | 1x (baseline) | ~2.7% | Best accuracy, slowest |
| `large-v3-turbo` | 874 MB | ~4 GB | ~8x | ~2.9% | **Best for production** |

`.en` models are English-only but ~10% faster than multilingual variants.

`base.en` is the recommended starting point for this project's benchmark tests. Switch to `large-v3-turbo` for production indexing.

---

## CLI flags used by this project

The `WhisperService` in `src/services/whisper.ts` calls whisper.cpp with these flags:

```
whisper-cli \
  -m <model-path>        # model file
  -f <wav-file>          # input audio (must be 16 kHz mono WAV)
  -t <threads>           # CPU threads (WHISPER_THREADS env var, default 4)
  --output-json          # write JSON output file
  -of <output-prefix>    # output written to <prefix>.json
  --no-timestamps        # omit per-word timestamps (faster, smaller output)
```

The JSON output format whisper.cpp produces:

```json
{
  "transcription": [
    { "text": " And so my fellow Americans..." },
    { "text": " ask not what your country..." }
  ]
}
```

The pipeline joins all `text` fields with spaces to produce the full transcript.

---

## Environment variables

Set these in `.env` (copy from `.env.example`):

```bash
WHISPER_BIN=/path/to/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL=/path/to/whisper.cpp/models/ggml-base.en.bin
WHISPER_THREADS=4
```

Typical paths after building with the scripts in this folder:

| OS | `WHISPER_BIN` |
|----|--------------|
| macOS | `~/whisper.cpp/build/bin/whisper-cli` |
| Linux | `~/whisper.cpp/build/bin/whisper-cli` |
| Windows | `C:\whisper.cpp\build\bin\Release\whisper-cli.exe` |

---

## ffmpeg requirement

whisper.cpp only accepts **16 kHz mono WAV** files. The `WhisperService` automatically converts any other format via ffmpeg before transcription. ffmpeg must be on `PATH`.

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
apt install ffmpeg

# Windows
winget install ffmpeg
```

---

## Troubleshooting

**`whisper_metal_init: error: could not create MTLDevice`**
macOS version < 13, or running in a VM without GPU passthrough. Build without `-DGGML_METAL=1`.

**`Segmentation fault` on first run (macOS)**
Metal shaders sometimes fail to compile on first launch. Run once with a short audio file to warm the shader cache:
```bash
./build/bin/whisper-cli -m models/ggml-tiny.en.bin -f samples/jfk.wav
```

**`CUDA error: no kernel image is available`**
CUDA compute capability mismatch. Rebuild with your card's arch:
```bash
cmake -B build -DGGML_CUDA=1 -DCMAKE_CUDA_ARCHITECTURES=86  # RTX 30xx = sm_86
```

**Transcription is garbage / wrong language**
Using a multilingual model but audio is in a non-English language. Add `-l en` to force English, or use a `.en` model.

**Output JSON file not found**
whisper.cpp writes `<prefix>.json`. The `WhisperService` uses a temp path — ensure the tmp directory is writable (`/tmp` on macOS/Linux, `%TEMP%` on Windows).

---

## References

- whisper.cpp repository: https://github.com/ggerganov/whisper.cpp
- GGML Metal backend: https://github.com/ggerganov/ggml/blob/master/src/ggml-metal.m
- Model files (Hugging Face): https://huggingface.co/ggerganov/whisper.cpp
- OpenAI Whisper paper: https://arxiv.org/abs/2212.04356
- whisper.cpp Metal announcement (issue #404): https://github.com/ggerganov/whisper.cpp/issues/404
