import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';mock.module('node:fs', () => ({
  existsSync: mock(() => false),
}));

import { existsSync } from 'node:fs';

import {
  __resetCwdFallbackWarning,
  resolveManagedOpenCodeCwd,
} from './opencode-cwd.mjs';

describe('resolveManagedOpenCodeCwd', () => {
  let cwdSpy;
  let warnSpy;

  beforeEach(() => {
    __resetCwdFallbackWarning();
    cwdSpy = spyOn(process, 'cwd').mockReturnValue('/Users/example');
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('defaults managed OpenCode cwd to the user home directory', () => {
    existsSync.mockReturnValue(false);
    expect(
      resolveManagedOpenCodeCwd({ env: {}, homedir: () => '/Users/example' }),
    ).toBe('/Users/example');
  });

  it('preserves an explicit cwd override', () => {
    expect(
      resolveManagedOpenCodeCwd({
        env: { OPENCHAMBER_OPENCODE_CWD: '/tmp/opencode-cwd' },
        homedir: () => '/Users/example',
      }),
    ).toBe('/tmp/opencode-cwd');
  });

  it('ignores a blank cwd override', () => {
    existsSync.mockReturnValue(false);
    expect(
      resolveManagedOpenCodeCwd({
        env: { OPENCHAMBER_OPENCODE_CWD: '   ' },
        homedir: () => '/Users/example',
      }),
    ).toBe('/Users/example');
  });

  it('prefers process.cwd() when it looks like a project root', () => {
    cwdSpy.mockReturnValue('/repos/openchamber');
    existsSync.mockImplementation((p) => typeof p === 'string' && p.includes('package.json'));
    expect(
      resolveManagedOpenCodeCwd({ env: {}, homedir: () => '/Users/example' }),
    ).toBe('/repos/openchamber');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to home with a single warning when cwd is not a project root', () => {
    cwdSpy.mockReturnValue('/Users/example');
    existsSync.mockReturnValue(false);
    expect(
      resolveManagedOpenCodeCwd({ env: {}, homedir: () => '/Users/example' }),
    ).toBe('/Users/example');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('does not look like a project root');
  });

  it('suppresses the home-fallback warning on subsequent calls', () => {
    cwdSpy.mockReturnValue('/Users/example');
    existsSync.mockReturnValue(false);
    resolveManagedOpenCodeCwd({ env: {}, homedir: () => '/Users/example' });
    resolveManagedOpenCodeCwd({ env: {}, homedir: () => '/Users/example' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
