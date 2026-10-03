/**
 * Sanitize environment objects inherited by user-facing child processes.
 *
 * Linux AppImage runtimes export `ARGV0` as the AppImage path before launching
 * the packaged app. zsh treats an exported `ARGV0` as the argv[0] for every
 * external command it spawns, which corrupts Python venv detection and any
 * other program that reads argv[0]/$0 while leaving `/proc/self/exe` correct.
 *
 * See openchamber/openchamber#2588 and pingdotgg/t3code#2509.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const POSIX_ENV_BINARIES = ['/usr/bin/env', '/bin/env'];
/** Variables a PTY shell must never inherit from the OpenChamber host process. */
const PTY_HOST_PRIVATE_VARIABLES = Object.freeze(['ARGV0', 'NODE_CHANNEL_FD']);

/**
 * Remove AppImage `ARGV0` from a mutable env object (or `process.env`).
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined} env
 * @returns {typeof env}
 */
export function stripAppImageArgv0Leak(env) {
  if (!env || typeof env !== 'object') return env;
  if (Object.prototype.hasOwnProperty.call(env, 'ARGV0')) {
    delete env.ARGV0;
  }
  return env;
}

/**
 * Entries the AppImage launcher (electron-builder's AppRun) adds to list
 * variables before starting the app, given the mount point `appDir`.
 * `dropEmpty` marks lists where the launcher leaves an empty entry (a trailing
 * `:`) when the user had not set the variable; PATH is always set, so its
 * empty entries are the user's and are kept.
 */
const APPIMAGE_LAUNCHER_ENTRIES = Object.freeze({
  PATH: { entries: (appDir) => [appDir, `${appDir}/usr/sbin`], dropEmpty: false },
  LD_LIBRARY_PATH: { entries: (appDir) => [`${appDir}/usr/lib`], dropEmpty: true },
  GSETTINGS_SCHEMA_DIR: { entries: (appDir) => [`${appDir}/usr/share/glib-2.0/schemas`], dropEmpty: true },
  XDG_DATA_DIRS: { entries: (appDir) => [`${appDir}/usr/share`, './share'], dropEmpty: true },
});

const withoutTrailingSlashes = (entry) => (entry.length > 1 ? entry.replace(/\/+$/, '') : entry);

/**
 * Remove what the AppImage launcher added to `PATH`, `LD_LIBRARY_PATH`,
 * `GSETTINGS_SCHEMA_DIR` and `XDG_DATA_DIRS` in a mutable child env object.
 *
 * Left in place, user tools load the app's bundled libraries and data, and an
 * empty `LD_LIBRARY_PATH` entry makes the dynamic linker search the current
 * directory (#4177). Runs only when `APPDIR` says we are inside an AppImage.
 * The user's own non-empty entries are kept in order (empty ones are dropped
 * from the lists marked `dropEmpty`), entries the app adds itself (the bundled
 * OpenCode CLI directory) are kept, and a variable left with no entries is
 * removed. `XDG_DATA_DIRS` keeps the system directories the launcher wraps
 * around the user's value: they are the spec's defaults, not the app's files.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined} env
 * @returns {typeof env}
 */
export function stripAppImageLauncherEnv(env) {
  const appDir = env?.APPDIR ? withoutTrailingSlashes(env.APPDIR) : '';
  if (!appDir) return env;
  for (const [name, launcher] of Object.entries(APPIMAGE_LAUNCHER_ENTRIES)) {
    const value = env[name];
    if (value === undefined) continue;
    const added = new Set(launcher.entries(appDir));
    const kept = value
      .split(':')
      .filter((entry) => !(launcher.dropEmpty && entry === '') && !added.has(withoutTrailingSlashes(entry)));
    if (kept.length > 0) {
      env[name] = kept.join(':');
    } else {
      delete env[name];
    }
  }
  return env;
}

/**
 * Clear AppImage `ARGV0` from this process.
 *
 * Bun keeps a native environ that `bun-pty` inherits even after
 * `delete process.env.ARGV0`. On Linux under Bun we also call libc `unsetenv`.
 */
export function clearAppImageArgv0FromProcessEnv() {
  delete process.env.ARGV0;
  if (process.platform !== 'linux' || typeof Bun === 'undefined') return;
  try {
    const require = createRequire(import.meta.url);
    const { dlopen } = require('bun:ffi');
    const libc = dlopen('libc.so.6', {
      unsetenv: { args: ['cstring'], returns: 'i32' },
    });
    libc.symbols.unsetenv(Buffer.from('ARGV0\0'));
  } catch {
    // Node/Electron and environments without bun:ffi rely on explicit child envs.
  }
}

/**
 * Resolve a POSIX PTY launch that unsets host-private variables before the
 * shell starts.
 *
 * `bun-pty` merges the OS environ into the child, so deleting a variable from
 * the JS env object alone is not enough: AppImage `ARGV0` came back on Linux,
 * and the daemon's `NODE_CHANNEL_FD` came back everywhere (Node then warns
 * "Failed to parse IPC channel number" when a CLI such as opencode exits).
 * Wrapping with `env -u NAME ...` unsets them before execing the real shell.
 * No-op on Windows and when no `env` binary is found.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {readonly string[]} variables
 * @returns {{ executable: string, args: string[] }}
 */
export function resolvePosixPtyLaunch(executable, args = [], variables = PTY_HOST_PRIVATE_VARIABLES) {
  if (process.platform === 'win32' || variables.length === 0) {
    return { executable, args };
  }
  const envBinary = POSIX_ENV_BINARIES.find((candidate) => existsSync(candidate));
  if (!envBinary) {
    return { executable, args };
  }
  return {
    executable: envBinary,
    args: [...variables.flatMap((name) => ['-u', name]), executable, ...args],
  };
}
