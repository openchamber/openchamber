import { describe, expect, it } from 'vitest';
import {
  clearAppImageArgv0FromProcessEnv,
  resolvePosixPtyLaunch,
  stripAppImageArgv0Leak,
} from './inherited-env.js';

describe('stripAppImageArgv0Leak', () => {
  it('removes ARGV0 from a child env object', () => {
    const env = {
      PATH: '/usr/bin',
      ARGV0: '/path/to/OpenChamber-1.17.2-linux-x86_64.AppImage',
      SHELL: '/bin/zsh',
    };

    expect(stripAppImageArgv0Leak(env)).toBe(env);
    expect(env).toEqual({
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });
  });

  it('is a no-op when ARGV0 is absent', () => {
    const env = { PATH: '/usr/bin', SHELL: '/bin/bash' };
    stripAppImageArgv0Leak(env);
    expect(env).toEqual({ PATH: '/usr/bin', SHELL: '/bin/bash' });
  });

  it('tolerates nullish env values', () => {
    expect(stripAppImageArgv0Leak(null)).toBeNull();
    expect(stripAppImageArgv0Leak(undefined)).toBeUndefined();
  });
});

describe('clearAppImageArgv0FromProcessEnv', () => {
  it('removes ARGV0 from process.env', () => {
    const previous = process.env.ARGV0;
    process.env.ARGV0 = '/path/to/OpenChamber.AppImage';
    try {
      clearAppImageArgv0FromProcessEnv();
      expect(process.env.ARGV0).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ARGV0;
      else process.env.ARGV0 = previous;
    }
  });
});

describe('resolvePosixPtyLaunch', () => {
  it('wraps the shell with env -u for every host-private variable on POSIX', () => {
    if (process.platform === 'win32') return;
    expect(resolvePosixPtyLaunch('/bin/zsh', ['-l'])).toEqual({
      executable: expect.stringMatching(/\/env$/),
      args: ['-u', 'ARGV0', '-u', 'NODE_CHANNEL_FD', '/bin/zsh', '-l'],
    });
  });

  it('leaves the launch unchanged with nothing to unset', () => {
    expect(resolvePosixPtyLaunch('/bin/zsh', ['-l'], [])).toEqual({
      executable: '/bin/zsh',
      args: ['-l'],
    });
  });
});
