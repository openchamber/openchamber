import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const POSIX_ENV_BINARIES = ['/usr/bin/env', '/bin/env'];
const PTY_HOST_PRIVATE_VARIABLES = Object.freeze(['ARGV0', 'NODE_CHANNEL_FD']);

const hasBun = (runtime: typeof globalThis): runtime is typeof globalThis & { Bun: unknown } =>
  'Bun' in runtime && typeof runtime.Bun !== 'undefined';

interface BunFfi {
  dlopen: (library: string, symbols: { unsetenv: { args: ['cstring']; returns: 'i32' } }) => {
    symbols: { unsetenv: (name: Buffer) => number };
  };
}

export function stripAppImageArgv0Leak(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function stripAppImageArgv0Leak(env: null): null;
export function stripAppImageArgv0Leak(env: undefined): undefined;
export function stripAppImageArgv0Leak(env: NodeJS.ProcessEnv | null | undefined): NodeJS.ProcessEnv | null | undefined;
export function stripAppImageArgv0Leak(env: NodeJS.ProcessEnv | null | undefined) {
  if (!env) return env;
  if (Object.prototype.hasOwnProperty.call(env, 'ARGV0')) {
    delete env.ARGV0;
  }
  return env;
}

const APPIMAGE_LAUNCHER_ENTRIES = Object.freeze({
  PATH: { entries: (appDir: string) => [appDir, `${appDir}/usr/sbin`], dropEmpty: false },
  LD_LIBRARY_PATH: { entries: (appDir: string) => [`${appDir}/usr/lib`], dropEmpty: true },
  GSETTINGS_SCHEMA_DIR: { entries: (appDir: string) => [`${appDir}/usr/share/glib-2.0/schemas`], dropEmpty: true },
  XDG_DATA_DIRS: { entries: (appDir: string) => [`${appDir}/usr/share`, './share'], dropEmpty: true },
});

const withoutTrailingSlashes = (entry: string) => (entry.length > 1 ? entry.replace(/\/+$/, '') : entry);

export function stripAppImageLauncherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function stripAppImageLauncherEnv(env: null): null;
export function stripAppImageLauncherEnv(env: undefined): undefined;
export function stripAppImageLauncherEnv(env: NodeJS.ProcessEnv | null | undefined): NodeJS.ProcessEnv | null | undefined;
export function stripAppImageLauncherEnv(env: NodeJS.ProcessEnv | null | undefined) {
  const appDir = env?.APPDIR ? withoutTrailingSlashes(env.APPDIR) : '';
  if (!appDir || !env) return env;
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

export function clearAppImageArgv0FromProcessEnv() {
  delete process.env.ARGV0;
  if (process.platform !== 'linux' || !hasBun(globalThis)) return;
  try {
    const require = createRequire(import.meta.url);
    const { dlopen }: BunFfi = require('bun:ffi');
    const libc = dlopen('libc.so.6', {
      unsetenv: { args: ['cstring'], returns: 'i32' },
    });
    libc.symbols.unsetenv(Buffer.from('ARGV0\0'));
  } catch {
    return;
  }
}

export function resolvePosixPtyLaunch(executable: string, args: string[] = [], variables: readonly string[] = PTY_HOST_PRIVATE_VARIABLES) {
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
