/**
 * Reproduction test for issue #2068: "menu bar icon disappeared?"
 *
 * This script validates the tray icon resource resolution logic that runs
 * in the Electron main process on macOS. It simulates the path construction
 * and file-existence checks that determine whether the tray icon is created.
 *
 * Expected: all tray icon files resolve and exist.
 * Bug: one or more essential icon paths fail to resolve, causing the tray
 * setup to be skipped (tray icon never appears in the menu bar).
 *
 * The user reports the icon was present in 1.12.0 and 1.13.0 but is gone
 * starting in 1.14.0 (macOS desktop).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const electronPkgDir = path.resolve(__dirname, '../../packages/electron');

// Simulates the resourceRoot() logic from main.mjs
const isDev = true;  // We test in the dev/repo layout
const resourceRoot = () => path.join(electronPkgDir, 'resources');
const TRAY_BREATH_FRAME_COUNT = 16;

const trayIconAssets = () => {
  const dir = path.join(resourceRoot(), 'icons', 'tray');
  const statusDir = path.join(dir, 'status');
  return {
    idleIconPath: path.join(dir, 'trayTemplate-idle.png'),
    unseenIconPath: path.join(dir, 'trayTemplate-unseen.png'),
    breathIconPaths: Array.from({ length: TRAY_BREATH_FRAME_COUNT }, (_, i) =>
      path.join(dir, `trayTemplate-breath-${String(i).padStart(2, '0')}.png`)),
    statusIconPaths: {
      busy: path.join(statusDir, 'busy.png'),
      retry: path.join(statusDir, 'retry.png'),
      error: path.join(statusDir, 'error.png'),
      unseen: path.join(statusDir, 'unseen.png'),
      blank: path.join(statusDir, 'blank.png'),
    },
  };
};

// Simulates the setupTray() logic from main.mjs
const simulateSetupTray = () => {
  const assets = trayIconAssets();
  const missing = [];

  // Check the frame icon paths (including @2x variants)
  for (const [label, iconPath] of Object.entries({
    idle: assets.idleIconPath,
    'idle@2x': assets.idleIconPath.replace('.png', '@2x.png'),
    unseen: assets.unseenIconPath,
    'unseen@2x': assets.unseenIconPath.replace('.png', '@2x.png'),
  })) {
    if (!fs.existsSync(iconPath)) missing.push(`Frame: ${label} -> ${iconPath}`);
  }

  // Check breath animation frames (including @2x)
  for (let i = 0; i < TRAY_BREATH_FRAME_COUNT; i++) {
    const baseName = `trayTemplate-breath-${String(i).padStart(2, '0')}.png`;
    const basePath = path.join(resourceRoot(), 'icons', 'tray', baseName);
    const hdPath = basePath.replace('.png', '@2x.png');
    if (!fs.existsSync(basePath)) missing.push(`Breath: ${baseName}`);
    if (!fs.existsSync(hdPath)) missing.push(`Breath@2x: ${baseName.replace('.png', '@2x.png')}`);
  }

  // Check status icons (including @2x)
  for (const [key, iconPath] of Object.entries(assets.statusIconPaths)) {
    if (!fs.existsSync(iconPath)) missing.push(`Status: ${key} -> ${iconPath}`);
    const hdPath = iconPath.replace('.png', '@2x.png');
    if (!fs.existsSync(hdPath)) missing.push(`Status@2x: ${key}@2x -> ${hdPath}`);
  }

  // Check the resource root itself
  const root = resourceRoot();
  if (!fs.existsSync(root)) missing.push(`Resource root does not exist: ${root}`);

  return { assets, missing, ok: missing.length === 0 };
};

const result = simulateSetupTray();
console.log('Tray icon resource check:');
console.log('  Resource root:', resourceRoot());
console.log('  All files found:', result.ok);

if (result.missing.length > 0) {
  console.log('\n  MISSING FILES:');
  for (const m of result.missing) console.log('    -', m);
}

// Detailed per-file listing
console.log('\n  Idle icon:', result.assets.idleIconPath, '->', fs.existsSync(result.assets.idleIconPath));
console.log('  Unseen icon:', result.assets.unseenIconPath, '->', fs.existsSync(result.assets.unseenIconPath));
console.log('  Breath frames:', result.assets.breathIconPaths.length, 'frames, all exist:',
  result.assets.breathIconPaths.every(fs.existsSync));

const statusKeys = Object.keys(result.assets.statusIconPaths);
console.log('  Status icons:', statusKeys.length,
  '(' + statusKeys.join(', ') + ') all exist:',
  Object.values(result.assets.statusIconPaths).every(fs.existsSync));

// Simulate the @2x auto-resolution by macOS: Tray automatically picks @2x,
// but the code constructs the 1x path. The important thing is that the
// 1x file exists (macOS will find the @2x alongside it).
const trayDir = path.join(resourceRoot(), 'icons', 'tray');
const trayFiles = fs.readdirSync(trayDir);
const pngFiles = trayFiles.filter(f => f.endsWith('.png'));
console.log(`\n  Total PNG files in tray dir: ${pngFiles.length}`);
console.log('  Expected: ~' + (1 + 1 + 16 + 5 + 1 + 1 + 16 + 5) + ' files (1x + @2x)');

process.exit(result.ok ? 0 : 1);
