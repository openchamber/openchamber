import { after, before, describe, it, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isTransientWindowsRenameError,
  removeStaleSiblingTmpFiles,
  renameWithRetry,
  writeJsonFile,
  WRITE_JSON_RENAME_RETRY_DELAYS_MS,
} from './write-json-file.mjs';

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-write-json-'));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('isTransientWindowsRenameError', () => {
  it('matches EPERM, EBUSY, EACCES on Windows and never on other platforms', () => {
    if (process.platform !== 'win32') {
      assert.equal(isTransientWindowsRenameError({ code: 'EPERM' }), false);
      assert.equal(isTransientWindowsRenameError({ code: 'EBUSY' }), false);
      assert.equal(isTransientWindowsRenameError({ code: 'EACCES' }), false);
      return;
    }
    assert.equal(isTransientWindowsRenameError({ code: 'EPERM' }), true);
    assert.equal(isTransientWindowsRenameError({ code: 'EBUSY' }), true);
    assert.equal(isTransientWindowsRenameError({ code: 'EACCES' }), true);
    assert.equal(isTransientWindowsRenameError({ code: 'ENOENT' }), false);
    assert.equal(isTransientWindowsRenameError({ code: 'EISDIR' }), false);
    assert.equal(isTransientWindowsRenameError(null), false);
  });
});

describe('removeStaleSiblingTmpFiles', () => {
  it('unlinks only siblings that match the <name>.tmp- prefix', async () => {
    const dir = createTempDir();
    const target = path.join(dir, 'settings.json');
    const keep = path.join(dir, 'keep.json');
    fs.writeFileSync(target, '{}');
    fs.writeFileSync(keep, '{}');

    const stale1 = path.join(dir, 'settings.json.tmp-1-deadbeef');
    const stale2 = path.join(dir, 'settings.json.tmp-2-cafebabe');
    const unrelated = path.join(dir, 'other.json.tmp-should-stay');
    fs.writeFileSync(stale1, 'x');
    fs.writeFileSync(stale2, 'x');
    fs.writeFileSync(unrelated, 'x');

    await removeStaleSiblingTmpFiles(target);

    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(keep), true);
    assert.equal(fs.existsSync(stale1), false);
    assert.equal(fs.existsSync(stale2), false);
    assert.equal(fs.existsSync(unrelated), true);
  });

  it('survives a missing target directory without throwing', async () => {
    const dir = createTempDir();
    const target = path.join(dir, 'does-not-exist.json');

    await removeStaleSiblingTmpFiles(target);
  });
});

describe('renameWithRetry', () => {
  it('retries on transient errors and eventually succeeds', async () => {
    const dir = createTempDir();
    const target = path.join(dir, 'settings.json');
    const tmp = path.join(dir, 'settings.json.tmp');
    fs.writeFileSync(tmp, '{}');

    let attempts = 0;
    const originalRename = fsp.rename;
    const restore = mock.method(fsp, 'rename', async function patchedRename(from, to) {
      attempts += 1;
      if (attempts <= 2) {
        const error = new Error(`EPERM: ${from} -> ${to}`);
        error.code = 'EPERM';
        throw error;
      }
      return originalRename.call(this, from, to);
    });

    try {
      await renameWithRetry(tmp, target, {
        delays: [1, 1, 1],
        isTransient: (e) => e?.code === 'EPERM',
      });
      assert.equal(attempts, 3);
      assert.equal(fs.existsSync(target), true);
    } finally {
      restore.mock.restore();
    }
  });

  it('throws immediately on non-transient errors', async () => {
    const dir = createTempDir();
    const target = path.join(dir, 'settings.json');
    const tmp = path.join(dir, 'settings.json.tmp');
    fs.writeFileSync(tmp, '{}');

    let calls = 0;
    const restore = mock.method(fsp, 'rename', async function patchedRename() {
      calls += 1;
      const error = new Error('ENOENT: file missing');
      error.code = 'ENOENT';
      throw error;
    });

    try {
      await assert.rejects(
        () =>
          renameWithRetry(tmp, target, {
            delays: [1, 1, 1],
            isTransient: (e) => e?.code === 'EPERM',
          }),
        (err) => err.code === 'ENOENT',
      );
      assert.equal(calls, 1);
    } finally {
      restore.mock.restore();
    }
  });

  it('throws after exhausting retries', async () => {
    const dir = createTempDir();
    const target = path.join(dir, 'settings.json');
    const tmp = path.join(dir, 'settings.json.tmp');
    fs.writeFileSync(tmp, '{}');

    let attempts = 0;
    const restore = mock.method(fsp, 'rename', async function patchedRename() {
      attempts += 1;
      const error = new Error(`EPERM attempt ${attempts}`);
      error.code = 'EPERM';
      throw error;
    });

    try {
      await assert.rejects(
        () =>
          renameWithRetry(tmp, target, {
            delays: [1, 1],
            isTransient: (e) => e?.code === 'EPERM',
          }),
        (err) => err.code === 'EPERM',
      );
      assert.equal(attempts, 3);
    } finally {
      restore.mock.restore();
    }
  });
});

describe('writeJsonFile', () => {
  it('writes JSON atomically and leaves the target readable', async () => {
    const dir = createTempDir();
    const target = path.join(dir, 'settings.json');

    await writeJsonFile(target, { hello: 'world' });

    const contents = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(contents, { hello: 'world' });
    const siblings = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.tmp-'));
    assert.deepEqual(siblings, []);
  });

  it('keeps retry behaviour platform-aware', () => {
    if (process.platform === 'win32') {
      assert.ok(WRITE_JSON_RENAME_RETRY_DELAYS_MS.length > 0);
    } else {
      assert.deepEqual(WRITE_JSON_RENAME_RETRY_DELAYS_MS, []);
    }
  });
});
