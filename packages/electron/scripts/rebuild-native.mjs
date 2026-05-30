#!/usr/bin/env node
import path from 'node:path';
import { existsSync } from 'node:fs';
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

const patchNodeGypForVS2026 = () => {
  if (process.platform === 'win32') {
    try {
      const fs = require('fs');
      const bunDir = path.join(repoRoot, 'node_modules', '.bun');
      if (!existsSync(bunDir)) return;

      const entries = fs.readdirSync(bunDir, { withFileTypes: true });
      const nodeGypDirs = entries
        .filter((e) => e.isDirectory() && (e.name.startsWith('@electron+node-gyp@') || e.name.startsWith('node-gyp@')))
        .map((e) => path.join(bunDir, e.name));

      for (const pkgDir of nodeGypDirs) {
        const findGlob = (base, pattern) => {
          const results = [];
          const walk = (dir) => {
            if (!existsSync(dir)) return;
            for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, item.name);
              if (item.isDirectory()) walk(full);
              else if (item.name === pattern) results.push(full);
            }
          };
          walk(base);
          return results;
        };

        const vsJsFiles = findGlob(path.join(pkgDir, 'node_modules'), 'find-visualstudio.js');
        for (const fullPath of vsJsFiles) {
          let content = fs.readFileSync(fullPath, 'utf8');
          if (!content.includes('ret.versionMajor === 18')) {
            content = content.replace(
              /(if \(ret\.versionMajor === 17\) \{\s+ret\.versionYear = 2022\s+return ret\s+\})/,
              '$1\n    if (ret.versionMajor === 18) {\n      ret.versionYear = 2026\n      return ret\n    }',
            );
            console.log(`[electron] patched ${path.relative(repoRoot, fullPath)} for VS 2026`);
          }
          if (!content.includes('versionYear === 2026')) {
            content = content.replace(
              /(} else if \(versionYear === 2022\) \{\s+return 'v143'\s+\})/,
              "$1 else if (versionYear === 2026) {\n      return 'v145'\n    }",
            );
            content = content.replace(/\[2019, 2022\]/g, '[2019, 2022, 2026]');
            fs.writeFileSync(fullPath, content);
            console.log(`[electron] patched ${path.relative(repoRoot, fullPath)} for v145 toolset`);
          }
        }

        const buildJsFiles = findGlob(path.join(pkgDir, 'node_modules'), 'build.js');
        for (const fullPath of buildJsFiles) {
          let content = fs.readFileSync(fullPath, 'utf8');
          if (!content.includes('SpectreMitigation=false')) {
            content = content.replace(
              "/p:Configuration=' + buildType + ';Platform=' + p)",
              "/p:Configuration=' + buildType + ';Platform=' + p + ';SpectreMitigation=false')",
            );
            fs.writeFileSync(fullPath, content);
            console.log(`[electron] patched ${path.relative(repoRoot, fullPath)} for SpectreMitigation`);
          }
        }
      }
    } catch (err) {
      console.warn('[electron] could not patch node-gyp for VS 2026:', err.message);
    }
  }
};

patchNodeGypForVS2026();

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
} finally {
  try {
    await cleanupNodeAddonApi();
  } finally {
    rebuildPath.cleanup();
  }
}

console.log('[electron] native modules rebuilt successfully');
