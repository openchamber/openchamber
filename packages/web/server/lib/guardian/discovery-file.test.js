import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from './windows-acl.js';
import {
  readDiscoveryFile,
  removeDiscoveryFile,
  removeFileByIdentity,
  writeDiscoveryFileAtomic,
  __test__,
} from './discovery-file.js';

let tmpFiles = [];
let tmpDirs = [];
let aclSpy;
const aclInspector = () => ({ entries: [{ principal: 'alice', rights: ['F'] }] });

beforeEach(() => {
  aclSpy = vi.spyOn(windowsAcl, 'applyDiscoveryFileAcl').mockReturnValue({ ok: true, username: 'alice' });
});

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpFiles.length > 0) {
    const f = tmpFiles.pop();
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.lock`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.tmp`); } catch { /* ignore */ }
  }
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const mkTmpFile = (label = 'discovery-file') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `openchamber-${label}-`));
  tmpDirs.push(dir);
  const file = path.join(dir, 'port');
  tmpFiles.push(file);
  return file;
};

describe('readDiscoveryFile', () => {
  it('throws a "file not found" error when the portPath does not exist', () => {
    // Use the platform override so the test exercises the read path,
    // not the non-Windows guard.
    const missing = path.join(os.tmpdir(), `openchamber-discovery-missing-${Date.now()}-${Math.random()}.port`);
    expect(() => readDiscoveryFile(missing, {
      platform: 'win32', username: 'alice', aclInspector,
    })).toThrow();
    // The underlying error is ENOENT; assert on the code.
    try {
      readDiscoveryFile(missing, {
        platform: 'win32', username: 'alice', aclInspector,
      });
    } catch (error) {
      expect(error.code).toBe('ENOENT');
    }
  });

  it('parses a well-formed 127.0.0.1:<port> body on win32', () => {
    const file = mkTmpFile();
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    const parsed = readDiscoveryFile(file, { platform: 'win32', username: 'alice', aclInspector });
    expect(parsed).toEqual({ host: '127.0.0.1', port: 4096 });
  });

  it('returns null for a malformed body (test of internal parser)', () => {
    const file = mkTmpFile();
    fs.writeFileSync(file, 'not-a-valid-port-line\n');
    expect(() => readDiscoveryFile(file, {
      platform: 'win32', username: 'alice', aclInspector,
    })).toThrowError(expect.objectContaining({ code: 'GUARDIAN_DISCOVERY_INVALID' }));
  });

  it('rejects a port out of range as invalid discovery state', () => {
    const file = mkTmpFile();
    fs.writeFileSync(file, '127.0.0.1:70000\n');
    expect(() => readDiscoveryFile(file, {
      platform: 'win32', username: 'alice', aclInspector,
    })).toThrowError(expect.objectContaining({ code: 'GUARDIAN_DISCOVERY_INVALID' }));
  });

  it('rejects an oversized discovery body before reading/parsing it', () => {
    const file = mkTmpFile('discovery-oversized');
    fs.writeFileSync(file, 'x'.repeat(__test__.GUARDIAN_DISCOVERY_MAX_BODY_BYTES + 1));
    const readSync = vi.spyOn(fs, 'readSync');

    expect(() => readDiscoveryFile(file, {
      platform: 'win32', username: 'alice', aclInspector,
    })).toThrowError(expect.objectContaining({ code: 'GUARDIAN_DISCOVERY_INVALID' }));
    expect(readSync).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== 'win32')('throws on non-Windows (Windows-only boundary)', () => {
    // Default platform override; on a Linux CI runtime this throws.
    // Gated to non-Windows runners: on Windows CI the function works
    // (process.platform === 'win32' makes the default-arg branch succeed)
    // and the assertion would fail. The other `throws on non-Windows`
    // tests below pass `platform: 'linux'`/`'darwin'` explicitly and
    // are not gated.
    const file = mkTmpFile();
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    expect(() => readDiscoveryFile(file)).toThrow(/Windows-only/);
  });

  it('throws on a non-Windows platform passed explicitly', () => {
    const file = mkTmpFile();
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    expect(() => readDiscoveryFile(file, { platform: 'linux' })).toThrow(/Windows-only/);
    expect(() => readDiscoveryFile(file, { platform: 'darwin' })).toThrow(/Windows-only/);
  });

  it('throws TypeError on empty portPath', () => {
    expect(() => readDiscoveryFile('', { platform: 'win32' })).toThrow(/portPath is required/);
  });

  it('rejects an injected reparse-point discovery path before reading it', () => {
    const file = mkTmpFile('discovery-reparse');
    const target = `${file}.target`;
    fs.writeFileSync(target, '127.0.0.1:4096\n');
    fs.symlinkSync(target, file);
    expect(() => readDiscoveryFile(file, {
      platform: 'win32',
      username: 'alice',
      aclInspector,
    })).toThrow(/reparse point/);
  });

  it('rejects a discovery file with an unsafe existing ACL', () => {
    const file = mkTmpFile('discovery-acl');
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    expect(() => readDiscoveryFile(file, {
      platform: 'win32',
      username: 'alice',
      aclInspector: () => ({
        entries: [
          { principal: 'alice', rights: ['F'] },
          { principal: 'Everyone', rights: ['F'] },
        ],
      }),
    })).toThrow(/unapproved principal/);
  });

  it('fails closed when the discovery path is replaced after the validated handle read', () => {
    const file = mkTmpFile('discovery-read-toctou');
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    const readSync = fs.readSync.bind(fs);
    let replaced = false;
    const readSpy = vi.spyOn(fs, 'readSync').mockImplementation((target, ...args) => {
      const result = readSync(target, ...args);
      if (typeof target === 'number' && !replaced) {
        replaced = true;
        fs.unlinkSync(file);
        fs.writeFileSync(file, '127.0.0.1:4100\n');
      }
      return result;
    });

    try {
      expect(() => readDiscoveryFile(file, {
        platform: 'win32',
        username: 'alice',
        aclInspector,
      })).toThrow(/replaced/);
      expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:4100\n');
    } finally {
      readSpy.mockRestore();
    }
  });

  it('rejects unsafe path characters (defense in depth)', () => {
    expect(() => readDiscoveryFile('/path/with&', { platform: 'win32' })).toThrow(/unsafe characters/);
  });
});

describe('removeDiscoveryFile', () => {
  it('removes an existing file on win32', () => {
    const file = mkTmpFile();
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    expect(fs.existsSync(file)).toBe(true);
    removeDiscoveryFile(file, { platform: 'win32', username: 'alice', aclInspector });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is idempotent on a missing file (ENOENT is swallowed)', () => {
    const missing = path.join(os.tmpdir(), `openchamber-discovery-rm-missing-${Date.now()}-${Math.random()}.port`);
    expect(() => removeDiscoveryFile(missing, {
      platform: 'win32', username: 'alice', aclInspector,
    })).not.toThrow();
  });

  it('can return explicit discovery removal outcomes', () => {
    const file = mkTmpFile('discovery-removal-outcomes');
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    expect(removeDiscoveryFile(file, {
      platform: 'win32',
      username: 'alice',
      aclInspector,
      returnResult: true,
    })).toEqual({ status: 'removed' });
    expect(removeDiscoveryFile(file, {
      platform: 'win32',
      username: 'alice',
      aclInspector,
      returnResult: true,
    })).toEqual({ status: 'absent' });

    fs.writeFileSync(file, '127.0.0.1:4100\n');
    expect(removeDiscoveryFile(file, {
      platform: 'win32',
      username: 'alice',
      expectedPort: 4096,
      aclInspector,
      returnResult: true,
    })).toMatchObject({ status: 'replaced' });
  });

  it.runIf(process.platform !== 'win32')('throws on non-Windows', () => {
    // Default platform override; on a Linux CI runtime this throws.
    // Gated to non-Windows runners for the same reason as the matching
    // `readDiscoveryFile` test above: on Windows CI the default-arg
    // platform is 'win32' so the function would not throw.
    const file = mkTmpFile();
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    expect(() => removeDiscoveryFile(file)).toThrow(/Windows-only/);
  });

  it('throws TypeError on empty portPath', () => {
    expect(() => removeDiscoveryFile('', { platform: 'win32' })).toThrow(/portPath is required/);
  });

  it('exposes absent, removed, and replaced outcomes from shared identity removal', () => {
    const file = mkTmpFile('identity-removal-outcomes');
    fs.writeFileSync(file, 'owned');
    const identity = fs.lstatSync(file);

    expect(removeFileByIdentity(file, identity, {
      returnResult: true,
      label: 'test artifact',
    })).toEqual({ status: 'removed' });
    expect(removeFileByIdentity(file, identity, {
      returnResult: true,
      label: 'test artifact',
    })).toEqual({ status: 'absent' });

    fs.writeFileSync(file, 'replacement');
    expect(removeFileByIdentity(file, identity, {
      returnResult: true,
      label: 'test artifact',
    })).toMatchObject({ status: 'replaced' });
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });

  it('preserves an unlink/recreate replacement with reused dev+ino but changed identity metadata', () => {
    const file = mkTmpFile('identity-reused-dev-ino');
    fs.writeFileSync(file, 'owned');
    const originalStat = fs.lstatSync(file);
    const originalIdentity = __test__.snapshotFileIdentity(originalStat);
    expect(originalIdentity).not.toBeNull();

    fs.unlinkSync(file);
    fs.writeFileSync(file, 'replacement-after-recreate');
    const replacementStat = fs.lstatSync(file);
    // Model the deterministic XFS case even when the host filesystem does not
    // immediately recycle the inode: dev+ino are reused, but the generation
    // metadata changes. The cleanup fence must reject the replacement without
    // relying on mutable discovery content.
    Object.assign(replacementStat, {
      dev: originalStat.dev,
      ino: originalStat.ino,
      birthtimeMs: originalStat.birthtimeMs + 1,
      ctimeMs: originalStat.ctimeMs + 1,
    });
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      target === file ? replacementStat : realLstatSync(target, ...args)
    ));

    try {
      expect(removeDiscoveryFile(file, {
        platform: 'win32',
        username: 'alice',
        expectedIdentity: originalIdentity,
        aclInspector,
        returnResult: true,
      })).toMatchObject({ status: 'replaced' });
      expect(fs.readFileSync(file, 'utf8')).toBe('replacement-after-recreate');
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('refreshes a ctime-only identity after a descriptor-proven quarantine rename', () => {
    const file = mkTmpFile('discovery-ctime-quarantine');
    fs.writeFileSync(file, 'owned');
    const realLstatSync = fs.lstatSync.bind(fs);
    const realFstatSync = fs.fstatSync.bind(fs);
    const realRenameSync = fs.renameSync.bind(fs);
    const initialStat = realLstatSync(file);
    const initialCtime = Number(initialStat.ctimeMs);
    let renamed = false;

    const ctimeOnly = (stat) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      birthtime: undefined,
      birthtimeNs: undefined,
      birthtimeMs: undefined,
      ctime: undefined,
      ctimeNs: undefined,
      ctimeMs: initialCtime + (renamed ? 1 : 0),
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      ctimeOnly(realLstatSync(target, ...args))
    ));
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((target, ...args) => (
      ctimeOnly(realFstatSync(target, ...args))
    ));
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination, ...args) => {
      const result = realRenameSync(source, destination, ...args);
      if (source === file) renamed = true;
      return result;
    });

    const originalIdentity = ctimeOnly(initialStat);
    let refreshedIdentity;
    try {
      expect(removeFileByIdentity(file, originalIdentity, {
        returnResult: true,
        label: 'ctime-only discovery artifact',
        onIdentity: (identity) => { refreshedIdentity = identity; },
      })).toEqual({ status: 'removed' });
      expect(refreshedIdentity).toMatchObject({
        birthtime: null,
        ctime: `ms:${initialCtime + 1}`,
      });
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      renameSpy.mockRestore();
      fstatSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it('fails closed when a transport identity is missing stable metadata or type', () => {
    const file = mkTmpFile('identity-metadata-unavailable');
    fs.writeFileSync(file, 'owned');
    const stat = fs.lstatSync(file);

    expect(() => removeFileByIdentity(file, { dev: stat.dev, ino: stat.ino }, {
      label: 'identity-incomplete artifact',
    })).toThrowError(expect.objectContaining({
      code: 'GUARDIAN_TRANSPORT_IDENTITY_UNAVAILABLE',
    }));
    expect(fs.readFileSync(file, 'utf8')).toBe('owned');
  });

  it('does not remove a discovery file replaced during cleanup validation', () => {
    const file = mkTmpFile('discovery-toctou');
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    let replaced = false;

    expect(removeDiscoveryFile(file, {
      platform: 'win32',
      username: 'alice',
      aclInspector,
      reparseChecker: (candidate) => {
        if (candidate === file && !replaced) {
          replaced = true;
          fs.unlinkSync(file);
          fs.writeFileSync(file, '127.0.0.1:4096\n');
        }
        return false;
      },
    })).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:4096\n');
  });

  it('does not remove a replacement introduced immediately before atomic quarantine', () => {
    const file = mkTmpFile('discovery-quarantine-toctou');
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    const renameSync = fs.renameSync.bind(fs);
    let replaced = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (source === file && !replaced) {
        replaced = true;
        fs.unlinkSync(file);
        fs.writeFileSync(file, '127.0.0.1:4100\n');
      }
      return renameSync(source, destination);
    });

    try {
      expect(removeDiscoveryFile(file, {
        platform: 'win32',
        username: 'alice',
        aclInspector,
      })).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:4100\n');
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('does not unlink the expected file after a replacement appears after quarantine', () => {
    const file = mkTmpFile('discovery-post-quarantine-toctou');
    fs.writeFileSync(file, '127.0.0.1:4096\n');
    const renameSync = fs.renameSync.bind(fs);
    let quarantinedPath;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      const result = renameSync(source, destination);
      if (source === file && destination.endsWith('.remove')) {
        quarantinedPath = destination;
        fs.writeFileSync(file, '127.0.0.1:4100\n');
      }
      return result;
    });

    try {
      expect(() => removeDiscoveryFile(file, {
        platform: 'win32',
        username: 'alice',
        aclInspector,
        strict: true,
      })).toThrowError(expect.objectContaining({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      }));
      expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:4100\n');
      expect(quarantinedPath && fs.existsSync(quarantinedPath)).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }
  });
});

describe('writeDiscoveryFileAtomic (W-B)', () => {
  it('happy path: publishes the file and applies ACL on the temp path (closes F-6)', () => {
    const file = mkTmpFile();
    writeDiscoveryFileAtomic(file, 4096, {
      platform: 'win32', username: 'alice', aclInspector,
    });

    // Final file exists and contains the right body.
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:4096\n');

    // Lock and temp are cleaned up.
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    // ACL was applied to the temp file, not the final file (closes
    // F-6: temp is the only file ACL'd before hard-link publication).
    expect(aclSpy).toHaveBeenCalledTimes(1);
    const aclArgs = aclSpy.mock.calls[0][0];
    expect(aclArgs.portPath).toBe(`${file}.tmp`);
    expect(aclArgs.username).toBe('alice');
  });

  it('retains an O_EXCL lock as cleanup-uncertain when its first identity probe fails', () => {
    const file = mkTmpFile('discovery-lock-identity-uncertain');
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation(() => {
      throw Object.assign(new Error('lock identity metadata unavailable'), { code: 'EIO' });
    });

    try {
      expect(() => writeDiscoveryFileAtomic(file, 4096, {
        platform: 'win32', username: 'alice', aclInspector,
      })).toThrowError(expect.objectContaining({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      }));
      expect(fs.existsSync(`${file}.lock`)).toBe(true);
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    } finally {
      fstatSpy.mockRestore();
    }
  });

  it('retains an O_EXCL temp as cleanup-uncertain when its first identity probe fails', () => {
    const file = mkTmpFile('discovery-temp-identity-uncertain');
    const realFstatSync = fs.fstatSync.bind(fs);
    let calls = 0;
    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation((descriptor, ...args) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error('temp identity metadata unavailable'), { code: 'EIO' });
      }
      return realFstatSync(descriptor, ...args);
    });

    try {
      expect(() => writeDiscoveryFileAtomic(file, 4096, {
        platform: 'win32', username: 'alice', aclInspector,
      })).toThrowError(expect.objectContaining({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      }));
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
      expect(fs.existsSync(`${file}.tmp`)).toBe(true);
    } finally {
      fstatSpy.mockRestore();
    }
  });

  it('rolls back the final artifact when post-link temp cleanup fails', () => {
    const file = mkTmpFile('discovery-post-link-temp-cleanup');
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    let injected = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (
        typeof target === 'string'
        && path.basename(target).startsWith('.port.tmp.')
        && !injected
      ) {
        injected = true;
        throw Object.assign(new Error('temporary cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      expect(() => writeDiscoveryFileAtomic(file, 4096, {
        platform: 'win32', username: 'alice', aclInspector,
      })).toThrow(/temporary cleanup denied/);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('rolls back the final artifact when post-link lock cleanup fails', () => {
    const file = mkTmpFile('discovery-post-link-lock-cleanup');
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    let injected = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (
        typeof target === 'string'
        && path.basename(target).startsWith('.port.lock.')
        && !injected
      ) {
        injected = true;
        throw Object.assign(new Error('lock cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      expect(() => writeDiscoveryFileAtomic(file, 4096, {
        platform: 'win32', username: 'alice', aclInspector,
      })).toThrow(/lock cleanup denied/);
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(`${file}.tmp`)).toBe(false);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it.each([
    { label: 'temp', prefix: '.port.tmp.', pathKey: 'tmp' },
    { label: 'lock', prefix: '.port.lock.', pathKey: 'lock' },
  ])('returns cleanup uncertainty for persistent post-publication $label leftovers', ({ prefix, pathKey }) => {
    const file = mkTmpFile(`discovery-persistent-${pathKey}-cleanup`);
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (typeof target === 'string' && path.basename(target).startsWith(prefix)) {
        throw Object.assign(new Error(`${pathKey} cleanup denied`), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      expect(() => writeDiscoveryFileAtomic(file, 4096, {
        platform: 'win32', username: 'alice', aclInspector,
      })).toThrowError(expect.objectContaining({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
      }));
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.existsSync(`${file}.tmp`)).toBe(pathKey === 'tmp');
      expect(fs.existsSync(`${file}.lock`)).toBe(pathKey === 'lock');
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('returns a stable cleanup-uncertain error when final rollback cannot be proven', () => {
    const file = mkTmpFile('discovery-final-cleanup-uncertain');
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (typeof target === 'string' && path.basename(target).startsWith('.port.')) {
        throw Object.assign(new Error('final cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      expect(() => writeDiscoveryFileAtomic(file, 4096, {
        platform: 'win32', username: 'alice', aclInspector,
      })).toThrowError(expect.objectContaining({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        message: 'Guardian discovery publication cleanup is uncertain',
      }));
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('writes through "127.0.0.1:" even when called with a hostname', () => {
    // The factory passes a numeric port; the host is always
    // 127.0.0.1. Lock that contract.
    const file = mkTmpFile();
    writeDiscoveryFileAtomic(file, 31337, {
      platform: 'win32', username: 'alice', aclInspector,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:31337\n');
  });

  it('propagates icacls failure and cleans up the temp file', () => {
    aclSpy.mockImplementation(() => {
      throw new Error('icacls failed: access denied');
    });
    const file = mkTmpFile();
    expect(() => writeDiscoveryFileAtomic(file, 4096, {
      platform: 'win32', username: 'alice', aclInspector,
    }))
      .toThrow(/icacls failed: access denied/);

    // The rename never happened: no final file, no temp, no lock.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it('refuses to start when the lock file is already present', () => {
    const file = mkTmpFile();
    // Pre-create the lock file to simulate a concurrent publisher.
    fs.writeFileSync(`${file}.lock`, '');
    fs.writeFileSync(`${file}.tmp`, 'live-publisher-temp');
    expect(() => writeDiscoveryFileAtomic(file, 4096, {
      platform: 'win32', username: 'alice', aclInspector,
    }))
      .toThrow(/lock held/);
    expect(fs.readFileSync(`${file}.tmp`, 'utf8')).toBe('live-publisher-temp');
    // Cleanup: remove the lock so afterEach does not error.
    try { fs.unlinkSync(`${file}.lock`); } catch { /* ignore */ }
  });

  it('refuses to start when the temp file already exists', () => {
    const file = mkTmpFile();
    // Pre-create the temp file to simulate an O_EXCL failure mode.
    fs.writeFileSync(`${file}.tmp`, 'stale');
    expect(() => writeDiscoveryFileAtomic(file, 4096, {
      platform: 'win32', username: 'alice', aclInspector,
    }))
      .toThrow(/temp file .* already exists/);
    expect(fs.existsSync(`${file}.tmp`)).toBe(true);
    // Cleanup.
    try { fs.unlinkSync(`${file}.tmp`); } catch { /* ignore */ }
  });

  it('refuses to replace an existing final discovery file without recovery proof', () => {
    const file = mkTmpFile('discovery-live-final');
    fs.writeFileSync(file, '127.0.0.1:4096\n');

    expect(() => writeDiscoveryFileAtomic(file, 4100, {
      platform: 'win32', username: 'alice', aclInspector,
    })).toThrow(/refusing to replace it without stale-guardian recovery/);
    expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:4096\n');
  });

  it('does not clobber a final discovery file that appears after the existence check', () => {
    const file = mkTmpFile('discovery-publish-toctou');
    const linkSync = fs.linkSync.bind(fs);
    let appeared = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      if (destination === file && !appeared) {
        appeared = true;
        fs.writeFileSync(file, '127.0.0.1:4096\n');
      }
      return linkSync(source, destination);
    });

    try {
      expect(() => writeDiscoveryFileAtomic(file, 4100, {
        platform: 'win32', username: 'alice', aclInspector,
      })).toThrow(/appeared during publication/);
      expect(fs.readFileSync(file, 'utf8')).toBe('127.0.0.1:4096\n');
    } finally {
      linkSpy.mockRestore();
    }
  });

  it('rejects paths with unsafe characters (defense in depth)', () => {
    expect(() => writeDiscoveryFileAtomic('/path/with&amp', 4096, { platform: 'win32', username: 'alice' }))
      .toThrow(/unsafe characters/);
  });

  it('rejects an out-of-range port', () => {
    const file = mkTmpFile();
    expect(() => writeDiscoveryFileAtomic(file, 0, { platform: 'win32', username: 'alice' })).toThrow();
    expect(() => writeDiscoveryFileAtomic(file, -1, { platform: 'win32', username: 'alice' })).toThrow();
    expect(() => writeDiscoveryFileAtomic(file, 70000, { platform: 'win32', username: 'alice' })).toThrow();
    expect(() => writeDiscoveryFileAtomic(file, 4096.5, { platform: 'win32', username: 'alice' })).toThrow();
  });

  it.runIf(process.platform !== 'win32')('throws on non-Windows platforms (the W-A boundary is preserved)', () => {
    // Default platform override; on a Linux CI runtime this throws.
    // Gated to non-Windows runners for the same reason as the
    // read/remove tests: on Windows CI process.platform === 'win32'
    // makes the default-arg branch succeed and the assertion would fail.
    const file = mkTmpFile();
    expect(() => writeDiscoveryFileAtomic(file, 4096)).toThrow(/Windows-only/);
  });

  it('creates the parent directory if it does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-discovery-parent-'));
    tmpDirs.push(dir);
    const deepDir = path.join(dir, 'a', 'b', 'c');
    const file = path.join(deepDir, 'port');
    tmpFiles.push(file);
    writeDiscoveryFileAtomic(file, 4096, {
      platform: 'win32', username: 'alice', aclInspector,
    });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('rejects a reparse-point ancestor before publishing nested discovery state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-discovery-ancestor-reparse-'));
    tmpDirs.push(dir);
    const unsafeParent = path.join(dir, 'unsafe-parent');
    const file = path.join(unsafeParent, 'nested', 'port');
    fs.mkdirSync(unsafeParent);
    tmpFiles.push(file);

    expect(() => writeDiscoveryFileAtomic(file, 4096, {
      platform: 'win32',
      username: 'alice',
      reparseChecker: (candidate) => candidate === unsafeParent,
    })).toThrow(/ancestor.*reparse point/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('parseDiscoveryBody (internal)', () => {
  // Exercise the internal parser directly to lock the contract.
  it('parses 127.0.0.1:4096', () => {
    expect(__test__.parseDiscoveryBody('127.0.0.1:4096\n')).toEqual({ host: '127.0.0.1', port: 4096 });
  });
  it('parses localhost:0 — but port must be > 0', () => {
    expect(__test__.parseDiscoveryBody('localhost:0\n')).toBeNull();
  });
  it('rejects empty body', () => {
    expect(__test__.parseDiscoveryBody('')).toBeNull();
  });
  it('rejects non-string body', () => {
    expect(__test__.parseDiscoveryBody(null)).toBeNull();
    expect(__test__.parseDiscoveryBody(undefined)).toBeNull();
    expect(__test__.parseDiscoveryBody(4096)).toBeNull();
  });
  it('rejects host without port', () => {
    expect(__test__.parseDiscoveryBody('host-only')).toBeNull();
  });
  it('rejects port with no digits', () => {
    expect(__test__.parseDiscoveryBody('127.0.0.1:')).toBeNull();
  });
  it('exposes the WINDOWS_ONLY_ERROR constant', () => {
    expect(__test__.WINDOWS_ONLY_ERROR).toBe('discovery-file is Windows-only');
  });
});
