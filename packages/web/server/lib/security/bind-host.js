import net from 'node:net';

const stripIpv6Brackets = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const normalizeIpv4MappedAddress = (host) => {
  const normalized = stripIpv6Brackets(host);
  const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];
  // URL parsing rewrites a mapped address to hex groups
  // (::ffff:127.0.0.2 becomes ::ffff:7f00:2); decode that form too.
  const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return normalized;
};

const isLoopbackIpv4 = (host) => {
  if (net.isIP(host) !== 4) return false;
  const first = Number.parseInt(host.split('.')[0] || '', 10);
  return first === 127;
};

export const isLoopbackBindHost = (host) => {
  const normalized = normalizeIpv4MappedAddress(host);
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  if (isLoopbackIpv4(normalized)) return true;
  return net.isIP(normalized) === 6 && normalized === '::1';
};

// Loopback judgement for a full URL: parse it and range-test the parsed
// hostname, never the raw string — a prefix test judges
// http://localhost.evil.example and http://localhost@evil.example as
// loopback, and an exact-match list misses the rest of 127/8 and
// ::ffff:-mapped forms. Unparseable values are not loopback.
export const isLoopbackUrl = (raw) => {
  if (typeof raw !== 'string') return false;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return isLoopbackBindHost(url.hostname);
};

export const isNetworkExposedBindHost = (host) => !isLoopbackBindHost(host);

export const isUnsafeUnauthenticatedLanAllowed = (env = process.env) =>
  env?.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN === 'true';

export const getUnauthenticatedLanErrorMessage = (host) =>
  `OpenChamber refuses to bind to ${host || 'a network-exposed host'} without UI authentication. `
  + 'Set --ui-password or OPENCHAMBER_UI_PASSWORD before exposing it over LAN, '
  + 'or set OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true to accept the risk.';

// OPENCHAMBER_LAN_URL: the address other devices on the LAN reach this server
// at, for setups where the server cannot see it (a Docker container sees its
// bridge address, not the host's). An http(s) origin; anything else is ignored.
export const readAdvertisedLanUrl = (env = process.env, logger = console) => {
  const raw = String(env?.OPENCHAMBER_LAN_URL ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash) {
    logger.warn(`[config] Ignoring OPENCHAMBER_LAN_URL=${JSON.stringify(raw)}: expected an origin such as http://192.168.1.20:3000`);
    return null;
  }
  return url.origin;
};
