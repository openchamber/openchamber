import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from './windows-acl.js';
import {
  readDiscoveryFile,
  removeDiscoveryFile,
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
    const parsed = readDiscoveryFile(file, { platform: 'win32', username: 'alice', aclInspector });
    expect(parsed).toBeNull();
  });

  it('returns null for a port out of range', () => {
    const file = mkTmpFile();
    fs.writeFileSync(file, '127.0.0.1:70000\n');
    const parsed = readDiscoveryFile(file, { platform: 'win32', username: 'alice', aclInspector });
    expect(parsed).toBeNull();
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
    // F-6: temp is the only file ACL'd before the atomic rename).
    expect(aclSpy).toHaveBeenCalledTimes(1);
    const aclArgs = aclSpy.mock.calls[0][0];
    expect(aclArgs.portPath).toBe(`${file}.tmp`);
    expect(aclArgs.username).toBe('alice');
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
    expect(() => writeDiscoveryFileAtomic(file, 4096, {
      platform: 'win32', username: 'alice', aclInspector,
    }))
      .toThrow(/lock held/);
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
    // Cleanup.
    try { fs.unlinkSync(`${file}.tmp`); } catch { /* ignore */ }
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
