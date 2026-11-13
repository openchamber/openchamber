import { spawn } from 'node:child_process';
import { isString } from '../shared/guards.js';

// `ssh -G` reads a host name, and a value starting with `-` would read as an
// option instead.
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const RESOLVE_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CACHE_TTL_MS = 60_000;
const CACHE_SIZE = 256;

/** Whether a remote's host can be handed to `ssh -G` as a host name. */
export const isSshHostName = (value) => isString(value) && HOST_NAME.test(value);

/** The explicit SSH user, preserving case; an absent user lets SSH config decide. */
export const sshUserOf = (value) => {
  if (!value.includes('://')) return value.match(/^([^@/:\s]+)@/)?.[1] ?? '';
  try { return decodeURIComponent(new URL(value).username); }
  catch { return null; }
};

const settingOf = (output, name) => {
  for (const line of output.split('\n')) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (key.toLowerCase() === name && value) return value.toLowerCase();
  }
  return null;
};

/** `ssh -G`'s effective hostname for the remote user, or null when ssh cannot answer. */
const readHost = (host, user, configFile) => new Promise((resolve) => {
  let output = '';
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  let child;
  try {
    child = spawn('ssh', ['-G', ...(configFile ? ['-F', configFile] : []), ...(user ? ['-l', user] : []), host], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch {
    finish(null);
    return;
  }
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    finish(null);
  }, RESOLVE_TIMEOUT_MS);
  timer.unref?.();
  child.stdout.on('data', (chunk) => {
    if (output.length + chunk.length > MAX_OUTPUT_BYTES) {
      try { child.kill('SIGKILL'); } catch {}
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

/** Share pending reads and cache completed answers, including failures, for a minute. */
export function createSshHostResolver({ configFile, read = (host, user) => readHost(host, user, configFile) } = {}) {
  const cache = new Map();
  return async (host, user = '') => {
    if (!isSshHostName(host) || !isString(user) || (user && !/^[A-Za-z0-9_.-]+$/.test(user))) return null;
    const name = host.toLowerCase();
    const key = `${user}@${name}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.resolved;
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    const entry = { resolved: null, expiresAt: Infinity };
    entry.resolved = Promise.resolve().then(() => read(name, user)).catch(() => null).then((resolved) => {
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return resolved;
    });
    cache.set(key, entry);
    return entry.resolved;
  };
}

const resolveSshHost = createSshHostResolver();

/** Match only a direct effective HostName, never a shared address or HostKeyAlias. */
export async function sshHostReaches(host, hostname, user = '', resolve = resolveSshHost) {
  if (!isSshHostName(host) || !isSshHostName(hostname)) return false;
  const remote = await resolve(host, user);
  return remote !== null && remote.hostname === hostname;
}
