import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WINDOWS_SHIM_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const DRIVE_OR_UNC_ROOTED_DIR = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;

type ProbeEnv = Record<string, string | undefined>;

export function getSpawnSyncBaseOptions() {
  return process.platform === 'win32' ? { windowsHide: true } : {};
}

function readEnv(env: ProbeEnv, name: string) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function isFile(candidate: string) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findWindowsPackageManagerShim(command: string, env: ProbeEnv = process.env, exists: (candidate: string) => boolean = isFile) {
  const extensions = (readEnv(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').map((ext) => ext.trim()).filter(Boolean);
  for (const entry of (readEnv(env, 'PATH') || '').split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!DRIVE_OR_UNC_ROOTED_DIR.test(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.win32.join(dir, `${command}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export function findWindowsCommandInterpreter(env: ProbeEnv = process.env) {
  const comSpec = (readEnv(env, 'COMSPEC') || '').trim();
  if (DRIVE_OR_UNC_ROOTED_DIR.test(comSpec)) return comSpec;
  const systemRoot = (readEnv(env, 'SYSTEMROOT') || '').trim();
  return DRIVE_OR_UNC_ROOTED_DIR.test(systemRoot) ? path.win32.join(systemRoot, 'System32', 'cmd.exe') : null;
}

function probeError(message: string): SpawnSyncReturns<string> {
  return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error: new Error(message) };
}

export function spawnPackageManagerProbe(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  if (process.platform === 'win32' && WINDOWS_SHIM_MANAGERS.has(command)) {
    const shim = findWindowsPackageManagerShim(command);
    if (!shim) return probeError(`${command} was not found on PATH`);
    const shell = findWindowsCommandInterpreter();
    if (!shell) return probeError('No absolute path to cmd.exe in ComSpec or SystemRoot');
    return spawnSync([`"${shim}"`, ...args].join(' '), { ...options, shell });
  }
  return spawnSync(command, args, options);
}
