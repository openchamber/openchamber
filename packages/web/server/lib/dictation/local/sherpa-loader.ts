
import { createRequire } from 'module';
import path from 'path';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);

export interface SherpaNodeModule {
  version: string;
  OfflineRecognizer?: unknown;
  OfflineTts?: unknown;
}

let cached: SherpaNodeModule | null = null;

function sherpaPlatformPackageName(platform = process.platform, arch = process.arch) {
  const normalizedPlatform = platform === 'win32' ? 'win' : platform;
  return `sherpa-onnx-${normalizedPlatform}-${arch}`;
}

function sherpaLoaderEnvKey(platform = process.platform) {
  if (platform === 'linux') {
    return 'LD_LIBRARY_PATH';
  }
  if (platform === 'darwin') {
    return 'DYLD_LIBRARY_PATH';
  }
  if (platform === 'win32') {
    return 'PATH';
  }
  return null;
}

function prependEnvPath(existing: string | undefined, value: string) {
  const parts = String(existing ?? '').split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) {
    return parts.join(path.delimiter);
  }
  return [value, ...parts].join(path.delimiter);
}

function findEnvKey(env: NodeJS.ProcessEnv, key: string) {
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) {
      return k;
    }
  }
  return key;
}

function sherpaResolvers() {
  try {
    return [createRequire(require.resolve('sherpa-onnx-node')), require];
  } catch {
    return [require];
  }
}

function resolveSherpaLibDir(platform = process.platform, arch = process.arch) {
  const packageName = sherpaPlatformPackageName(platform, arch);
  for (const resolver of sherpaResolvers()) {
    try {
      const pkgJson = resolver.resolve(`${packageName}/package.json`);
      const dir = path.dirname(pkgJson);
      const unpacked = dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      return existsSync(unpacked) ? unpacked : dir;
    } catch {
      continue;
    }
  }
  return null;
}

export function applySherpaLoaderEnv(env: NodeJS.ProcessEnv) {
  const key = sherpaLoaderEnvKey();
  const libDir = resolveSherpaLibDir();
  if (!key || !libDir) {
    return { key: null, libDir: null };
  }
  const actualKey = findEnvKey(env, key);
  env[actualKey] = prependEnvPath(env[actualKey], libDir);
  return { key, libDir };
}

function hasMessage(value: unknown): value is { message?: unknown } {
  return value !== null && value !== undefined;
}

export function loadSherpaOnnxNode(): SherpaNodeModule {
  if (cached) {
    return cached;
  }

  const attempts = [];

  try {
    const wrapper: SherpaNodeModule = require('sherpa-onnx-node');
    cached = wrapper;
    return cached;
  } catch (error) {
    const message = hasMessage(error) ? error.message : undefined;
    attempts.push(`sherpa-onnx-node: ${message || String(error)}`);
  }

  const libDir = resolveSherpaLibDir();
  if (libDir) {
    applySherpaLoaderEnv(process.env);
    const addonPath = path.join(libDir, 'sherpa-onnx.node');
    if (existsSync(addonPath)) {
      try {
        const addon: SherpaNodeModule = require(addonPath);
        cached = addon;
        return cached;
      } catch (error) {
        const message = hasMessage(error) ? error.message : undefined;
        attempts.push(`${addonPath}: ${message || String(error)}`);
      }
    } else {
      attempts.push(`${addonPath}: file not found`);
    }
  } else {
    attempts.push(`${sherpaPlatformPackageName()}: platform package not installed`);
  }

  throw new Error(
    [
      `Failed to load sherpa-onnx-node for ${process.platform}-${process.arch}.`,
      `Node ${process.version} (ABI ${process.versions.modules}).`,
      'Load attempts:',
      ...attempts.map((line) => `- ${line}`),
    ].join('\n'),
  );
}
