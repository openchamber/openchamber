/**
 * Loader for the sherpa-onnx-node native addon.
 *
 * sherpa-onnx-node ships its native addon and shared libraries in a
 * platform-specific package (e.g. sherpa-onnx-darwin-arm64). The shared
 * libraries must be findable via the platform's dynamic-loader search path,
 * so the loader prepends the platform package directory to LD_LIBRARY_PATH /
 * DYLD_LIBRARY_PATH / PATH before requiring the addon.
 */

import { createRequire } from 'module';
import path from 'path';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);

let cached = null;

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

function prependEnvPath(existing, value) {
  const parts = String(existing ?? '').split(path.delimiter).filter(Boolean);
  if (parts.includes(value)) {
    return parts.join(path.delimiter);
  }
  return [value, ...parts].join(path.delimiter);
}

/**
 * Case-insensitive env key lookup: on Windows `{...process.env}` yields a
 * plain object where PATH may be stored as `Path`. Using a hardcoded 'PATH'
 * would create a duplicate key and break the child process PATH.
 */
function findEnvKey(env, key) {
  const lower = key.toLowerCase();
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === lower) {
      return k;
    }
  }
  return key;
}

function resolveSherpaLibDir(platform = process.platform, arch = process.arch) {
  const packageName = sherpaPlatformPackageName(platform, arch);
  try {
    const pkgJson = require.resolve(`${packageName}/package.json`);
    // Electron packages node_modules inside app.asar, but native addons and
    // their shared libraries are extracted to app.asar.unpacked. The dynamic
    // loader (dlopen/DYLD/LD) cannot read from the asar archive, so point the
    // search path at the unpacked copy.
    const dir = path.dirname(pkgJson);
    const unpacked = dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return existsSync(unpacked) ? unpacked : dir;
  } catch {
    return null;
  }
}

/**
 * Prepend the sherpa platform package dir to the loader search path env var.
 * Mutates the provided env object.
 * @param {NodeJS.ProcessEnv} env
 */
export function applySherpaLoaderEnv(env) {
  const key = sherpaLoaderEnvKey();
  const libDir = resolveSherpaLibDir();
  if (!key || !libDir) {
    return { key: null, libDir: null };
  }
  const actualKey = findEnvKey(env, key);
  env[actualKey] = prependEnvPath(env[actualKey], libDir);
  return { key, libDir };
}

/**
 * Load the sherpa-onnx-node module, trying the upstream entry first and then
 * the platform addon directly.
 */
export function loadSherpaOnnxNode() {
  if (cached) {
    return cached;
  }

  const attempts = [];

  try {
    cached = require('sherpa-onnx-node');
    return cached;
  } catch (error) {
    attempts.push(`sherpa-onnx-node: ${error?.message || String(error)}`);
  }

  const libDir = resolveSherpaLibDir();
  if (libDir) {
    applySherpaLoaderEnv(process.env);
    const addonPath = path.join(libDir, 'sherpa-onnx.node');
    if (existsSync(addonPath)) {
      try {
        cached = require(addonPath);
        return cached;
      } catch (error) {
        attempts.push(`${addonPath}: ${error?.message || String(error)}`);
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
