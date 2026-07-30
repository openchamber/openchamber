import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from '../../guardian/windows-acl.js';
import {
  ensurePrivateDirectory,
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
    const resolved = ensurePrivateDirectory(root, { platform: 'win32', username: 'alice' });
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
    ensurePrivateDirectory(root, { platform: 'win32', username: 'alice' });
    expect(() => ensurePrivateDirectory(root, { platform: 'win32', username: 'alice' })).not.toThrow();
    // ACL is re-applied on each call. The function is documented as
    // idempotent; re-applying the same grant is harmless on Windows.
    expect(aclSpy).toHaveBeenCalledTimes(2);
  });

  it('creates the parent directory if missing', () => {
    const tmp = mkTmp('win32-parent');
    const root = path.join(tmp, 'a', 'b', 'v2-root');
    expect(() => ensurePrivateDirectory(root, { platform: 'win32', username: 'alice' })).not.toThrow();
    expect(fs.existsSync(root)).toBe(true);
  });

  it('propagates icacls failure', () => {
    aclSpy.mockImplementation(() => {
      throw new Error('icacls failed: access denied');
    });
    const tmp = mkTmp('win32-acl-fail');
    const root = path.join(tmp, 'v2-root');
    expect(() => ensurePrivateDirectory(root, { platform: 'win32', username: 'alice' }))
      .toThrow(/icacls failed: access denied/);
  });

  it('rejects a relative path', () => {
    expect(() => ensurePrivateDirectory('relative/path', { platform: 'win32', username: 'alice' }))
      .toThrow(/absolute path/);
  });

  it('rejects a filesystem root', () => {
    expect(() => ensurePrivateDirectory(path.parse(os.tmpdir()).root, { platform: 'win32', username: 'alice' }))
      .toThrow(/must not be a filesystem root/);
  });
});

describe('ensurePrivateDirectoryWindows (internal, exposed for tests)', () => {
  it('is the dispatcher target on win32', () => {
    const tmp = mkTmp('internal');
    const root = path.join(tmp, 'v2-root');
    expect(() => __test__.ensurePrivateDirectoryWindows(root, { username: 'alice' })).not.toThrow();
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
