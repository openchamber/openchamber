import { describe, expect, it, vi } from 'vitest';
import { isValidOpenCodeHostname, resolveOpenCodeEnvConfig } from './env-config.js';

describe('isValidOpenCodeHostname', () => {
  it('accepts IPv4 addresses', () => {
    expect(isValidOpenCodeHostname('127.0.0.1')).toBe(true);
    expect(isValidOpenCodeHostname('0.0.0.0')).toBe(true);
    expect(isValidOpenCodeHostname('192.168.1.10')).toBe(true);
  });

  it('accepts IPv6 addresses with and without brackets', () => {
    expect(isValidOpenCodeHostname('::1')).toBe(true);
    expect(isValidOpenCodeHostname('[::1]')).toBe(true);
    expect(isValidOpenCodeHostname('::')).toBe(true);
    expect(isValidOpenCodeHostname('[::]')).toBe(true);
  });

  it('accepts DNS-style hostnames', () => {
    expect(isValidOpenCodeHostname('localhost')).toBe(true);
    expect(isValidOpenCodeHostname('tailscale-host')).toBe(true);
    expect(isValidOpenCodeHostname('my.host.example')).toBe(true);
  });

  it('rejects malformed values', () => {
    const invalid = [
      '',
      '   ',
      'http://localhost',
      'https://host:4096',
      'host:4096',
      'host/path',
      'bad host',
      'bad_host',
      '0.0.0.0.0',
      '999.999.999.999',
      '[::1',
      '::1]',
      'a'.repeat(254),
      '1.2.3.4.5.6.7.8.9',
    ];
    for (const value of invalid) {
      expect(isValidOpenCodeHostname(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects non-string values', () => {
    expect(isValidOpenCodeHostname(undefined)).toBe(false);
    expect(isValidOpenCodeHostname(null)).toBe(false);
    expect(isValidOpenCodeHostname(42)).toBe(false);
  });
});

describe('resolveOpenCodeEnvConfig hostname', () => {
  it('defaults to loopback when the env var is absent', () => {
    expect(resolveOpenCodeEnvConfig({ env: {} }).configuredOpenCodeHostname).toBe('127.0.0.1');
  });

  it('reads OPENCHAMBER_OPENCODE_HOSTNAME', () => {
    const result = resolveOpenCodeEnvConfig({ env: { OPENCHAMBER_OPENCODE_HOSTNAME: '0.0.0.0' } });
    expect(result.configuredOpenCodeHostname).toBe('0.0.0.0');
  });

  it('trims surrounding whitespace', () => {
    const result = resolveOpenCodeEnvConfig({ env: { OPENCHAMBER_OPENCODE_HOSTNAME: '  tailscale-host  ' } });
    expect(result.configuredOpenCodeHostname).toBe('tailscale-host');
  });

  it('warns and falls back for an empty value', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOpenCodeEnvConfig({ env: { OPENCHAMBER_OPENCODE_HOSTNAME: '   ' }, logger });
    expect(result.configuredOpenCodeHostname).toBe('127.0.0.1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('empty after trimming'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('rejects invalid values with a clear error and falls back to loopback', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOpenCodeEnvConfig({
      env: { OPENCHAMBER_OPENCODE_HOSTNAME: 'http://nope:4096' },
      logger,
    });
    expect(result.configuredOpenCodeHostname).toBe('127.0.0.1');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Rejecting OPENCHAMBER_OPENCODE_HOSTNAME'),
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('127.0.0.1'));
  });

  it('keeps other env config intact when the hostname is validated', () => {
    const result = resolveOpenCodeEnvConfig({
      env: { OPENCHAMBER_OPENCODE_HOSTNAME: '0.0.0.0', OPENCODE_PORT: '4096' },
    });
    expect(result.configuredOpenCodeHostname).toBe('0.0.0.0');
    expect(result.configuredOpenCodePort).toBe(4096);
    expect(result.effectivePort).toBe(4096);
  });
});

describe('resolveOpenCodeEnvConfig path mapping', () => {
  it('returns zero rules when OPENCODE_PATH_MAP is absent', () => {
    const result = resolveOpenCodeEnvConfig({ env: {} });
    expect(result.pathMappingRules).toEqual([]);
  });

  it('parses valid OPENCODE_PATH_MAP pairs', () => {
    const result = resolveOpenCodeEnvConfig({
      env: { OPENCODE_PATH_MAP: 'C:\\Users\\me\\my-project=/workspace' },
      platform: 'win32',
    });
    expect(result.pathMappingRules).toEqual([
      { hostPrefix: 'C:\\Users\\me\\my-project', remotePrefix: '/workspace', compareKey: 'c:\\users\\me\\my-project' },
    ]);
  });

  it('parses POSIX host pairs on POSIX platforms', () => {
    const result = resolveOpenCodeEnvConfig({
      env: { OPENCODE_PATH_MAP: '/home/me/my-project=/workspace' },
      platform: 'linux',
    });
    expect(result.pathMappingRules).toEqual([
      { hostPrefix: '/home/me/my-project', remotePrefix: '/workspace', compareKey: '/home/me/my-project' },
    ]);
  });

  it('warns about invalid pairs without dropping valid ones', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const result = resolveOpenCodeEnvConfig({
      env: { OPENCODE_PATH_MAP: 'C:\\valid=/workspace;relative=/workspace' },
      platform: 'win32',
      logger,
    });
    expect(result.pathMappingRules).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('OPENCODE_PATH_MAP'));
  });
});
