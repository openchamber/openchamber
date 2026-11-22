import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readBoundedFile, readBoundedFileSync } from './bounded-file-read.js';

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-file-read-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeFile = (name, content) => {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
};

// The comparable outcome of an outcome: buffers compare by content, and the
// sync and async spellings must agree on everything else field for field.
const comparable = (result) =>
  result.ok
    ? { ok: true, size: result.size, content: result.buffer.toString('utf8') }
    : { ...result };

describe('readBoundedFile / readBoundedFileSync', () => {
  it('reads a file under the cap whole', async () => {
    const filePath = writeFile('small.txt', 'hello');
    const asyncResult = await readBoundedFile(filePath, 16);
    expect(comparable(asyncResult)).toEqual({ ok: true, size: 5, content: 'hello' });
    expect(comparable(readBoundedFileSync(filePath, 16))).toEqual(comparable(asyncResult));
  });

  it('reads an empty file as an empty success', async () => {
    const filePath = writeFile('empty.txt', '');
    expect(comparable(await readBoundedFile(filePath, 16))).toEqual({ ok: true, size: 0, content: '' });
    expect(comparable(readBoundedFileSync(filePath, 16))).toEqual({ ok: true, size: 0, content: '' });
  });

  it('answers missing for a file that does not exist, distinct from over-cap', async () => {
    const filePath = path.join(dir, 'absent.txt');
    const expected = { ok: false, reason: 'missing', code: 'BOUNDED_FILE_MISSING', path: filePath };
    expect(await readBoundedFile(filePath, 16)).toEqual(expected);
    expect(readBoundedFileSync(filePath, 16)).toEqual(expected);
  });

  it('reads a file exactly at the cap', async () => {
    const filePath = writeFile('at-cap.txt', 'x'.repeat(16));
    expect(comparable(await readBoundedFile(filePath, 16))).toEqual({ ok: true, size: 16, content: 'x'.repeat(16) });
    expect(comparable(readBoundedFileSync(filePath, 16))).toEqual({ ok: true, size: 16, content: 'x'.repeat(16) });
  });

  it('refuses a file one byte over the cap with path, size and limit', async () => {
    const filePath = writeFile('over-cap.txt', 'x'.repeat(17));
    const expected = {
      ok: false,
      reason: 'too-large',
      code: 'BOUNDED_FILE_TOO_LARGE',
      path: filePath,
      size: 17,
      limit: 16,
    };
    expect(await readBoundedFile(filePath, 16)).toEqual(expected);
    expect(readBoundedFileSync(filePath, 16)).toEqual(expected);
  });

  it.skipIf(!isLinux)(
    'enforces the cap in flight when the contents outgrow the stat size (/proc reports 0)',
    async () => {
      // /proc files stat as size 0 but yield real content on read: the
      // stat gate alone would pass them, so only the in-flight cap+1 read
      // can refuse. This is the grows-after-stat case in its portable form.
      const filePath = '/proc/self/status';
      const stat = fs.statSync(filePath);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBe(0);
      const asyncResult = await readBoundedFile(filePath, 16);
      expect(asyncResult).toMatchObject({ ok: false, reason: 'too-large', code: 'BOUNDED_FILE_TOO_LARGE', limit: 16 });
      expect(readBoundedFileSync(filePath, 16)).toMatchObject({ ok: false, reason: 'too-large', limit: 16 });
      // …and the same file reads whole under a cap that fits its content.
      expect((await readBoundedFile(filePath, 1024 * 1024)).ok).toBe(true);
    },
  );

  it.skipIf(isWindows)('refuses a FIFO as non-regular without blocking on open', async () => {
    const fifoPath = path.join(dir, 'queue.fifo');
    execFileSync('mkfifo', [fifoPath]);
    const expected = { ok: false, reason: 'not-regular', code: 'BOUNDED_FILE_NOT_REGULAR', path: fifoPath };
    expect(await readBoundedFile(fifoPath, 16)).toEqual(expected);
    expect(readBoundedFileSync(fifoPath, 16)).toEqual(expected);
  });

  it.skipIf(isWindows)('refuses a symlink to a device as non-regular', async () => {
    const linkPath = path.join(dir, 'device-link');
    fs.symlinkSync('/dev/null', linkPath);
    const expected = { ok: false, reason: 'not-regular', code: 'BOUNDED_FILE_NOT_REGULAR', path: linkPath };
    expect(await readBoundedFile(linkPath, 16)).toEqual(expected);
    expect(readBoundedFileSync(linkPath, 16)).toEqual(expected);
  });

  it.skipIf(isWindows)('refuses a directory as non-regular', async () => {
    const expected = { ok: false, reason: 'not-regular', code: 'BOUNDED_FILE_NOT_REGULAR', path: dir };
    expect(await readBoundedFile(dir, 16)).toEqual(expected);
    expect(readBoundedFileSync(dir, 16)).toEqual(expected);
  });

  it('reads through a symlink to a regular file', async () => {
    const target = writeFile('target.txt', 'linked');
    const linkPath = path.join(dir, 'file-link');
    fs.symlinkSync(target, linkPath);
    expect(comparable(await readBoundedFile(linkPath, 16))).toEqual({ ok: true, size: 6, content: 'linked' });
    expect(comparable(readBoundedFileSync(linkPath, 16))).toEqual({ ok: true, size: 6, content: 'linked' });
  });

  it.skipIf(isWindows)('with noFollow, refuses a symlink at open (ELOOP) in both spellings', async () => {
    const target = writeFile('nofollow-target.txt', 'linked');
    const linkPath = path.join(dir, 'nofollow-link');
    fs.symlinkSync(target, linkPath);
    await expect(readBoundedFile(linkPath, 16, { noFollow: true })).rejects.toMatchObject({ code: 'ELOOP' });
    expect(() => readBoundedFileSync(linkPath, 16, { noFollow: true })).toThrow(expect.objectContaining({ code: 'ELOOP' }));
    // The same path without the option still reads through, as before.
    expect(comparable(await readBoundedFile(linkPath, 16))).toEqual({ ok: true, size: 6, content: 'linked' });
  });

  it('rejects an invalid cap in both spellings', async () => {
    const filePath = writeFile('any.txt', 'data');
    await expect(readBoundedFile(filePath, -1)).rejects.toThrow(RangeError);
    await expect(readBoundedFile(filePath, 1.5)).rejects.toThrow(RangeError);
    expect(() => readBoundedFileSync(filePath, -1)).toThrow(RangeError);
    expect(() => readBoundedFileSync(filePath, Number.NaN)).toThrow(RangeError);
  });

  it('the two spellings agree across the whole matrix', async () => {
    const cases = [
      path.join(dir, 'absent.txt'),
      writeFile('matrix-small.txt', 'abc'),
      writeFile('matrix-at-cap.txt', 'y'.repeat(8)),
      writeFile('matrix-over-cap.txt', 'y'.repeat(9)),
    ];
    if (!isWindows) cases.push(dir);
    for (const filePath of cases) {
      expect(comparable(readBoundedFileSync(filePath, 8))).toEqual(comparable(await readBoundedFile(filePath, 8)));
    }
  });
});
