#!/usr/bin/env node
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rebuild } from '@electron/rebuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const electronDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(electronDir, '..', '..');
const require = createRequire(import.meta.url);
const webRequire = createRequire(path.join(repoRoot, 'packages', 'web', 'package.json'));

const electronPkg = require('electron/package.json');
const electronVersion = electronPkg.version;

const copyDirectory = async (src, dst) => {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(from, to);
    } else {
      await fsp.copyFile(from, to);
    }
  }
};

const getWindowsShortPath = (target) => {
  if (process.platform !== 'win32') return target;
  try {
    const escaped = target.replace(/'/g, "''");
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder('${escaped}').ShortPath`],
      { encoding: 'utf8' },
    ).trim();
    return output || target;
  } catch {
    return target;
  }
};

const createWindowsRebuildPath = (target) => {
  if (process.platform !== 'win32') {
    return { buildPath: target, cleanup: () => {} };
  }

  for (const letter of 'ZYXWVUTSRQPONMLKJIHGFED') {
    const drive = `${letter}:`;
    if (existsSync(`${drive}\\`)) continue;
    try {
      execFileSync('subst.exe', [drive, target], { stdio: 'ignore' });
      return {
        buildPath: `${drive}\\`,
        cleanup: () => {
          try {
            execFileSync('subst.exe', [drive, '/d'], { stdio: 'ignore' });
          } catch {
            // Best-effort cleanup. The build result should not depend on this.
          }
        },
      };
    } catch {
      // Try the next drive letter.
    }
  }

  const shortPath = getWindowsShortPath(target);
  if (shortPath === target && /\s/.test(target)) {
    throw new Error(
      `Unable to create a space-free Windows rebuild path for ${target}. `
      + 'All subst drive letters are unavailable and the volume did not return an 8.3 short path.',
    );
  }

  return { buildPath: shortPath, cleanup: () => {} };
};

const writeWindowsNodeAddonApiIndex = async (nodeAddonApiDir, exportedNodeAddonApiDir) => {
  if (process.platform !== 'win32') return;

  const shortDir = getWindowsShortPath(exportedNodeAddonApiDir);
  await fsp.writeFile(
    path.join(nodeAddonApiDir, 'index.js'),
    `const path = require('path');

const includeDir = ${JSON.stringify(shortDir)};

module.exports = {
  include: \`"${shortDir}"\`,
  include_dir: includeDir,
  gyp: path.join(includeDir, 'node_api.gyp:nothing'),
  targets: path.join(includeDir, 'node_addon_api.gyp'),
  isNodeApiBuiltin: true,
  needsFlag: false
};
`,
  );
};

const ensureWindowsNodeAddonApiForNodePty = async (rebuildRootPath) => {
  if (process.platform !== 'win32') return async () => {};

  const nodePtyPackagePath = require.resolve('node-pty/package.json');
  const nodePtyDir = path.dirname(nodePtyPackagePath);
  const rootNodeAddonApiDir = path.dirname(require.resolve('node-addon-api/package.json'));
  const tempNodeAddonApiDir = path.join(repoRoot, 'node_modules', '.openchamber-node-addon-api-7.1.1');
  const exportedTempNodeAddonApiDir = path.join(rebuildRootPath, 'node_modules', '.openchamber-node-addon-api-7.1.1');
  const localNodeAddonApiDir = path.join(nodePtyDir, 'node_modules', 'node-addon-api');

  await fsp.rm(tempNodeAddonApiDir, { recursive: true, force: true });
  await copyDirectory(rootNodeAddonApiDir, tempNodeAddonApiDir);
  await fsp.access(path.join(tempNodeAddonApiDir, 'package.json'));

  await fsp.rm(localNodeAddonApiDir, { recursive: true, force: true });
  await copyDirectory(rootNodeAddonApiDir, localNodeAddonApiDir);
  await writeWindowsNodeAddonApiIndex(localNodeAddonApiDir, exportedTempNodeAddonApiDir);
  await fsp.access(path.join(localNodeAddonApiDir, 'package.json'));

  return async () => {
    await fsp.rm(localNodeAddonApiDir, { recursive: true, force: true });
    await fsp.rm(tempNodeAddonApiDir, { recursive: true, force: true });
  };
};

const resolveElectronNodeGyp = () => {
  const bunStore = path.join(repoRoot, 'node_modules', '.bun');
  const entry = readdirSync(bunStore, { withFileTypes: true })
    .find((candidate) => candidate.isDirectory() && candidate.name.startsWith('@electron+node-gyp@'));
  if (!entry) {
    throw new Error('Unable to locate Electron node-gyp in Bun workspace dependencies.');
  }
  const nodeGypPath = path.join(bunStore, entry.name, 'node_modules', '@electron', 'node-gyp', 'bin', 'node-gyp.js');
  if (!existsSync(nodeGypPath)) {
    throw new Error(`Electron node-gyp executable is missing: ${nodeGypPath}`);
  }
  return nodeGypPath;
};

const rebuildBetterSqliteForElectron = () => {
  // @electron/rebuild cannot follow Bun's workspace symlink into the web
  // package, so it reports success while leaving better-sqlite3 on the host
  // Node ABI. Build this one dependency directly against Electron headers.
  const packageDir = path.dirname(webRequire.resolve('better-sqlite3/package.json'));
  const nodeGypPath = resolveElectronNodeGyp();
  execFileSync(process.execPath, [
    nodeGypPath,
    'rebuild',
    '--release',
    `--target=${electronVersion}`,
    `--arch=${process.env.ELECTRON_BUILDER_ARCH || process.arch}`,
    '--dist-url=https://electronjs.org/headers',
  ], {
    cwd: packageDir,
    env: {
      ...process.env,
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_arch: process.env.ELECTRON_BUILDER_ARCH || process.arch,
      npm_config_disturl: 'https://electronjs.org/headers',
    },
    stdio: 'inherit',
  });
};

console.log(`[electron] rebuilding native modules against Electron ${electronVersion}...`);

// Rebuild against the hoisted root node_modules (bun workspace layout).
// force=true re-links regardless of cached state; prebuild-install lookup is
// bypassed by @electron/rebuild in favor of direct node-gyp builds.
const rebuildPath = createWindowsRebuildPath(repoRoot);
let cleanupNodeAddonApi = async () => {};
try {
  cleanupNodeAddonApi = await ensureWindowsNodeAddonApiForNodePty(rebuildPath.buildPath);
  await rebuild({
    buildPath: rebuildPath.buildPath,
    electronVersion,
    force: true,
    arch: process.env.ELECTRON_BUILDER_ARCH || process.arch,
    onlyModules: ['better-sqlite3', 'node-pty', 'bun-pty'],
  });
  rebuildBetterSqliteForElectron();
} finally {
  try {
    await cleanupNodeAddonApi();
  } finally {
    rebuildPath.cleanup();
  }
}

console.log('[electron] native modules rebuilt successfully');
