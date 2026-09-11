#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const parseUpdateManifest = (content) => {
  const version = content.match(/^version:\s*(\S+)\s*$/m)?.[1] || '';
  // electron-builder keeps the top-level path and sha512 fields for legacy
  // electron-updater clients. Current clients select the package-specific AppImage
  // or deb entry from files, so release validation intentionally parses and verifies
  // every files entry instead of requiring the legacy path to represent both formats.
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
    files,
  };
};

export const verifyUpdateManifest = ({ manifestPath, artifactPath, artifactPaths, expectedVersion }) => {
  const manifest = parseUpdateManifest(fs.readFileSync(manifestPath, 'utf8'));
  // Release manifests contain both AppImage and deb entries, while the loopback updater
  // fixture intentionally contains only one AppImage. Normalize both callers to one list
  // so every supplied artifact receives the same filename, size, and checksum validation.
  const expectedArtifactPaths = artifactPaths || (artifactPath ? [artifactPath] : []);
  if (expectedArtifactPaths.length === 0) {
    throw new Error('At least one Linux update artifact is required');
  }
  if (manifest.version !== expectedVersion) {
    throw new Error(`Update manifest version mismatch: expected ${expectedVersion}, got ${manifest.version || '(missing)'}`);
  }
  if (manifest.files.length !== expectedArtifactPaths.length) {
    throw new Error(
      `Linux update manifest must contain exactly ${expectedArtifactPaths.length} artifacts, got ${manifest.files.length}`,
    );
  }

  const entriesByName = new Map();
  for (const entry of manifest.files) {
    if (!entry.url || !entry.sha512 || !Number.isSafeInteger(entry.size)) {
      throw new Error('Linux update manifest contains incomplete artifact metadata');
    }
    const name = decodeURIComponent(path.basename(entry.url));
    if (entriesByName.has(name)) {
      throw new Error(`Linux update manifest contains duplicate artifact: ${name}`);
    }
    entriesByName.set(name, entry);
  }

  const artifacts = expectedArtifactPaths.map((expectedArtifactPath) => {
    const expectedName = path.basename(expectedArtifactPath);
    const entry = entriesByName.get(expectedName);
    if (!entry) {
      throw new Error(
        `Update manifest artifact mismatch: expected ${expectedName}, got ${manifest.files.map((file) => file.url || '(missing)').join(', ')}`,
      );
    }
    const bytes = fs.readFileSync(expectedArtifactPath);
    if (entry.size !== bytes.length) {
      throw new Error(`Update manifest size mismatch for ${expectedName}: expected ${bytes.length}, got ${entry.size}`);
    }
    const checksum = crypto.createHash('sha512').update(bytes).digest('base64');
    if (entry.sha512 !== checksum) throw new Error(`Update manifest sha512 mismatch for ${expectedName}`);
    return { name: expectedName, size: bytes.length };
  });

  if (artifacts.length === 1) {
    return { ...artifacts[0], version: manifest.version };
  }
  return { artifacts, version: manifest.version };
};

const main = () => {
  const args = process.argv.slice(2);
  const manifestPath = args.shift();
  const expectedVersion = args.pop();
  if (!manifestPath || args.length === 0 || !expectedVersion) {
    throw new Error('Usage: verify-update-manifest.mjs <manifest> <artifact...> <version>');
  }
  const result = verifyUpdateManifest({
    manifestPath: path.resolve(manifestPath),
    artifactPaths: args.map((artifact) => path.resolve(artifact)),
    expectedVersion,
  });
  const artifacts = result.artifacts || [{ name: result.name, size: result.size }];
  console.log(
    `[electron] verified ${path.basename(manifestPath)} for ${artifacts.map(({ name, size }) => `${name} (${size} bytes)`).join(', ')}`,
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
