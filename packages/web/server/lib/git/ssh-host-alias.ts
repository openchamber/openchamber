import { spawn } from 'node:child_process';
import { isString } from '../shared/guards.js';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

interface SshHost {
  hostname: string | null;
}

type HostReader = (host: string, user: string) => Promise<SshHost | null> | SshHost | null;
type HostResolution = Promise<SshHost | null>;

interface HostCacheEntry {
  resolved: HostResolution | null;
  expiresAt: number;
}

interface HostResolverOptions {
  configFile?: string;
  read?: HostReader;
}

const killHostReader = (child: ChildProcessByStdio<null, Readable, null>) => {
  try { child.kill('SIGKILL'); }
  catch { return; }
};

const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const RESOLVE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CACHE_TTL_MS = 60_000;
const CACHE_SIZE = 256;

export const isSshHostName = (value: string | null | undefined) => isString(value) && HOST_NAME.test(value ?? '');

export const sshUserOf = (value: string) => {
  if (!value.includes('://')) return value.match(/^([^@/:\s]+)@/)?.[1] ?? '';
  try { return decodeURIComponent(new URL(value).username); }
  catch { return null; }
};

const settingOf = (output: string, name: string) => {
  for (const line of output.split('\n')) {
    const [key = '', value] = line.trim().split(/\s+/, 2);
    if (key.toLowerCase() === name && value) return value.toLowerCase();
  }
  return null;
};

const readHost = (host: string, user: string, configFile: string | undefined) => new Promise<SshHost | null>((resolve) => {
  let output = '';
  let settled = false;
  const finish = (value: SshHost | null) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  let child: ChildProcessByStdio<null, Readable, null>;
  try {
    child = spawn('ssh', ['-G', ...(configFile ? ['-F', configFile] : []), ...(user ? ['-l', user] : []), host], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    finish(null);
    return;
  }
  const timer = setTimeout(() => {
    killHostReader(child);
    finish(null);
  }, RESOLVE_TIMEOUT_MS);
  timer.unref?.();
  child.stdout.on('data', (chunk) => {
    if (output.length + chunk.length > MAX_OUTPUT_BYTES) {
      killHostReader(child);
      clearTimeout(timer);
      finish(null);
      return;
    }
    output += chunk;
  });
  child.on('error', () => {
    clearTimeout(timer);
    finish(null);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    finish(code === 0
      ? { hostname: settingOf(output, 'hostname') }
      : null);
  });
});

export function createSshHostResolver({ configFile, read = (host, user) => readHost(host, user, configFile) }: HostResolverOptions = {}) {
  const cache = new Map<string, HostCacheEntry>();
  return async (host: string | null | undefined, user: string | null = '') => {
    if (!isSshHostName(host) || !isString(user) || (user && !/^[A-Za-z0-9_.-]+$/.test(user))) return null;
    const name = host?.toLowerCase() ?? '';
    const key = `${user}@${name}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.resolved;
    if (cache.size >= CACHE_SIZE) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    const entry: HostCacheEntry = { resolved: null, expiresAt: Infinity };
    entry.resolved = Promise.resolve().then(() => read(name, user ?? '')).catch(() => null).then((resolved) => {
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return resolved;
    });
    cache.set(key, entry);
    return entry.resolved;
  };
}

const resolveSshHost = createSshHostResolver();

export async function sshHostReaches(host: string | null | undefined, hostname: string | null | undefined, user: string | null = '', resolve = resolveSshHost) {
  if (!isSshHostName(host) || !isSshHostName(hostname)) return false;
  const remote = await resolve(host, user);
  return remote !== null && remote.hostname === hostname;
}
