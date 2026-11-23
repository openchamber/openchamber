import { isString } from '../shared/guards.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.has(String(hostname).toLowerCase());

export function normalizeOriginInstance(value: string | undefined, { label }: { label: string }) {
  const raw = isString(value) ? value.trim() : '';
  if (!raw) throw new Error(`${label} instance is required`);

  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Invalid ${label} instance URL`);
  }

  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error(`${label} instance must be an origin`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} instances must use HTTPS`);
  }
  return url.origin;
}

const webPort = (url: URL) => Number(url.port || (url.protocol === 'http:' ? 80 : 443));

export function ownedOriginInstance({ host, port, knownInstances }: { host: string; port?: number; knownInstances: string[] }) {
  const name = String(host ?? '').toLowerCase();
  return knownInstances.find((origin) => {
    let url;
    try { url = new URL(origin); } catch { return false; }
    return url.hostname === name && (port === undefined || webPort(url) === port);
  }) ?? null;
}
