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

const LINUX_ENV_BINARIES = ['/usr/bin/env', '/bin/env'];

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
 * Resolve a Linux PTY launch that drops native `ARGV0` before the shell starts.
 *
 * `bun-pty` merges the OS environ into the child, so deleting `ARGV0` from the
 * JS env object alone is not enough. Wrapping with `env -u ARGV0` unsets it
 * before execing the real shell. No-op on non-Linux platforms.
 *
 * @param {string} executable
 * @param {string[]} args
 * @returns {{ executable: string, args: string[] }}
 */
export function resolveLinuxPtyLaunch(executable, args = []) {
  if (process.platform !== 'linux') {
    return { executable, args };
  }
  const envBinary = LINUX_ENV_BINARIES.find((candidate) => existsSync(candidate));
  if (!envBinary) {
    return { executable, args };
  }
  return {
    executable: envBinary,
    args: ['-u', 'ARGV0', executable, ...args],
  };
}
