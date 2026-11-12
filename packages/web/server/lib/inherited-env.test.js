import { describe, expect, it } from 'vitest';
import {
  clearAppImageArgv0FromProcessEnv,
  resolvePosixPtyLaunch,
  stripAppImageArgv0Leak,
  stripAppImageLauncherEnv,
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

describe('stripAppImageLauncherEnv', () => {
  const APPDIR = '/tmp/.mount_OpenChAbC123';

  it('removes what the launcher added when the user had none of the variables', () => {
    // Values captured from the child environment of a packaged 2.0.4 AppImage on Debian 13.
    const env = {
      APPDIR,
      LD_LIBRARY_PATH: `${APPDIR}/usr/lib:`,
      GSETTINGS_SCHEMA_DIR: `${APPDIR}/usr/share/glib-2.0/schemas:`,
      XDG_DATA_DIRS: `${APPDIR}/usr/share/:./share/:/usr/share/gnome:/usr/local/share/:/usr/share/::/usr/share/gnome/:/usr/local/share/:/usr/share/`,
      PATH: `${APPDIR}/resources/opencode-cli:/usr/local/bin:/usr/bin:/bin:${APPDIR}:${APPDIR}/usr/sbin`,
    };
    expect(stripAppImageLauncherEnv(env)).toBe(env);
    expect(env).toEqual({
      APPDIR,
      XDG_DATA_DIRS: '/usr/share/gnome:/usr/local/share/:/usr/share/:/usr/share/gnome/:/usr/local/share/:/usr/share/',
      PATH: `${APPDIR}/resources/opencode-cli:/usr/local/bin:/usr/bin:/bin`,
    });
  });

  it('keeps the user entries in order', () => {
    const env = {
      APPDIR: `${APPDIR}/`,
      LD_LIBRARY_PATH: `${APPDIR}/usr/lib:/opt/cuda/lib64::/home/me/lib`,
      GSETTINGS_SCHEMA_DIR: `${APPDIR}/usr/share/glib-2.0/schemas:/home/me/schemas`,
    };
    stripAppImageLauncherEnv(env);
    expect(env.LD_LIBRARY_PATH).toBe('/opt/cuda/lib64:/home/me/lib');
    expect(env.GSETTINGS_SCHEMA_DIR).toBe('/home/me/schemas');
  });

  it('keeps other directories inside the AppImage and paths that only share its prefix', () => {
    const env = { APPDIR, LD_LIBRARY_PATH: `${APPDIR}-other/usr/lib:${APPDIR}/usr/lib:${APPDIR}/resources/lib` };
    stripAppImageLauncherEnv(env);
    expect(env.LD_LIBRARY_PATH).toBe(`${APPDIR}-other/usr/lib:${APPDIR}/resources/lib`);
  });

  it('keeps empty PATH entries, which the launcher never adds', () => {
    const env = { APPDIR, PATH: `${APPDIR}:/usr/bin::` };
    stripAppImageLauncherEnv(env);
    expect(env.PATH).toBe('/usr/bin::');
  });

  it('leaves the environment alone outside an AppImage', () => {
    const env = { LD_LIBRARY_PATH: '/opt/lib::', XDG_DATA_DIRS: './share/:/usr/share' };
    stripAppImageLauncherEnv(env);
    expect(env).toEqual({ LD_LIBRARY_PATH: '/opt/lib::', XDG_DATA_DIRS: './share/:/usr/share' });
  });

  it('tolerates missing variables and nullish env values', () => {
    const env = { APPDIR };
    stripAppImageLauncherEnv(env);
    expect(env).toEqual({ APPDIR });
    expect(stripAppImageLauncherEnv(null)).toBeNull();
    expect(stripAppImageLauncherEnv(undefined)).toBeUndefined();
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
