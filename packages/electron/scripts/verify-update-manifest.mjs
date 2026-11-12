#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const parseUpdateManifest = (content) => {
  const version = content.match(/^version:\s*(\S+)\s*$/m)?.[1] || '';
  const lines = content.split(/\r?\n/);
  const files = [];
  let entry = null;
  for (const line of lines) {
    const start = line.match(/^\s{2}-\s+(url|sha512|size|blockMapSize):\s*(\S+)\s*$/);
    const field = start || line.match(/^\s{4}(url|sha512|size|blockMapSize):\s*(\S+)\s*$/);
    if (start) {
      if (entry) files.push(entry);
      entry = {};
    }
    if (!field || !entry) continue;
    const [, key, value] = field;
    entry[key] = key === 'size' || key === 'blockMapSize' ? Number(value) : value;
  }
  if (entry) files.push(entry);
  return {
    version,
    files: files.filter((file) => file.url && file.sha512 && Number.isSafeInteger(file.size)),
  };
};

// A Linux manifest lists the AppImage, .deb and .rpm of one architecture;
// each installed format's updater picks its own file from the list.
export const verifyUpdateManifest = ({ manifestPath, artifactPaths, expectedVersion }) => {
  const manifest = parseUpdateManifest(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== expectedVersion) {
    throw new Error(`Update manifest version mismatch: expected ${expectedVersion}, got ${manifest.version || '(missing)'}`);
  }
  const listed = manifest.files.map((entry) => decodeURIComponent(path.basename(entry.url))).sort();
  const expected = artifactPaths.map((artifactPath) => path.basename(artifactPath)).sort();
  if (listed.join('\n') !== expected.join('\n')) {
    throw new Error(`Update manifest artifact mismatch: expected ${expected.join(', ')}, got ${listed.join(', ') || '(none)'}`);
  }
  const artifacts = artifactPaths.map((artifactPath) => {
    const name = path.basename(artifactPath);
    const entry = manifest.files.find((file) => decodeURIComponent(path.basename(file.url)) === name);
    const bytes = fs.readFileSync(artifactPath);
    if (entry.size !== bytes.length) {
      throw new Error(`Update manifest size mismatch for ${name}: expected ${bytes.length}, got ${entry.size}`);
    }
    const checksum = crypto.createHash('sha512').update(bytes).digest('base64');
    if (entry.sha512 !== checksum) throw new Error(`Update manifest sha512 mismatch for ${name}`);
    return { name, size: bytes.length };
  });
  return { version: manifest.version, artifacts };
};

const main = () => {
  const [manifestPath, expectedVersion, ...artifactPaths] = process.argv.slice(2);
  if (!manifestPath || !expectedVersion || artifactPaths.length === 0) {
    throw new Error('Usage: verify-update-manifest.mjs <manifest> <version> <artifact>...');
  }
  const result = verifyUpdateManifest({
    manifestPath: path.resolve(manifestPath),
    artifactPaths: artifactPaths.map((artifactPath) => path.resolve(artifactPath)),
    expectedVersion,
  });
  const names = result.artifacts.map(({ name, size }) => `${name} (${size} bytes)`).join(', ');
  console.log(`[electron] verified ${path.basename(manifestPath)} for ${names}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
