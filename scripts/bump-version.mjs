#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PACKAGES = [
  'package.json',
  'packages/ui/package.json',
  'packages/web/package.json',
  'packages/desktop/package.json',
  'packages/electron/package.json',
  'packages/vscode/package.json',
];

const TAURI_CONF = 'packages/desktop/src-tauri/tauri.conf.json';
const CARGO_TOML = 'packages/desktop/src-tauri/Cargo.toml';
const CARGO_LOCK = 'packages/desktop/src-tauri/Cargo.lock';

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.mjs <version>');
  console.error('Example: node scripts/bump-version.mjs 0.2.0');
  console.error('Example: node scripts/bump-version.mjs 0.2.0-beta.1');
  process.exit(1);
}

console.log(`Bumping version to ${newVersion}\n`);

// Update package.json files
for (const pkgPath of PACKAGES) {
  const fullPath = path.join(ROOT, pkgPath);
  const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const oldVersion = pkg.version;
  pkg.version = newVersion;
  fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${pkgPath}: ${oldVersion} -> ${newVersion}`);
}

// Update tauri.conf.json
const tauriConfPath = path.join(ROOT, TAURI_CONF);
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
const oldTauriVersion = tauriConf.version;
tauriConf.version = newVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log(`  ${TAURI_CONF}: ${oldTauriVersion} -> ${newVersion}`);

// Update Cargo.toml
const cargoPath = path.join(ROOT, CARGO_TOML);
let cargoContent = fs.readFileSync(cargoPath, 'utf8');
const cargoMatch = cargoContent.match(/^version = "(.*)"/m);
const oldCargoVersion = cargoMatch ? cargoMatch[1] : 'unknown';
cargoContent = cargoContent.replace(
  /^version = ".*"$/m,
  `version = "${newVersion}"`
);
fs.writeFileSync(cargoPath, cargoContent);
console.log(`  ${CARGO_TOML}: ${oldCargoVersion} -> ${newVersion}`);

// Update Cargo.lock for openchamber-desktop, if present
const cargoLockPath = path.join(ROOT, CARGO_LOCK);
if (fs.existsSync(cargoLockPath)) {
  try {
    let lockContent = fs.readFileSync(cargoLockPath, 'utf8');
    const anchor = 'name = "openchamber-desktop"';
    const anchorIndex = lockContent.indexOf(anchor);
    if (anchorIndex !== -1) {
      // find the next version line after the anchor
      const verIndex = lockContent.indexOf('version', anchorIndex);
      if (verIndex !== -1) {
        const q1 = lockContent.indexOf('"', verIndex);
        const q2 = lockContent.indexOf('"', q1 + 1);
        const oldLockVersion = lockContent.substring(q1 + 1, q2);
        lockContent = lockContent.substring(0, q1 + 1) + newVersion + lockContent.substring(q2);
        fs.writeFileSync(cargoLockPath, lockContent);
        console.log(`  ${CARGO_LOCK}: ${oldLockVersion} -> ${newVersion}`);
      } else {
        console.warn(`Warning: could not locate version line in ${CARGO_LOCK}`);
      }
    } else {
      console.warn(`Warning: could not find openchamber-desktop entry in ${CARGO_LOCK}`);
    }
  } catch (e) {
    console.error(`Failed to update ${CARGO_LOCK}:`, e);
  }
} else {
  // No lock file to update; ignore gracefully
  console.log(`Cargo.lock not found at ${CARGO_LOCK}, skipping lock update`);
}

console.log(`\nVersion bumped to ${newVersion}`);
console.log('\nNext steps:');
console.log(`  git add -A`);
console.log(`  git commit -m "release v${newVersion}"`);
console.log(`  git tag v${newVersion}`);
console.log(`  git push origin main --tags`);
