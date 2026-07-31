import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyDirectoryAcl,
  applyDiscoveryFileAcl,
  applyPrivateFileAcl,
  resolveCurrentUsername,
  validateWindowsAncestorAcl,
  validateWindowsAcl,
  __test__,
} from './windows-acl.js';

let spawnSyncMock;
const safeAcl = (username = 'alice') => [{ principal: username, rights: ['F'] }];

beforeEach(() => {
  spawnSyncMock = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveCurrentUsername', () => {
  it('returns the trimmed stdout of `whoami`', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'DOMAIN\\alice\n', stderr: '' });
    const result = resolveCurrentUsername({ spawnSync: spawnSyncMock });
    expect(result).toBe('DOMAIN\\alice');
    expect(spawnSyncMock).toHaveBeenCalledWith('whoami', [], { encoding: 'utf8' });
  });

  it('throws with a "whoami not found" message when the binary is missing (ENOENT)', () => {
    const enoent = Object.assign(new Error('spawn whoami ENOENT'), { code: 'ENOENT' });
    spawnSyncMock.mockReturnValue({ error: enoent });
    expect(() => resolveCurrentUsername({ spawnSync: spawnSyncMock })).toThrow(/whoami not found/);
  });

  it('throws with a helpful message when whoami exits non-zero', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'access denied' });
    expect(() => resolveCurrentUsername({ spawnSync: spawnSyncMock })).toThrow(/whoami exited with code 1: access denied/);
  });

  it('throws on empty stdout', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '   \n', stderr: '' });
    expect(() => resolveCurrentUsername({ spawnSync: spawnSyncMock })).toThrow(/empty username/);
  });

  it('throws on non-ENOENT spawn error', () => {
    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    spawnSyncMock.mockReturnValue({ error: eperm });
    expect(() => resolveCurrentUsername({ spawnSync: spawnSyncMock })).toThrow(/permission denied/);
  });
});

describe('applyDiscoveryFileAcl', () => {
  it('runs icacls with /grant:r <username>:F on the discovery file', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const result = applyDiscoveryFileAcl({
      portPath: 'C:\\Users\\alice\\AppData\\Local\\openchamber\\managed-opencode-handoff-v2\\port',
      username: 'alice',
      spawnSync: spawnSyncMock,
      aclEntries: safeAcl(),
    });
    expect(result).toEqual({ ok: true, username: 'alice' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncMock.mock.calls[0];
    expect(command).toBe('icacls');
    expect(args).toEqual([
      'C:\\Users\\alice\\AppData\\Local\\openchamber\\managed-opencode-handoff-v2\\port',
      '/inheritance:r',
      '/grant:r',
      'alice:F',
    ]);
    expect(options).toEqual({ encoding: 'utf8', shell: false });
  });

  it('passes a path with spaces as one unquoted argv element', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    applyDiscoveryFileAcl({
      portPath: '/safe path/with spaces',
      username: 'alice',
      spawnSync: spawnSyncMock,
      aclEntries: safeAcl(),
    });
    const args = spawnSyncMock.mock.calls[0][1];
    expect(args[0]).toBe('/safe path/with spaces');
  });

  it('throws with stderr in the message on non-zero exit', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'Access is denied.' });
    expect(() => applyDiscoveryFileAcl({
      portPath: 'C:\\safe\\port',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/icacls failed: Access is denied\./);
  });

  it('throws with the "icacls binary not found" message on ENOENT', () => {
    const enoent = Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' });
    spawnSyncMock.mockReturnValue({ error: enoent });
    expect(() => applyDiscoveryFileAcl({
      portPath: 'C:\\safe\\port',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/Could not locate icacls binary/);
  });

  it('throws on non-ENOENT spawn error', () => {
    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    spawnSyncMock.mockReturnValue({ error: eperm });
    expect(() => applyDiscoveryFileAcl({
      portPath: 'C:\\safe\\port',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/permission denied/);
  });

  it('rejects paths containing shell metacharacters', () => {
    expect(() => applyDiscoveryFileAcl({
      portPath: '/safe/with;&|<>^chars',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/unsafe characters/);
  });

  it('rejects paths containing control characters', () => {
    expect(() => applyDiscoveryFileAcl({
      portPath: '/safe/with\x01control',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/unsafe characters/);
  });

  it('rejects paths containing double quotes', () => {
    expect(() => applyDiscoveryFileAcl({
      portPath: '/safe/with"quote',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/unsafe characters/);
  });

  it('rejects paths containing ampersand', () => {
    expect(() => applyDiscoveryFileAcl({
      portPath: '/safe/with&amp',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/unsafe characters/);
  });

  it('rejects empty portPath', () => {
    expect(() => applyDiscoveryFileAcl({ portPath: '', username: 'alice', spawnSync: spawnSyncMock })).toThrow(/portPath is required/);
  });

  it('rejects empty username', () => {
    expect(() => applyDiscoveryFileAcl({ portPath: '/safe', username: '', spawnSync: spawnSyncMock })).toThrow(/username is required/);
  });
});

describe('applyDirectoryAcl', () => {
  it('runs icacls with /grant:r <username>:(OI)(CI)F for inheritance', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const result = applyDirectoryAcl({
      dirPath: 'C:\\Users\\alice\\AppData\\Local\\openchamber\\managed-opencode-handoff-v2',
      username: 'DOMAIN\\alice',
      spawnSync: spawnSyncMock,
      aclEntries: safeAcl('DOMAIN\\alice'),
    });
    expect(result).toEqual({ ok: true, username: 'DOMAIN\\alice' });
    const [command, args] = spawnSyncMock.mock.calls[0];
    expect(command).toBe('icacls');
    expect(args).toEqual([
      'C:\\Users\\alice\\AppData\\Local\\openchamber\\managed-opencode-handoff-v2',
      '/inheritance:r',
      '/grant:r',
      'DOMAIN\\alice:(OI)(CI)F',
    ]);
  });

  it('throws with stderr in the message on non-zero exit', () => {
    spawnSyncMock.mockReturnValue({ status: 2, stdout: '', stderr: 'failed to set ACL' });
    expect(() => applyDirectoryAcl({
      dirPath: 'C:\\safe\\dir',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/icacls failed: failed to set ACL/);
  });

  it('throws on ENOENT', () => {
    const enoent = Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' });
    spawnSyncMock.mockReturnValue({ error: enoent });
    expect(() => applyDirectoryAcl({
      dirPath: 'C:\\safe\\dir',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/Could not locate icacls binary/);
  });

  it('rejects paths with unsafe characters (defense in depth)', () => {
    expect(() => applyDirectoryAcl({
      dirPath: '/dir/with&',
      username: 'alice',
      spawnSync: spawnSyncMock,
    })).toThrow(/unsafe characters/);
  });
});

describe('applyPrivateFileAcl', () => {
  it('passes the file path and grant as bounded argv entries', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    applyPrivateFileAcl({
      filePath: 'C:\\Users\\alice\\App Data\\openchamber\\guardian-auth.secret',
      username: 'DOMAIN\\alice',
      spawnSync: spawnSyncMock,
      aclEntries: safeAcl('DOMAIN\\alice'),
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'icacls',
      [
        'C:\\Users\\alice\\App Data\\openchamber\\guardian-auth.secret',
        '/inheritance:r',
        '/grant:r',
        'DOMAIN\\alice:F',
      ],
      { encoding: 'utf8', shell: false },
    );
  });
});

describe('__test__ helpers', () => {
  it('assertSafePath rejects empty strings', () => {
    expect(() => __test__.assertSafePath('', 'label')).toThrow(/label is required/);
  });

  it('assertUsername rejects empty strings', () => {
    expect(() => __test__.assertUsername('')).toThrow(/username is required/);
  });

  it('parses the first ACL entry when icacls places it on the path line', () => {
    expect(__test__.parseAclOutput([
      'C:\\safe\\secret alice:(F)',
      '                 NT AUTHORITY\\SYSTEM:(I)(F)',
      'Successfully processed 1 files; Failed processing 0 files',
    ].join('\n'))).toEqual([
      { principal: 'alice', rights: ['F'], inherited: false },
      { principal: 'NT AUTHORITY\\SYSTEM', rights: ['I', 'F'], inherited: true },
    ]);
  });

  it('strips a case-insensitive target path before parsing an inline first ACL entry', () => {
    const targetPath = 'C:\\Users\\Jane Doe\\AppData\\Local';
    expect(__test__.parseAclOutput([
      'c:\\users\\jane doe\\appdata\\local alice:(F)',
      '                                      NT AUTHORITY\\SYSTEM:(I)(F)',
      'Successfully processed 1 files; Failed processing 0 files',
    ].join('\n'), targetPath)).toEqual([
      { principal: 'alice', rights: ['F'], inherited: false },
      { principal: 'NT AUTHORITY\\SYSTEM', rights: ['I', 'F'], inherited: true },
    ]);
  });
});

describe('validateWindowsAcl', () => {
  it('rejects broad explicit access even when the current user is granted', () => {
    expect(() => validateWindowsAcl({
      targetPath: 'C:\\safe\\secret',
      username: 'alice',
      aclEntries: [
        { principal: 'alice', rights: ['F'] },
        { principal: 'Everyone', rights: ['F'] },
      ],
    })).toThrow(/unapproved principal/);
  });

  it('accepts the current user and inherited system/admin entries', () => {
    expect(validateWindowsAcl({
      targetPath: 'C:\\safe\\root',
      username: 'alice',
      kind: 'private directory',
      aclEntries: [
        { principal: 'alice', rights: ['OI', 'CI', 'F'] },
        { principal: 'NT AUTHORITY\\SYSTEM', rights: ['I', 'F'], inherited: true },
        { principal: 'BUILTIN\\Administrators', rights: ['I', 'F'], inherited: true },
      ],
    })).toEqual({ ok: true, username: 'alice' });
  });

  it('accepts explicit system/admin entries copied by inheritance removal', () => {
    expect(validateWindowsAcl({
      targetPath: 'C:\\safe\\root',
      username: 'alice',
      kind: 'private directory',
      aclEntries: [
        { principal: 'alice', rights: ['OI', 'CI', 'F'] },
        { principal: 'NT AUTHORITY\\SYSTEM', rights: ['F'], inherited: false },
        { principal: 'BUILTIN\\Administrators', rights: ['F'], inherited: false },
      ],
    })).toEqual({ ok: true, username: 'alice' });
  });

  it('fails closed for an injected reparse-point observation', () => {
    expect(() => validateWindowsAcl({
      targetPath: 'C:\\safe\\secret',
      username: 'alice',
      inspectAcl: () => ({ reparsePoint: true, entries: safeAcl() }),
    })).toThrow(/reparse point/);
  });
});

describe('validateWindowsAncestorAcl', () => {
  it('accepts inherited read/execute access while preserving owner and system write access', () => {
    expect(validateWindowsAncestorAcl({
      targetPath: 'C:\\Users\\alice\\AppData',
      username: 'alice',
      aclEntries: [
        { principal: 'alice', rights: ['I', 'F'], inherited: true },
        { principal: 'NT AUTHORITY\\SYSTEM', rights: ['I', 'F'], inherited: true },
        { principal: 'BUILTIN\\Administrators', rights: ['I', 'F'], inherited: true },
        { principal: 'Users', rights: ['I', 'RX'], inherited: true },
      ],
    })).toEqual({ ok: true, username: 'alice' });
  });

  it('accepts the standard inherited creator-owner entry', () => {
    expect(validateWindowsAncestorAcl({
      targetPath: 'C:\\Users\\alice\\AppData',
      username: 'alice',
      aclEntries: [
        { principal: 'alice', rights: ['I', 'F'], inherited: true },
        { principal: 'CREATOR OWNER', rights: ['I', 'OI', 'CI', 'IO', 'F'], inherited: true },
      ],
    })).toEqual({ ok: true, username: 'alice' });
  });

  it('rejects an explicit non-inherited creator-owner entry', () => {
    expect(() => validateWindowsAncestorAcl({
      targetPath: 'C:\\Users\\alice\\AppData',
      username: 'alice',
      aclEntries: [
        { principal: 'alice', rights: ['I', 'F'], inherited: true },
        { principal: 'CREATOR OWNER', rights: ['OI', 'CI', 'IO', 'F'], inherited: false },
      ],
    })).toThrow(/unsafe explicit creator-owner entry/);
  });

  it('rejects an attacker-writable ancestor even when the current user is safe', () => {
    expect(() => validateWindowsAncestorAcl({
      targetPath: 'C:\\Users\\alice\\AppData',
      username: 'alice',
      aclEntries: [
        { principal: 'alice', rights: ['I', 'F'], inherited: true },
        { principal: 'Everyone', rights: ['I', 'M'], inherited: true },
      ],
    })).toThrow(/ancestor ACL grants write access/);
  });

  it('fails closed when ancestor ACL inspection is unavailable', () => {
    expect(() => validateWindowsAncestorAcl({
      targetPath: 'C:\\Users\\alice\\AppData',
      username: 'alice',
      inspectAcl: () => ({ entries: [] }),
    })).toThrow(/ancestor ACL is unavailable/);
  });
});
