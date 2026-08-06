import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from '../../guardian/windows-acl.js';
import {
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  resolveManagedOpenCodeHandoffV2Root,
  __test__,
} from './filesystem.js';

let tmpDirs = [];
let aclSpy;

beforeEach(() => {
  // The Windows path shells out to `icacls`; on Linux CI we must
  // stub it. The factory in `ensurePrivateDirectory` captured the
  // function reference at module load; the spy replaces it on the
  // namespace export.
  aclSpy = vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

const mkTmp = (label = 'filesystem') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openchamber-v2-fs-${label}-`));
  tmpDirs.push(dir);
  return dir;
};

const safeAncestorAcl = () => ({ entries: [{ principal: 'alice', rights: ['F'] }] });

describe('ensurePrivateDirectory (POSIX, regression)', () => {
  it.skipIf(process.platform === 'win32')('creates a 0700 root under the supplied rootDir', () => {
    const tmp = mkTmp();
    const root = path.join(tmp, 'v2-root');
    const resolved = ensurePrivateDirectory(root, { platform: 'linux' });
    expect(resolved).toBe(root);
    const stat = fs.lstatSync(root);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('is idempotent on an already-existing 0700 root', () => {
    const tmp = mkTmp();
    const root = path.join(tmp, 'v2-root');
    fs.mkdirSync(root, { mode: 0o700 });
    expect(() => ensurePrivateDirectory(root, { platform: 'linux' })).not.toThrow();
    const stat = fs.lstatSync(root);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('rejects an unsafe existing root (wrong mode)', () => {
    const tmp = mkTmp();
    const root = path.join(tmp, 'v2-root');
    fs.mkdirSync(root, { mode: 0o755 });
    expect(() => ensurePrivateDirectory(root, { platform: 'linux' })).toThrow(/unsafe permissions/);
  });

  it.skipIf(process.platform === 'win32')('does not call applyDirectoryAcl on Linux (preserves the v1 contract)', () => {
    const tmp = mkTmp();
    const root = path.join(tmp, 'v2-root');
    ensurePrivateDirectory(root, { platform: 'linux' });
    expect(aclSpy).not.toHaveBeenCalled();
  });
});

describe('ensurePrivateDirectory (Windows / W-B)', () => {
  it('dispatches to the Windows path and applies a per-user ACL', () => {
    const tmp = mkTmp('win32');
    const root = path.join(tmp, 'v2-root');
    const resolved = ensurePrivateDirectory(root, {
      platform: 'win32', username: 'alice', aclInspector: safeAncestorAcl,
    });
    expect(resolved).toBe(root);
    // The directory was created.
    expect(fs.existsSync(root)).toBe(true);
    const stat = fs.lstatSync(root);
    expect(stat.isDirectory()).toBe(true);
    // The Windows ACL was applied.
    expect(aclSpy).toHaveBeenCalledTimes(1);
    const aclArgs = aclSpy.mock.calls[0][0];
    expect(aclArgs.dirPath).toBe(root);
    expect(aclArgs.username).toBe('alice');
  });

  it('is idempotent: a second call does not fail when the root already exists', () => {
    const tmp = mkTmp('win32-idempotent');
    const root = path.join(tmp, 'v2-root');
    ensurePrivateDirectory(root, {
      platform: 'win32', username: 'alice', aclInspector: safeAncestorAcl,
    });
    expect(() => ensurePrivateDirectory(root, {
      platform: 'win32', username: 'alice', aclInspector: safeAncestorAcl,
    })).not.toThrow();
    // ACL is re-applied on each call. The function is documented as
    // idempotent; re-applying the same grant is harmless on Windows.
    expect(aclSpy).toHaveBeenCalledTimes(2);
  });

  it('creates the parent directory if missing', () => {
    const tmp = mkTmp('win32-parent');
    const root = path.join(tmp, 'a', 'b', 'v2-root');
    expect(() => ensurePrivateDirectory(root, {
      platform: 'win32', username: 'alice', aclInspector: safeAncestorAcl,
    })).not.toThrow();
    expect(fs.existsSync(root)).toBe(true);
  });

  it('propagates icacls failure', () => {
    aclSpy.mockImplementation(() => {
      throw new Error('icacls failed: access denied');
    });
    const tmp = mkTmp('win32-acl-fail');
    const root = path.join(tmp, 'v2-root');
    expect(() => ensurePrivateDirectory(root, {
      platform: 'win32', username: 'alice', aclInspector: safeAncestorAcl,
    }))
      .toThrow(/icacls failed: access denied/);
  });

  it('rejects an existing Windows root reported as a reparse point', () => {
    const tmp = mkTmp('win32-reparse');
    const root = path.join(tmp, 'v2-root');
    fs.mkdirSync(root, { recursive: true });
    expect(() => ensurePrivateDirectory(root, {
      platform: 'win32',
      username: 'alice',
      aclInspector: safeAncestorAcl,
      reparseChecker: () => true,
    })).toThrow(/reparse point/);
  });

  it('rejects a reparse-point ancestor before creating a nested Windows root', () => {
    const tmp = mkTmp('win32-ancestor-reparse');
    const unsafeParent = path.join(tmp, 'unsafe-parent');
    const root = path.join(unsafeParent, 'nested', 'v2-root');
    fs.mkdirSync(unsafeParent);

    expect(() => ensurePrivateDirectory(root, {
      platform: 'win32',
      username: 'alice',
      aclInspector: safeAncestorAcl,
      reparseChecker: (candidate) => candidate === unsafeParent,
    })).toThrow(/ancestor.*reparse point/);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('accepts a valid nested Windows root after walking existing ancestors', () => {
    const tmp = mkTmp('win32-valid-ancestors');
    const root = path.join(tmp, 'a', 'b', 'v2-root');
    expect(() => ensurePrivateDirectory(root, {
      platform: 'win32',
      username: 'alice',
      aclInspector: safeAncestorAcl,
      reparseChecker: () => false,
    })).not.toThrow();
    expect(fs.existsSync(root)).toBe(true);
  });

  it('rejects an attacker-writable existing Windows ancestor', () => {
    const tmp = mkTmp('win32-ancestor-acl');
    const unsafeParent = path.join(tmp, 'unsafe-parent');
    const root = path.join(unsafeParent, 'nested', 'v2-root');
    fs.mkdirSync(unsafeParent);

    expect(() => ensurePrivateDirectory(root, {
      platform: 'win32',
      username: 'alice',
      aclInspector: (target) => target.targetPath === unsafeParent
        ? { entries: [{ principal: 'Everyone', rights: ['M'] }] }
        : { entries: [{ principal: 'alice', rights: ['F'] }] },
    })).toThrow(/ancestor ACL grants write access/);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('rejects a reparse-point ancestor for an existing private file', () => {
    const tmp = mkTmp('win32-file-ancestor-reparse');
    const unsafeParent = path.join(tmp, 'unsafe-parent');
    const filePath = path.join(unsafeParent, 'secret.bin');
    fs.mkdirSync(unsafeParent);
    fs.writeFileSync(filePath, 'secret');

    expect(() => assertPrivateRegularFile(filePath, 0o600, {
      platform: 'win32',
      username: 'alice',
      aclInspector: () => ({ entries: [{ principal: 'alice', rights: ['F'] }] }),
      reparseChecker: (candidate) => candidate === unsafeParent,
    })).toThrow(/ancestor.*reparse point/);
  });

  it('rejects a relative path', () => {
    expect(() => ensurePrivateDirectory('relative/path', {
      platform: 'win32', username: 'alice', aclInspector: safeAncestorAcl,
    }))
      .toThrow(/absolute path/);
  });

  it('rejects a filesystem root', () => {
    expect(() => ensurePrivateDirectory(path.parse(os.tmpdir()).root, {
      platform: 'win32', username: 'alice', aclInspector: safeAncestorAcl,
    }))
      .toThrow(/must not be a filesystem root/);
  });

  it('does not use POSIX directory fsync on the Windows branch', () => {
    const tmp = mkTmp('win32-fsync');
    const openSpy = vi.spyOn(fs, 'openSync');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');

    fsyncDirectory(tmp, { platform: 'win32' });

    expect(openSpy).not.toHaveBeenCalled();
    expect(fsyncSpy).not.toHaveBeenCalled();
  });
});

describe('ensurePrivateDirectoryWindows (internal, exposed for tests)', () => {
  it('is the dispatcher target on win32', () => {
    const tmp = mkTmp('internal');
    const root = path.join(tmp, 'v2-root');
    expect(() => __test__.ensurePrivateDirectoryWindows(root, {
      username: 'alice', aclInspector: safeAncestorAcl,
    })).not.toThrow();
    expect(aclSpy).toHaveBeenCalledTimes(1);
  });
});

describe('resolveManagedOpenCodeHandoffV2Root', () => {
  it('returns the supplied absolute path', () => {
    const tmp = mkTmp('resolve');
    const root = path.join(tmp, 'v2-root');
    expect(resolveManagedOpenCodeHandoffV2Root(root)).toBe(root);
  });

  it('rejects relative paths', () => {
    expect(() => resolveManagedOpenCodeHandoffV2Root('relative/path')).toThrow(/absolute path/);
  });
});
