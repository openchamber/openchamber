const LOOPBACK_IPV4_HOST = '127.0.0.1';
const LOOPBACK_IPV6_HOST = '::1';

export const resolveManagedOpenCodeConnectHostname = (hostname) => {
  const raw = typeof hostname === 'string' ? hostname.trim() : '';
  const resolved = raw || LOOPBACK_IPV4_HOST;
  if (resolved === '0.0.0.0') return LOOPBACK_IPV4_HOST;
  if (resolved === '::' || resolved === '[::]') return LOOPBACK_IPV6_HOST;
  if (resolved.startsWith('[') && resolved.endsWith(']')) return resolved.slice(1, -1);
  return resolved;
};

export const buildManagedOpenCodeOrigin = ({ hostname, port } = {}) => {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new TypeError('Managed OpenCode origin requires a valid port');
  }
  const resolvedHost = resolveManagedOpenCodeConnectHostname(hostname);
  const formattedHost = resolvedHost.includes(':') && !resolvedHost.startsWith('[')
    ? `[${resolvedHost}]`
    : resolvedHost;
  return `http://${formattedHost}:${port}`;
};
