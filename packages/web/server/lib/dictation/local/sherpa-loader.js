
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

// external: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options Windows environment keys are case-insensitive; duplicate PATH keys break child-process lookup.
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
  const resolvers = [];
  try {
    resolvers.push(createRequire(require.resolve('sherpa-onnx-node')));
  } catch {
  }
  resolvers.push(require);

  for (const resolver of resolvers) {
    try {
      const pkgJson = resolver.resolve(`${packageName}/package.json`);
      // external: https://www.electronjs.org/docs/latest/tutorial/asar-archives#extra-unpacking-on-some-apis Native addons and shared libraries must load from app.asar.unpacked.
      const dir = path.dirname(pkgJson);
      const unpacked = dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      return existsSync(unpacked) ? unpacked : dir;
    } catch {
      continue;
    }
  }
  return null;
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
