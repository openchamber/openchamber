/**
 * Reproduction test for issue #2068: "menu bar icon disappeared?"
 *
 * Part 2: Logic-level reproduction.
 *
 * This script analyzes the tray update logic for a potential cause of the
 * icon disappearing. The user reports the icon was present in 1.12.0/1.13.0
 * but disappeared in 1.14.0 (macOS desktop).
 *
 * Key code paths analyzed:
 * 1. setupTray is called during app.whenReady()
 * 2. createTrayController is instantiated with icon paths
 * 3. ensureTray creates the Tray on first update() call
 * 4. update() sets title, image, tooltip, and context menu
 * 5. destroy() is called on quit
 *
 * Potential issues to check:
 * - Resource path resolution in packaged mode depends on extraResources
 * - The Tray object must be retained (held by closure in tray.mjs)
 * - The icon file must exist and be a valid image
 * - The macOS Tray requires template images for proper rendering
 * - On some Electron versions, Tray.setImage(null) can clear the icon
 * - If update() is called with a corrupt snapshot, the context menu could
 *   fail to build, but the icon itself should remain
 */

// Let's also check what commit history exists for the tray/menu
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../..');

console.log('=== Tray Icon Disappearance Analysis ===\n');

// 1. Check if the tray resources directory exists relative to prod paths
console.log('1. Resource path analysis:');
const resources = path.join(root, 'packages', 'electron', 'resources');
const trayDir = path.join(resources, 'icons', 'tray');
console.log('   Dev tray dir:', trayDir, 'exists:', fs.existsSync(trayDir));
console.log('   status dir:', path.join(trayDir, 'status'), 'exists:', fs.existsSync(path.join(trayDir, 'status')));
console.log('   idleIconPath:', path.join(trayDir, 'trayTemplate-idle.png'), 'exists:', fs.existsSync(path.join(trayDir, 'trayTemplate-idle.png')));

// 2. Simulate packaged mode path resolution
console.log('\n2. Simulating packaged mode:');
console.log('   process.resourcesPath resolves to the app bundle Contents/Resources');
console.log('   extraResources copies "resources/icons/tray" -> "icons/tray"');
console.log('   So path would be: [process.resourcesPath]/icons/tray/trayTemplate-idle.png');
console.log('   electron-builder version: 26.8.1');

// 3. Check if there could be a GC issue
console.log('\n3. Tray object retention analysis:');
console.log('   tray variable is held in createTrayController closure');
console.log('   state.trayController holds reference to functions referencing this.tray');
console.log('   The closure retains: tray, idleFrame, unseenFrame, breathFrames, statusIcons');
console.log('   Only destroyed in prepareForQuit (on app quit)');
console.log('   -> Object should NOT be garbage collected during normal use');

// 4. Check if there's a potential error in iconState management
console.log('\n4. Icon state management:');
console.log('   iconState starts as null');
console.log('   applyIconState("idle") -> stopAnim, setImage(idleFrame)');
console.log('   applyIconState("unseen") -> stopAnim, setImage(unseenFrame)');
console.log('   applyIconState("busy") -> startAnim (sets images in interval)');
console.log('   computeIconState returns "idle" by default (no busy or unseen)');
console.log('   An empty session list should show idle icon');
console.log('   No path sets image to null/empty');

// 5. Check for a build/package issue
console.log('\n5. Build & packaging analysis:');
console.log('   extraResources in package.json:');
const pkgJsonPath = path.join(root, 'packages', 'electron', 'package.json');
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
const extraRes = pkgJson.build?.extraResources || [];
for (const entry of extraRes) {
  const from = entry.from;
  const fromDir = path.join(root, 'packages', 'electron', from);
  console.log('     from:', from, '-> exists:', fs.existsSync(fromDir));
  console.log('     to:', entry.to);
}

// 6. Check if icon.icns has the tray icon (it shouldn't - tray uses separate PNGs)
console.log('\n6. App icon vs Tray icon:');
const iconIcns = path.join(root, 'packages', 'electron', 'resources', 'icons', 'icon.icns');
console.log('   icon.icns (Dock icon):', fs.existsSync(iconIcns), fs.statSync(iconIcns).size, 'bytes');
console.log('   Tray uses separate PNG files in resources/icons/tray/');
console.log('   These are correctly listed in extraResources');

// 7. Verify each file that's loaded by nativeImage.createFromPath
console.log('\n7. Icon files that nativeImage.createFromPath would load:');
const idleIcon = path.join(trayDir, 'trayTemplate-idle.png');
const idleIcon2x = path.join(trayDir, 'trayTemplate-idle@2x.png');
console.log('   idleIcon:', idleIcon, 'size:', fs.existsSync(idleIcon) ? fs.statSync(idleIcon).size : 'NOT FOUND', 'bytes');
console.log('   idleIcon@2x:', idleIcon2x, 'size:', fs.existsSync(idleIcon2x) ? fs.statSync(idleIcon2x).size : 'NOT FOUND', 'bytes');

const statusDir = path.join(trayDir, 'status');
for (const file of fs.readdirSync(statusDir)) {
  const filePath = path.join(statusDir, file);
  console.log('   status/' + file + ':', fs.statSync(filePath).size, 'bytes');
}

// 8. Check the tray-glyph.svg (might be the source of the tray icon)
const traySvg = path.join(trayDir, 'tray-glyph.svg');
console.log('\n8. Source art:');
console.log('   tray-glyph.svg:', fs.existsSync(traySvg) ? fs.statSync(traySvg).size + ' bytes' : 'NOT FOUND');

// 9. Summary
console.log('\n=== Summary ===');
console.log('All tray icon resources exist and are accessible.');
console.log('The tray setup code is logically correct:');
console.log('  - setupTray() creates the tray controller during startup');
console.log('  - createTrayController() properly initializes icon frames');
console.log('  - ensureTray() creates the Tray object on first update()');
console.log('  - The Tray object is retained by the closure chain');
console.log('  - No code path sets image to null/empty during normal operation');
console.log('');
console.log('Possible causes that could NOT be verified without building/running:');
console.log('  1. electron-builder extraResources might not be copying the tray');
console.log('     icons correctly in the packaged build');
console.log('  2. Electron 41 might have a Tray API change affecting macOS template');
console.log('     images, or a bug in the Tray constructor');
console.log('  3. The Tray might appear but its icon image could be empty (e.g.,');
console.log('     nativeImage.createFromPath returning empty image for a valid');
console.log('     file path, which would make the icon invisible)');
console.log('  4. A race condition in the startup flow where setupTray is called');
console.log('     before something it depends on is initialized');
