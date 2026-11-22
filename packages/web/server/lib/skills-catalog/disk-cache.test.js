import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DISK_CACHE_MAX_BYTES, readDiskCache, writeDiskCache } from './disk-cache.js';

const isWindows = process.platform === 'win32';

let dataDir;
let previousDataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-disk-cache-'));
  previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('disk cache', () => {
  it('round-trips a persisted object and answers null for a missing file', () => {
    expect(readDiskCache('cache.json')).toBeNull();

    expect(writeDiskCache('cache.json', { a: 1 })).toBe(true);
    expect(readDiskCache('cache.json')).toEqual({ a: 1 });
  });

  it('answers null for a malformed or non-object file', () => {
    fs.writeFileSync(path.join(dataDir, 'cache.json'), '{broken');
    expect(readDiskCache('cache.json')).toBeNull();

    fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify([1, 2]));
    expect(readDiskCache('cache.json')).toBeNull();
  });

  it('answers null for an over-cap file instead of parsing it whole', () => {
    // Valid JSON whose size crosses the cap: rejection must come from
    // the bounded read, not from a parse failure.
    const oversized = JSON.stringify({ blob: 'x'.repeat(DISK_CACHE_MAX_BYTES) });
    fs.writeFileSync(path.join(dataDir, 'cache.json'), oversized);

    expect(readDiskCache('cache.json')).toBeNull();
  });

  it.skipIf(isWindows)('answers null for a FIFO in bounded time instead of blocking', () => {
    execFileSync('mkfifo', [path.join(dataDir, 'cache.json')]);

    expect(readDiskCache('cache.json')).toBeNull();
  });
});
