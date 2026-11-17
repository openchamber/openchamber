import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { followFile } from './cli-log-files.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// followFile polls every 400 ms; each step below waits past one poll so
// the appends land in separate polls by construction.
const POLL_MS = 400;

const withTempLog = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cli-logfiles-'));
  const file = path.join(dir, 'test.log');
  fs.writeFileSync(file, '');
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('followFile', () => {
  it('delivers a multi-byte character split across two polls intact', async () => {
    await withTempLog(async (file) => {
      const lines = [];
      const stop = followFile(file, (line) => lines.push(line));
      try {
        const full = Buffer.from('mood: \u{1F600} done\n', 'utf8');
        // U+1F600 is 4 bytes (f0 9f 98 80) starting at byte 6: split it 2/2.
        const splitAt = 6 + 2;
        fs.appendFileSync(file, full.subarray(0, splitAt));
        await sleep(POLL_MS + 300);
        fs.appendFileSync(file, full.subarray(splitAt));
        await sleep(POLL_MS + 300);
        expect(lines).toEqual(['mood: \u{1F600} done']);
        expect(lines[0]).not.toContain('\uFFFD');
      } finally {
        stop();
      }
    });
  }, 15000);

  it('delivers whole-append and ASCII lines unchanged', async () => {
    await withTempLog(async (file) => {
      const lines = [];
      const stop = followFile(file, (line) => lines.push(line));
      try {
        fs.appendFileSync(file, 'plain ascii line\n');
        fs.appendFileSync(file, 'whole \u{1F600} append\n');
        await sleep(POLL_MS + 300);
        expect(lines).toEqual(['plain ascii line', 'whole \u{1F600} append']);
      } finally {
        stop();
      }
    });
  }, 15000);

  it('restarts cleanly after truncation, with no carried fragment or decoder state', async () => {
    await withTempLog(async (file) => {
      const lines = [];
      const stop = followFile(file, (line) => lines.push(line));
      try {
        // A partial line (no newline) whose tail is half of U+1F600: the
        // fragment and the decoder's held bytes belong to this file.
        const partial = Buffer.from('stale \u{1F600}', 'utf8');
        fs.appendFileSync(file, partial.subarray(0, partial.length - 2));
        await sleep(POLL_MS + 300);
        // Truncate and rewrite smaller: the follower resets to position 0.
        fs.writeFileSync(file, 'fresh\n');
        await sleep(POLL_MS + 300);
        expect(lines).toEqual(['fresh']);
      } finally {
        stop();
      }
    });
  }, 15000);
});
