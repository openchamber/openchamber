import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyDirectoryAcl,
  applyDiscoveryFileAcl,
  resolveCurrentUsername,
  __test__,
} from './windows-acl.js';

let spawnSyncMock;

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
    });
    expect(result).toEqual({ ok: true, username: 'alice' });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncMock.mock.calls[0];
    expect(command).toBe('icacls');
    expect(args).toEqual([
      '"C:\\Users\\alice\\AppData\\Local\\openchamber\\managed-opencode-handoff-v2\\port"',
      '/inheritance:r',
      '/grant:r',
      'alice:F',
      '/c',
    ]);
    expect(options).toEqual({ encoding: 'utf8' });
  });

  it('quotes the path even when it contains spaces', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    applyDiscoveryFileAcl({
      portPath: '/safe path/with spaces',
      username: 'alice',
      spawnSync: spawnSyncMock,
    });
    const args = spawnSyncMock.mock.calls[0][1];
    expect(args[0]).toBe('"/safe path/with spaces"');
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
    });
    expect(result).toEqual({ ok: true, username: 'DOMAIN\\alice' });
    const [command, args] = spawnSyncMock.mock.calls[0];
    expect(command).toBe('icacls');
    expect(args).toEqual([
      '"C:\\Users\\alice\\AppData\\Local\\openchamber\\managed-opencode-handoff-v2"',
      '/inheritance:r',
      '/grant:r',
      'DOMAIN\\alice:(OI)(CI)F',
      '/c',
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

describe('__test__ helpers', () => {
  it('quoteForIcacls wraps the value in double quotes', () => {
    expect(__test__.quoteForIcacls('/safe/path')).toBe('"/safe/path"');
  });

  it('assertSafePath rejects empty strings', () => {
    expect(() => __test__.assertSafePath('', 'label')).toThrow(/label is required/);
  });

  it('assertUsername rejects empty strings', () => {
    expect(() => __test__.assertUsername('')).toThrow(/username is required/);
  });
});
