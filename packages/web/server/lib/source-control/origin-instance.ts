import { isString } from '../shared/guards.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// Literal private-network addresses (RFC 1918, IPv4 link-local, IPv6
// unique-local/link-local). Hostnames that need DNS to resolve are
// intentionally not covered so this stays deterministic and side-effect-free.
const isPrivateNetworkHost = (hostname: string) => {
  const value = String(hostname).toLowerCase();
  const octets = value.split('.').map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.length === 4 && octets.every((n) => n >= 0 && n <= 255)) {
    const [a = -1, b = -1] = octets;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return true;
    }
    return false;
  }
  const address = value.replace(/^\[/, '').replace(/\]$/, '');
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
};

const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.has(String(hostname).toLowerCase());

const isLocalNetworkHost = (hostname: string) => isLoopbackHost(hostname) || isPrivateNetworkHost(hostname);

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
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalNetworkHost(url.hostname))) {
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
