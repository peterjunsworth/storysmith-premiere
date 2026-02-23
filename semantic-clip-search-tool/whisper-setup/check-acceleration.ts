#!/usr/bin/env tsx
/**
 * check-acceleration.ts
 *
 * Detects the host machine OS, architecture, and available GPU acceleration
 * for whisper.cpp. Prints a summary and the exact cmake build command to use.
 *
 * Usage:
 *   tsx whisper-setup/check-acceleration.ts
 */

import { execSync, spawnSync } from 'node:child_process';
import os from 'node:os';

// ── Types ─────────────────────────────────────────────────────────────────────

type Acceleration = 'metal' | 'cuda' | 'rocm' | 'cpu-accelerate' | 'cpu-avx2' | 'cpu';

interface CheckResult {
  platform: NodeJS.Platform;
  arch: string;
  osVersion: string;
  cpuModel: string;
  acceleration: Acceleration;
  reasons: string[];
  warnings: string[];
  cmakeFlags: string[];
  cmakeCommand: string;
  envVars: Record<string, string>;
  prereqsOk: boolean;
  prereqs: Array<{ name: string; ok: boolean; fix?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function which(bin: string): boolean {
  return run(`which ${bin}`) !== '' || run(`where ${bin}`) !== '';
}

function semver(str: string): [number, number, number] {
  const m = str.match(/(\d+)\.(\d+)\.?(\d*)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3] || '0')];
}

// ── Platform-specific detection ───────────────────────────────────────────────

function detectMacOS(): Partial<CheckResult> {
  const swVer = run('sw_vers -productVersion');
  const [major] = semver(swVer);
  const cpuBrand = run('sysctl -n machdep.cpu.brand_string');
  const isAppleSilicon = process.arch === 'arm64';

  const reasons: string[] = [];
  const warnings: string[] = [];

  // Metal requires macOS 13+ for full compute support (whisper.cpp ggml-metal)
  if (major >= 13) {
    reasons.push(`macOS ${swVer} ≥ 13 — Metal compute supported`);
    if (isAppleSilicon) {
      reasons.push(`Apple Silicon (${cpuBrand}) — unified memory, best Metal performance`);
    } else {
      reasons.push(`Intel Mac — Metal GPU acceleration available`);
    }
    return {
      osVersion: swVer,
      cpuModel: cpuBrand,
      acceleration: 'metal',
      reasons,
      warnings,
      cmakeFlags: ['-DGGML_METAL=1'],
    };
  }

  warnings.push(`macOS ${swVer} < 13 — Metal compute not supported`);
  if (isAppleSilicon) {
    warnings.push('Apple Silicon on macOS < 13 is unusual — consider upgrading');
  }
  // macOS always has Accelerate.framework for BLAS
  reasons.push('Accelerate.framework (BLAS) available for SIMD CPU acceleration');
  return {
    osVersion: swVer,
    cpuModel: cpuBrand,
    acceleration: 'cpu-accelerate',
    reasons,
    warnings,
    cmakeFlags: [],   // whisper.cpp auto-links Accelerate on macOS
  };
}

function detectLinux(): Partial<CheckResult> {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const cpuModel = run("grep -m1 'model name' /proc/cpuinfo | cut -d: -f2").trim();

  // Check CUDA
  const nvidiaSmi = run('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null');
  const nvccVersion = run('nvcc --version 2>/dev/null');
  if (nvidiaSmi && nvccVersion) {
    const gpuName = nvidiaSmi.split('\n')[0].trim();
    const cudaVer = nvccVersion.match(/release (\d+\.\d+)/)?.[1] ?? 'unknown';
    reasons.push(`NVIDIA GPU detected: ${gpuName}`);
    reasons.push(`CUDA toolkit: ${cudaVer}`);
    // Detect compute capability for cmake
    const smResult = run("nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null");
    const sm = smResult ? smResult.split('\n')[0].replace('.', '') : '';
    const archFlag = sm ? `-DCMAKE_CUDA_ARCHITECTURES=${sm}` : '';
    return {
      cpuModel,
      acceleration: 'cuda',
      reasons,
      warnings,
      cmakeFlags: ['-DGGML_CUDA=1', ...(archFlag ? [archFlag] : [])],
    };
  }
  if (nvidiaSmi && !nvccVersion) {
    warnings.push('NVIDIA GPU detected but CUDA toolkit not found — install cuda-toolkit');
  }

  // Check ROCm (AMD)
  const rocmInfo = run('rocminfo 2>/dev/null | head -20');
  if (rocmInfo.includes('HSA Agent')) {
    reasons.push('AMD GPU with ROCm detected');
    return {
      cpuModel,
      acceleration: 'rocm',
      reasons,
      warnings,
      cmakeFlags: ['-DGGML_HIP=1'],
    };
  }

  // CPU fallback — check AVX2
  const cpuFlags = run('grep -m1 flags /proc/cpuinfo');
  if (cpuFlags.includes('avx2')) {
    reasons.push('AVX2 SIMD instructions available');
    return {
      cpuModel,
      acceleration: 'cpu-avx2',
      reasons,
      warnings,
      cmakeFlags: ['-DGGML_AVX2=ON'],
    };
  }

  reasons.push('CPU-only mode (no AVX2, no GPU detected)');
  return { cpuModel, acceleration: 'cpu', reasons, warnings, cmakeFlags: [] };
}

function detectWindows(): Partial<CheckResult> {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const cpuModel = run('wmic cpu get name /value').replace('Name=', '').trim();

  // Check CUDA via nvcc
  const nvccOut = run('nvcc --version 2>nul');
  if (nvccOut.includes('release')) {
    const cudaVer = nvccOut.match(/release (\d+\.\d+)/)?.[1] ?? 'unknown';
    reasons.push(`CUDA toolkit ${cudaVer} found`);
    warnings.push('Ensure VS Build Tools and CUDA are on PATH in the same shell');
    return {
      cpuModel,
      acceleration: 'cuda',
      reasons,
      warnings,
      cmakeFlags: ['-DGGML_CUDA=1', '-G "Visual Studio 17 2022"', '-A x64'],
    };
  }

  reasons.push('CPU-only mode (no CUDA toolkit found)');
  warnings.push('Install CUDA Toolkit from developer.nvidia.com for GPU acceleration');
  return { cpuModel, acceleration: 'cpu', reasons, warnings, cmakeFlags: [] };
}

// ── Prereqs check ─────────────────────────────────────────────────────────────

function checkPrereqs(platform: NodeJS.Platform, acceleration: Acceleration) {
  const prereqs: CheckResult['prereqs'] = [];

  // git
  const gitVer = run('git --version');
  prereqs.push({
    name: 'git',
    ok: gitVer.includes('git version'),
    fix: platform === 'darwin' ? 'xcode-select --install'
       : platform === 'linux' ? 'apt install git'
       : 'https://git-scm.com/download/win',
  });

  // cmake
  const cmakeVer = run('cmake --version');
  const [cmakeMaj, cmakeMin] = semver(cmakeVer);
  const cmakeOk = cmakeMaj > 3 || (cmakeMaj === 3 && cmakeMin >= 26);
  prereqs.push({
    name: `cmake ≥ 3.26 (found: ${cmakeVer.split('\n')[0]})`,
    ok: cmakeOk,
    fix: platform === 'darwin' ? 'brew install cmake'
       : platform === 'linux' ? 'apt install cmake  OR  snap install cmake --classic'
       : 'winget install cmake',
  });

  // C++ compiler
  if (platform === 'darwin') {
    const clangVer = run('clang --version');
    prereqs.push({
      name: `clang (Xcode CLT): ${clangVer.split('\n')[0]}`,
      ok: clangVer.includes('clang'),
      fix: 'xcode-select --install',
    });
  } else if (platform === 'linux') {
    const gccVer = run('gcc --version');
    prereqs.push({
      name: `gcc: ${gccVer.split('\n')[0]}`,
      ok: gccVer.includes('gcc'),
      fix: 'apt install build-essential',
    });
  }

  // ffmpeg (needed by WhisperService for non-WAV conversion)
  const ffmpegVer = run('ffmpeg -version 2>&1 | head -1');
  prereqs.push({
    name: `ffmpeg: ${ffmpegVer || 'not found'}`,
    ok: ffmpegVer.includes('ffmpeg version'),
    fix: platform === 'darwin' ? 'brew install ffmpeg'
       : platform === 'linux' ? 'apt install ffmpeg'
       : 'winget install ffmpeg',
  });

  // CUDA toolkit (only required for cuda acceleration)
  if (acceleration === 'cuda') {
    const nvcc = run('nvcc --version');
    prereqs.push({
      name: `nvcc (CUDA toolkit): ${nvcc.split('\n').find(l => l.includes('release')) ?? 'not found'}`,
      ok: nvcc.includes('release'),
      fix: 'https://developer.nvidia.com/cuda-downloads',
    });
  }

  const prereqsOk = prereqs.every((p) => p.ok);
  return { prereqs, prereqsOk };
}

// ── Build command builder ─────────────────────────────────────────────────────

function buildCommand(cmakeFlags: string[], platform: NodeJS.Platform): string {
  const cpus = os.cpus().length;
  const jFlag = platform === 'win32' ? '' : `-j${cpus}`;
  const flagStr = cmakeFlags.length ? ' ' + cmakeFlags.join(' ') : '';
  return [
    `cmake -B build${flagStr}`,
    `cmake --build build --config Release${jFlag ? ' ' + jFlag : ''}`,
  ].join('\n');
}

// ── Env vars ──────────────────────────────────────────────────────────────────

function suggestedEnvVars(platform: NodeJS.Platform): Record<string, string> {
  const home = os.homedir();
  const ext = platform === 'win32' ? '.exe' : '';
  const binPath = platform === 'win32'
    ? `${home}\\whisper.cpp\\build\\bin\\Release\\whisper-cli${ext}`
    : `${home}/whisper.cpp/build/bin/whisper-cli`;
  const modelPath = platform === 'win32'
    ? `${home}\\whisper.cpp\\models\\ggml-base.en.bin`
    : `${home}/whisper.cpp/models/ggml-base.en.bin`;

  return {
    WHISPER_BIN: binPath,
    WHISPER_MODEL: modelPath,
    WHISPER_THREADS: String(Math.min(os.cpus().length, 8)),
  };
}

// ── Render ────────────────────────────────────────────────────────────────────

function accelLabel(a: Acceleration): string {
  return {
    metal: 'Metal GPU (Apple)',
    cuda: 'CUDA GPU (NVIDIA)',
    rocm: 'ROCm/HIP GPU (AMD)',
    'cpu-accelerate': 'CPU + Accelerate.framework (macOS)',
    'cpu-avx2': 'CPU + AVX2 SIMD',
    cpu: 'CPU only',
  }[a];
}

function render(r: CheckResult): void {
  const BOLD = '\x1b[1m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const RED = '\x1b[31m';
  const CYAN = '\x1b[36m';
  const RESET = '\x1b[0m';
  const tick = `${GREEN}✓${RESET}`;
  const warn = `${YELLOW}⚠${RESET}`;
  const fail = `${RED}✗${RESET}`;

  console.log(`\n${BOLD}=== whisper.cpp Acceleration Check ===${RESET}\n`);
  console.log(`  Platform:  ${r.platform} / ${r.arch}`);
  console.log(`  OS:        ${r.osVersion}`);
  console.log(`  CPU:       ${r.cpuModel}`);
  console.log(`  ${BOLD}Recommended: ${CYAN}${accelLabel(r.acceleration)}${RESET}\n`);

  if (r.reasons.length) {
    console.log(`${BOLD}Detection:${RESET}`);
    r.reasons.forEach((s) => console.log(`  ${tick} ${s}`));
  }
  if (r.warnings.length) {
    console.log('');
    r.warnings.forEach((s) => console.log(`  ${warn} ${s}`));
  }

  console.log(`\n${BOLD}Prerequisites:${RESET}`);
  r.prereqs.forEach((p) => {
    const icon = p.ok ? tick : fail;
    console.log(`  ${icon} ${p.name}${!p.ok && p.fix ? `\n       fix: ${p.fix}` : ''}`);
  });
  if (!r.prereqsOk) {
    console.log(`\n  ${warn} Fix the above before building.\n`);
  }

  console.log(`\n${BOLD}Build commands:${RESET}`);
  console.log('');
  console.log('  # Clone (skip if already done)');
  console.log('  git clone https://github.com/ggerganov/whisper.cpp ~/whisper.cpp');
  console.log('  cd ~/whisper.cpp');
  console.log('');
  r.cmakeCommand.split('\n').forEach((line) => console.log(`  ${line}`));

  console.log(`\n${BOLD}.env configuration:${RESET}`);
  console.log('');
  for (const [k, v] of Object.entries(r.envVars)) {
    console.log(`  ${k}=${v}`);
  }

  console.log(`\n${BOLD}Next steps:${RESET}`);
  console.log('  1. Build using the commands above');
  console.log('  2. bash whisper-setup/download-model.sh base.en');
  console.log('  3. bash whisper-setup/verify.sh');
  console.log('  4. Copy the .env lines above into your .env file\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platform = process.platform;
const arch = process.arch;

let partial: Partial<CheckResult>;
if (platform === 'darwin') {
  partial = detectMacOS();
} else if (platform === 'linux') {
  partial = detectLinux();
} else if (platform === 'win32') {
  partial = detectWindows();
} else {
  partial = { acceleration: 'cpu', reasons: [`Unsupported platform: ${platform}`], warnings: [], cmakeFlags: [] };
}

const acceleration = partial.acceleration ?? 'cpu';
const { prereqs, prereqsOk } = checkPrereqs(platform, acceleration);
const envVars = suggestedEnvVars(platform);
const cmakeCommand = buildCommand(partial.cmakeFlags ?? [], platform);

const result: CheckResult = {
  platform,
  arch,
  osVersion: partial.osVersion ?? os.release(),
  cpuModel: partial.cpuModel ?? os.cpus()[0]?.model ?? 'unknown',
  acceleration,
  reasons: partial.reasons ?? [],
  warnings: partial.warnings ?? [],
  cmakeFlags: partial.cmakeFlags ?? [],
  cmakeCommand,
  envVars,
  prereqs,
  prereqsOk,
};

render(result);
