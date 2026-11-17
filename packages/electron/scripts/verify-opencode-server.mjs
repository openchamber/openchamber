// Checks the bundled OpenCode server: --staged for resources/opencode-server before packaging, --packaged
// for every copy electron-builder put under dist/. A packaged copy runs `--version` on the packaged app's
// own executable, the way the app starts it, whenever this host can run that executable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENCODE_SERVER_ENTRY, readPinnedOpenCodeServerVersion, verifyOpenCodeServer } from './opencode-server-staging.mjs';
import { readBinaryArchitecture } from './binary-architecture.mjs';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');

const findPackagedServers = () => {
  const distDir = path.join(electronRoot, 'dist');
  if (!fs.existsSync(distDir)) return [];
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.name === 'opencode-server' && fs.existsSync(path.join(fullPath, OPENCODE_SERVER_ENTRY))) found.push(fullPath);
      else visit(fullPath);
    }
  };
  visit(distDir);
  return found;
};

// The app executable beside a packaged `resources/opencode-server`.
const packagedExecutable = (serverDir) => {
  const resources = path.dirname(serverDir);
  if (process.platform === 'darwin') {
    const macos = path.join(path.dirname(resources), 'MacOS');
    const name = fs.existsSync(macos) ? fs.readdirSync(macos).find((file) => !file.startsWith('.')) : null;
    return name ? path.join(macos, name) : null;
  }
  const candidate = path.join(path.dirname(resources), process.platform === 'win32' ? 'OpenChamber.exe' : 'openchamber');
  return fs.existsSync(candidate) ? candidate : null;
};

const runtimeFor = (serverDir, arch) => {
  const executable = packagedExecutable(serverDir);
  if (executable && arch === process.arch && readBinaryArchitecture(executable, process.platform) === process.arch) return executable;
  // --version loads no native code, so Node can answer it for any target architecture.
  return process.execPath;
};

const main = () => {
  const mode = process.argv[2];
  if (mode !== '--staged' && mode !== '--packaged') {
    console.error('Usage: node scripts/verify-opencode-server.mjs --staged|--packaged');
    process.exit(2);
  }
  const version = readPinnedOpenCodeServerVersion();
  const platform = process.platform;
  const arch = resolveTargetArchitecture().node;

  const dirs = mode === '--staged' ? [path.join(electronRoot, 'resources', 'opencode-server')] : findPackagedServers();
  if (dirs.length === 0) throw new Error('No packaged OpenCode server found under packages/electron/dist');
  for (const dir of dirs) {
    const runtime = mode === '--staged' ? process.execPath : runtimeFor(dir, arch);
    verifyOpenCodeServer(dir, { platform, arch, version, runtime });
    console.log(`[electron] verified bundled OpenCode server ${version} for ${platform}-${arch} (ran on ${path.basename(runtime)}): ${dir}`);
  }
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
