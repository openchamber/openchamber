// Points OpenCode at the native files staged beside the bundle (scripts/prepare-opencode-server.mjs), the
// way the prelude of OpenCode's own Node build does (packages/cli/vite.node.config.ts). The bundle inlines
// every package's JavaScript; only these binaries stay on disk. It runs before OpenCode loads, because
// OpenCode loads the PTY binding while its modules evaluate, and the entry passes its own assets folder:
// in the bundle this module sits in a chunk folder of its own.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const configureAssets = (assetsUrl) => {
  const manifestPath = fileURLToPath(new URL('manifest.json', assetsUrl));
  if (!fs.existsSync(manifestPath)) return;
  const root = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
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
    // Without the binding fff reports itself unavailable and OpenCode falls back to its plain file search.
  }
};
