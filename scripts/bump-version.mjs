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
];

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.mjs <version>');
  console.error('Example: node scripts/bump-version.mjs 0.2.0');
  console.error('Example: node scripts/bump-version.mjs 0.2.0-beta.1');
  process.exit(1);
}

console.log(`Bumping version to ${newVersion}\n`);

for (const pkgPath of PACKAGES) {
  const fullPath = path.join(ROOT, pkgPath);
  const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const oldVersion = pkg.version;
  pkg.version = newVersion;
  fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${pkgPath}: ${oldVersion} -> ${newVersion}`);
}

console.log('\nVersion bump complete. Review changes, then commit and tag.');
