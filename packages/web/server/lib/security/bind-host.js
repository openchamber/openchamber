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
  const match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match ? match[1] : normalized;
};

const isLoopbackIpv4 = (host) => {
  if (net.isIP(host) !== 4) return false;
  const first = Number.parseInt(host.split('.')[0] || '', 10);
  return first === 127;
};

export const isLoopbackBindHost = (host) => {
  const normalized = normalizeIpv4MappedAddress(host);
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  if (isLoopbackIpv4(normalized)) return true;
  return net.isIP(normalized) === 6 && normalized === '::1';
};

export const isNetworkExposedBindHost = (host) => !isLoopbackBindHost(host);

export const isUnsafeUnauthenticatedLanAllowed = (env = process.env) =>
  env?.OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN === 'true';

export const getUnauthenticatedLanErrorMessage = (host) =>
  `OpenChamber refuses to bind to ${host || 'a network-exposed host'} without UI authentication. `
  + 'Set --ui-password or OPENCHAMBER_UI_PASSWORD before exposing it over LAN, '
  + 'or set OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true to accept the risk.';
