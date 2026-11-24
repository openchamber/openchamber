// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/vite.node.config.ts
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isLinuxMusl = () => {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report?.getReport?.()?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
};

const configureFromNodeModules = (root, photonWasm) => {
  const require = createRequire(path.join(root, 'manifest.json'));
  const platform = process.platform;
  const arch = process.arch;
  const linux = platform === 'linux';
  const win = platform === 'win32';
  const musl = isLinuxMusl();

  if (photonWasm) {
    const wasmPath = path.join(root, photonWasm);
    if (fs.existsSync(wasmPath)) {
      process.env.OPENCODE_PHOTON_WASM_PATH = wasmPath;
      globalThis.__OPENCODE_PHOTON_WASM_PATH = wasmPath;
    }
  }

  try {
    process.env.OPENCODE_NODE_PTY_PATH = require.resolve('@lydell/node-pty');
  } catch {
  }

  try {
    const watcherPkg = require.resolve('@parcel/watcher/package.json');
    const watcherRequire = createRequire(watcherPkg);
    const watcherTarget = `@parcel/watcher-${platform}-${arch}${linux ? (musl ? '-musl' : '-glibc') : ''}`;
    process.env.OPENCODE_PARCEL_WATCHER_PATH = path.join(
      path.dirname(watcherRequire.resolve(`${watcherTarget}/package.json`)),
      'watcher.node',
    );
  } catch {
  }

  if (!process.env.OPENCODE_PTY_BIN) {
    try {
      const ptyPkg = require.resolve('@opencode/pty/package.json');
      const ptyRequire = createRequire(ptyPkg);
      const ptyTarget = `@opencode/pty-${platform}-${arch}${linux ? (musl ? '-musl' : '-gnu') : ''}`;
      process.env.OPENCODE_PTY_BIN = path.join(
        path.dirname(ptyRequire.resolve(`${ptyTarget}/package.json`)),
        'bin',
        win ? 'opencode-pty.exe' : 'opencode-pty',
      );
    } catch {
    }
  }

  try {
    const fffPkg = require.resolve('@ff-labs/fff-node/package.json');
    const fffRequire = createRequire(fffPkg);
    const fffTarget = `@ff-labs/fff-bin-${platform}-${arch}${linux ? (musl ? '-musl' : '-gnu') : ''}`;
    const fffFile = platform === 'darwin' ? 'libfff_c.dylib' : win ? 'fff_c.dll' : 'libfff_c.so';
    process.env.FFF_BINARY_PATH = path.join(
      path.dirname(fffRequire.resolve(`${fffTarget}/package.json`)),
      fffFile,
    );
    globalThis.__OPENCODE_FFF_FFI = fffRequire('ffi-rs');
  } catch {
  }
};

export const configureAssets = (assetsUrl) => {
  const manifestPath = fileURLToPath(new URL('manifest.json', assetsUrl));
  if (!fs.existsSync(manifestPath)) return;
  const root = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.mode === 'node_modules') {
    configureFromNodeModules(root, manifest.photonWasm);
    return;
  }
  const asset = (relative) => path.join(root, relative);
  process.env.OPENCODE_NODE_PTY_PATH = asset(manifest.nodePty);
  process.env.OPENCODE_PARCEL_WATCHER_PATH = asset(manifest.parcelWatcher);
  process.env.OPENCODE_PHOTON_WASM_PATH = asset(manifest.photonWasm);
  process.env.FFF_BINARY_PATH = asset(manifest.fff);
  process.env.OPENCODE_FFF_FFI_PATH = asset(manifest.fffFfi);
  if (!process.env.OPENCODE_PTY_BIN) process.env.OPENCODE_PTY_BIN = asset(manifest.persistentPty);
  globalThis.__OPENCODE_PHOTON_WASM_PATH = process.env.OPENCODE_PHOTON_WASM_PATH;
  try {
    globalThis.__OPENCODE_FFF_FFI = createRequire(import.meta.url)(process.env.OPENCODE_FFF_FFI_PATH);
  } catch {
  }
};
