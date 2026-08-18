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

export const verifyUpdateManifest = ({ manifestPath, artifactPath, expectedVersion }) => {
  const manifest = parseUpdateManifest(fs.readFileSync(manifestPath, 'utf8'));
  const expectedName = path.basename(artifactPath);
  if (manifest.version !== expectedVersion) {
    throw new Error(`Update manifest version mismatch: expected ${expectedVersion}, got ${manifest.version || '(missing)'}`);
  }
  if (manifest.files.length !== 1) {
    throw new Error(`Linux update manifest must contain exactly one artifact, got ${manifest.files.length}`);
  }
  const [entry] = manifest.files;
  if (decodeURIComponent(path.basename(entry.url)) !== expectedName) {
    throw new Error(`Update manifest artifact mismatch: expected ${expectedName}, got ${entry.url}`);
  }
  const bytes = fs.readFileSync(artifactPath);
  if (entry.size !== bytes.length) {
    throw new Error(`Update manifest size mismatch: expected ${bytes.length}, got ${entry.size}`);
  }
  const checksum = crypto.createHash('sha512').update(bytes).digest('base64');
  if (entry.sha512 !== checksum) throw new Error('Update manifest sha512 mismatch');
  return { name: expectedName, size: bytes.length, version: manifest.version };
};

const main = () => {
  const [manifestPath, artifactPath, expectedVersion] = process.argv.slice(2);
  if (!manifestPath || !artifactPath || !expectedVersion) {
    throw new Error('Usage: verify-update-manifest.mjs <manifest> <artifact> <version>');
  }
  const result = verifyUpdateManifest({
    manifestPath: path.resolve(manifestPath),
    artifactPath: path.resolve(artifactPath),
    expectedVersion,
  });
  console.log(`[electron] verified ${path.basename(manifestPath)} for ${result.name} (${result.size} bytes)`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
