import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { execFileSync } from 'node:child_process';

import {
  DEFAULT_DURABLE_JSON_MAX_BYTES,
  isJsonObject,
  preserveMalformedJsonFile,
  preserveMalformedJsonFileSync,
  readDurableJsonFile,
  readDurableJsonFileSync,
  writeDurableJsonFile,
  writeDurableJsonFileSync,
} from './durable-json-store.js';

const fsSyncAll = fs;

const tempDirs = [];
const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-json-store-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const readCases = [
  { name: 'a missing file', contents: null, options: {}, state: 'missing' },
  { name: 'an empty file', contents: '', options: {}, state: 'missing' },
  { name: 'a whitespace-only file', contents: '  \n', options: {}, state: 'missing' },
  { name: 'a valid object', contents: '{"a":1}', options: {}, state: 'valid', value: { a: 1 } },
  { name: 'a valid array without a value judgement', contents: '[1,2]', options: {}, state: 'valid', value: [1, 2] },
  { name: 'unparseable bytes', contents: '{nope', options: {}, state: 'malformed' },
  { name: 'an array for an object-shaped store', contents: '[1,2]', options: { validateValue: isJsonObject }, state: 'malformed' },
  { name: 'a scalar for an object-shaped store', contents: '42', options: { validateValue: isJsonObject }, state: 'malformed' },
  { name: 'null for an object-shaped store', contents: 'null', options: { validateValue: isJsonObject }, state: 'malformed' },
  { name: 'an object for an object-shaped store', contents: '{"a":1}', options: { validateValue: isJsonObject }, state: 'valid', value: { a: 1 } },
  {
    name: 'a value the caller predicate rejects',
    contents: '{"version":1}',
    options: { validateValue: (value) => value.version === 2 },
    state: 'malformed',
  },
];

describe('readDurableJsonFile / readDurableJsonFileSync (identical answers)', () => {
  for (const testCase of readCases) {
    it(`answers ${testCase.state} for ${testCase.name}`, async () => {
      const dir = makeTempDir();
      const filePath = path.join(dir, 'store.json');
      if (testCase.contents !== null) fs.writeFileSync(filePath, testCase.contents);

      const asyncResult = await readDurableJsonFile(filePath, testCase.options);
      const syncResult = readDurableJsonFileSync(filePath, testCase.options);

      expect(asyncResult.state).toBe(testCase.state);
      expect(syncResult.state).toBe(testCase.state);
      if (testCase.state === 'valid') {
        expect(asyncResult.value).toEqual(testCase.value);
        expect(syncResult.value).toEqual(testCase.value);
      }
      // A malformed answer never carries the parse error: it can quote
      // the file, and these files hold credentials and user data.
      if (testCase.state === 'malformed') {
        expect(asyncResult.error).toBeUndefined();
        expect(syncResult.error).toBeUndefined();
      }
    });
  }

  it('throws on a read failure other than absence, in both spellings', async () => {
    const dir = makeTempDir();
    const denied = new Error('permission denied');
    denied.code = 'EACCES';
    const asyncFs = {
      readFile: async () => {
        throw denied;
      },
    };
    const syncFs = {
      readFileSync: () => {
        throw denied;
      },
    };
    await expect(readDurableJsonFile(path.join(dir, 'store.json'), { fs: asyncFs })).rejects.toMatchObject({ code: 'EACCES' });
    expect(() => readDurableJsonFileSync(path.join(dir, 'store.json'), { fs: syncFs })).toThrowError(
      expect.objectContaining({ code: 'EACCES' }),
    );
  });
});

describe('preserveMalformedJsonFile / preserveMalformedJsonFileSync', () => {
  it('preserves a malformed file under the collision-proof name, bytes intact', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{torn');

    const asyncResult = await preserveMalformedJsonFile(filePath);
    expect(asyncResult).toMatchObject({ preserved: true, outcome: 'preserved' });
    expect(asyncResult.preservedPath).toMatch(/\.corrupt-\d+-\d+-[a-z0-9]+$/);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readFileSync(asyncResult.preservedPath, 'utf8')).toBe('{torn');

    fs.writeFileSync(filePath, '{torn again');
    const syncResult = preserveMalformedJsonFileSync(filePath);
    expect(syncResult).toMatchObject({ preserved: true, outcome: 'preserved' });
    expect(fs.readFileSync(syncResult.preservedPath, 'utf8')).toBe('{torn again');
  });

  it('keeps two preservations in the same millisecond both alive', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');

    fs.writeFileSync(filePath, '{first');
    const first = await preserveMalformedJsonFile(filePath);
    fs.writeFileSync(filePath, '{second');
    const second = preserveMalformedJsonFileSync(filePath);

    expect(first.preserved).toBe(true);
    expect(second.preserved).toBe(true);
    expect(first.preservedPath).not.toBe(second.preservedPath);
    expect(fs.readFileSync(first.preservedPath, 'utf8')).toBe('{first');
    expect(fs.readFileSync(second.preservedPath, 'utf8')).toBe('{second');
  });

  it('answers the fail-closed result when the rename fails, and leaves the file in place', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{torn');
    const failingAsyncFs = {
      readFile: (target, encoding) => fs.promises.readFile(target, encoding),
      access: (target) => fs.promises.access(target),
      rename: async () => {
        throw new Error('rename refused');
      },
    };
    const failingSyncFs = {
      readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
      existsSync: (target) => fs.existsSync(target),
      renameSync: () => {
        throw new Error('rename refused');
      },
    };

    await expect(preserveMalformedJsonFile(filePath, { fs: failingAsyncFs })).resolves.toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(preserveMalformedJsonFileSync(filePath, { fs: failingSyncFs })).toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{torn');
  });

  it('never renames away a valid replacement that landed after the judgement', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{torn');
    const judged = await readDurableJsonFile(filePath, { validateValue: isJsonObject });
    expect(judged.state).toBe('malformed');

    // A concurrent writer replaces the torn bytes with valid state
    // before the preserve step runs.
    fs.writeFileSync(filePath, '{"fresh":true}');

    await expect(preserveMalformedJsonFile(filePath, { validateValue: isJsonObject })).resolves.toEqual({
      preserved: false,
      outcome: 'replaced',
    });
    expect(preserveMalformedJsonFileSync(filePath, { validateValue: isJsonObject })).toEqual({
      preserved: false,
      outcome: 'replaced',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"fresh":true}');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  });

  it('never renames away a valid replacement installed during the preserve-name check (Codex P2, PR #981)', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{torn');
    // The Codex reproduction: a concurrent writer installs valid JSON
    // while the helper awaits fs.access on the preserve candidate —
    // after its first re-read, before its rename.
    const racingAsyncFs = {
      readFile: (target, encoding) => fs.promises.readFile(target, encoding),
      access: async (target) => {
        fs.writeFileSync(filePath, '{"fresh":true}');
        return fs.promises.access(target);
      },
      rename: (from, to) => fs.promises.rename(from, to),
      link: (from, to) => fs.promises.link(from, to),
      unlink: (target) => fs.promises.unlink(target),
    };
    await expect(
      preserveMalformedJsonFile(filePath, { validateValue: isJsonObject, fs: racingAsyncFs }),
    ).resolves.toEqual({ preserved: false, outcome: 'replaced' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"fresh":true}');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);

    // Sync spelling: the candidate check is existsSync.
    fs.writeFileSync(filePath, '{torn');
    let checked = false;
    const racingSyncFs = {
      readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
      existsSync: (target) => {
        if (!checked) {
          checked = true;
          fs.writeFileSync(filePath, '{"fresh":true}');
        }
        return fs.existsSync(target);
      },
      renameSync: (from, to) => fs.renameSync(from, to),
      linkSync: (from, to) => fs.linkSync(from, to),
      unlinkSync: (target) => fs.unlinkSync(target),
    };
    expect(preserveMalformedJsonFileSync(filePath, { validateValue: isJsonObject, fs: racingSyncFs })).toEqual({
      preserved: false,
      outcome: 'replaced',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"fresh":true}');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  });

  it('restores a valid replacement that lands between the final re-read and the rename', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{torn');
    const racingAsyncFs = {
      readFile: (target, encoding) => fs.promises.readFile(target, encoding),
      access: (target) => fs.promises.access(target),
      rename: async (from, to) => {
        fs.writeFileSync(from, '{"fresh":true}');
        return fs.promises.rename(from, to);
      },
      link: (from, to) => fs.promises.link(from, to),
      unlink: (target) => fs.promises.unlink(target),
    };
    await expect(
      preserveMalformedJsonFile(filePath, { validateValue: isJsonObject, fs: racingAsyncFs }),
    ).resolves.toEqual({ preserved: false, outcome: 'replaced' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"fresh":true}');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);

    fs.writeFileSync(filePath, '{torn');
    const racingSyncFs = {
      readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
      existsSync: (target) => fs.existsSync(target),
      renameSync: (from, to) => {
        fs.writeFileSync(from, '{"fresh":true}');
        fs.renameSync(from, to);
      },
      linkSync: (from, to) => fs.linkSync(from, to),
      unlinkSync: (target) => fs.unlinkSync(target),
    };
    expect(preserveMalformedJsonFileSync(filePath, { validateValue: isJsonObject, fs: racingSyncFs })).toEqual({
      preserved: false,
      outcome: 'replaced',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"fresh":true}');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  });

  it('fails closed when no atomic no-clobber restoration is available (Codex P2, PR #981 round 2)', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{torn');
    // Same race as the restore test above - the rename moves valid
    // bytes - but the injected fs omits link/linkSync, so there is no
    // atomic no-clobber way to put them back. The old fallback checked
    // the live path was absent and then renamed over it, which could
    // silently replace a newer concurrent file installed in between.
    // The answer must be 'failed', never an overwriting rename, and
    // the valid bytes stay intact under the preserve name.
    const noLinkAsyncFs = {
      readFile: (target, encoding) => fs.promises.readFile(target, encoding),
      access: (target) => fs.promises.access(target),
      rename: async (from, to) => {
        fs.writeFileSync(from, '{"fresh":true}');
        return fs.promises.rename(from, to);
      },
    };
    await expect(
      preserveMalformedJsonFile(filePath, { validateValue: isJsonObject, fs: noLinkAsyncFs }),
    ).resolves.toEqual({ preserved: false, outcome: 'failed' });
    expect(fs.existsSync(filePath)).toBe(false);
    const asyncPreserved = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(asyncPreserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, asyncPreserved[0]), 'utf8')).toBe('{"fresh":true}');

    fs.writeFileSync(filePath, '{torn');
    const noLinkSyncFs = {
      readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
      existsSync: (target) => fs.existsSync(target),
      renameSync: (from, to) => {
        fs.writeFileSync(from, '{"fresh":true}');
        fs.renameSync(from, to);
      },
    };
    expect(preserveMalformedJsonFileSync(filePath, { validateValue: isJsonObject, fs: noLinkSyncFs })).toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(fs.existsSync(filePath)).toBe(false);
    const syncPreserved = fs
      .readdirSync(dir)
      .filter((name) => name.includes('.corrupt-') && name !== asyncPreserved[0]);
    expect(syncPreserved).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, syncPreserved[0]), 'utf8')).toBe('{"fresh":true}');
  });

  it('answers the fail-closed result when the caller value judgement throws (CodeRabbit, PR #981)', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{"a":1}');
    const throwing = () => {
      throw new Error('predicate exploded');
    };
    await expect(preserveMalformedJsonFile(filePath, { validateValue: throwing })).resolves.toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(preserveMalformedJsonFileSync(filePath, { validateValue: throwing })).toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"a":1}');
  });

  it('answers missing for an absent file in both spellings', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    await expect(preserveMalformedJsonFile(filePath)).resolves.toEqual({ preserved: false, outcome: 'missing' });
    expect(preserveMalformedJsonFileSync(filePath)).toEqual({ preserved: false, outcome: 'missing' });
  });
});

describe('writeDurableJsonFile / writeDurableJsonFileSync', () => {
  it('writes the contents with the stated mode present on the file', async () => {
    const dir = makeTempDir();
    const asyncPath = path.join(dir, 'async.json');
    await writeDurableJsonFile(asyncPath, '{"a":1}', { mode: 0o600 });
    expect(fs.readFileSync(asyncPath, 'utf8')).toBe('{"a":1}');
    // Windows reports writable files as 0o666 regardless of the mode
    // passed to writeFile (CodeRabbit review, PR #981); the stated-mode
    // assertions are POSIX-only, the contents assertions are not.
    if (process.platform !== 'win32') {
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(asyncPath).mode & 0o777).toBe(0o600);
    }

    const syncPath = path.join(dir, 'sync.json');
    writeDurableJsonFileSync(syncPath, '{"b":2}', { mode: 0o644 });
    expect(fs.readFileSync(syncPath, 'utf8')).toBe('{"b":2}');
    if (process.platform !== 'win32') {
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(syncPath).mode & 0o777).toBe(0o644);
    }

    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('replaces an existing file atomically in both spellings', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{"old":true}');
    await writeDurableJsonFile(filePath, '{"new":true}', { mode: 0o600 });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"new":true}');
    writeDurableJsonFileSync(filePath, '{"newer":true}', { mode: 0o600 });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"newer":true}');
  });

  it('creates the parent directory when it does not exist yet', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'nested', 'store.json');
    await writeDurableJsonFile(filePath, '{}', { mode: 0o600 });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{}');
  });

  it('refuses a write with no stated mode, in both spellings', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    await expect(writeDurableJsonFile(filePath, '{}')).rejects.toThrowError(TypeError);
    expect(() => writeDurableJsonFileSync(filePath, '{}')).toThrowError(TypeError);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('removes its temp file and surfaces the error when the rename fails', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    const failingAsyncFs = {
      mkdir: (target, options) => fs.promises.mkdir(target, options),
      writeFile: (target, contents, options) => fs.promises.writeFile(target, contents, options),
      rename: async () => {
        throw new Error('rename refused');
      },
      rm: (target, options) => fs.promises.rm(target, options),
    };
    await expect(writeDurableJsonFile(filePath, '{}', { mode: 0o600, fs: failingAsyncFs })).rejects.toThrowError(
      'rename refused',
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('bounded reads (#1649)', () => {
  it('exports a stated default cap', () => {
    expect(DEFAULT_DURABLE_JSON_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it('reads a valid file at exactly the cap, in both spellings', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    const contents = '{"a":"12345678"}';
    fs.writeFileSync(filePath, contents);
    const maxBytes = Buffer.byteLength(contents, 'utf8');
    await expect(readDurableJsonFile(filePath, { maxBytes })).resolves.toMatchObject({ state: 'valid' });
    expect(readDurableJsonFileSync(filePath, { maxBytes }).state).toBe('valid');
  });

  it('readers throw (never malformed) on an over-cap file, in both spellings', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    fs.writeFileSync(filePath, '{"a":"much longer than the cap"}');
    await expect(readDurableJsonFile(filePath, { maxBytes: 8 })).rejects.toMatchObject({
      code: 'DURABLE_JSON_STORE_TOO_LARGE',
    });
    expect(() => readDurableJsonFileSync(filePath, { maxBytes: 8 })).toThrowError(
      expect.objectContaining({ code: 'DURABLE_JSON_STORE_TOO_LARGE' }),
    );
  });

  it('preserve answers failed (never preserved/malformed) on an over-cap file, async and sync', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    const contents = '{torn and much longer than the cap';
    fs.writeFileSync(filePath, contents);
    await expect(preserveMalformedJsonFile(filePath, { maxBytes: 8 })).resolves.toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(preserveMalformedJsonFileSync(filePath, { maxBytes: 8 })).toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(fs.readFileSync(filePath, 'utf8')).toBe(contents);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  });

  // Oracle (#1772): the cap invariant is in-flight, not just at the stat -
  // no read in this module buffers more than maxBytes + 1 bytes, whatever
  // the stat said. These tests make the stat and the read disagree (the
  // file grows after its stat) and pin the chunked half of the gate: a
  // whole-file read here would pass every other test in this describe.
  it('refuses a file that grows after its stat, in flight, async spelling', async () => {
    const maxBytes = 64;
    const payload = Buffer.from(`{"a":"${'x'.repeat(200)}"}`, 'utf8');
    let delivered = 0;
    const handle = {
      stat: async () => ({ isFile: () => true, size: 10 }),
      read: async (buffer, offset, length, position) => {
        const n = Math.max(0, Math.min(length, payload.length - position));
        payload.copy(buffer, offset, position, position + n);
        delivered += n;
        return { bytesRead: n, buffer };
      },
      close: async () => {},
    };
    const fs = { ...fsPromises, open: async () => handle };
    await expect(readDurableJsonFile('/virtual/store.json', { maxBytes, fs })).rejects.toMatchObject({
      code: 'DURABLE_JSON_STORE_TOO_LARGE',
    });
    expect(delivered).toBeLessThanOrEqual(maxBytes + 1);
    expect(delivered).toBe(maxBytes + 1);
  });

  it('refuses a file that grows after its stat, in flight, sync spelling', () => {
    const maxBytes = 64;
    const payload = Buffer.from(`{"a":"${'x'.repeat(200)}"}`, 'utf8');
    let delivered = 0;
    const fs = {
      ...fsSyncAll,
      openSync: () => 4242,
      fstatSync: () => ({ isFile: () => true, size: 10 }),
      readSync: (fd, buffer, offset, length, position) => {
        const n = Math.max(0, Math.min(length, payload.length - position));
        payload.copy(buffer, offset, position, position + n);
        delivered += n;
        return n;
      },
      closeSync: () => {},
    };
    expect(() => readDurableJsonFileSync('/virtual/store.json', { maxBytes, fs })).toThrowError(
      expect.objectContaining({ code: 'DURABLE_JSON_STORE_TOO_LARGE' }),
    );
    expect(delivered).toBe(maxBytes + 1);
  });

  it('refuses a FIFO promptly instead of blocking, in both spellings and the preserve path', async () => {
    if (process.platform === 'win32') return;
    const dir = makeTempDir();
    const filePath = path.join(dir, 'store.json');
    execFileSync('mkfifo', [filePath]);
    await expect(readDurableJsonFile(filePath, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'DURABLE_JSON_STORE_NOT_REGULAR',
    });
    expect(() => readDurableJsonFileSync(filePath, { maxBytes: 1024 })).toThrowError(
      expect.objectContaining({ code: 'DURABLE_JSON_STORE_NOT_REGULAR' }),
    );
    await expect(preserveMalformedJsonFile(filePath, { maxBytes: 1024 })).resolves.toEqual({
      preserved: false,
      outcome: 'failed',
    });
    expect(preserveMalformedJsonFileSync(filePath, { maxBytes: 1024 })).toEqual({
      preserved: false,
      outcome: 'failed',
    });
  });
});
