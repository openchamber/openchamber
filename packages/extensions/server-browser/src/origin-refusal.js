import net from 'node:net';

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('0.0.0.0', 'ipv4');
loopback.addAddress('::1', 'ipv6');
loopback.addAddress('::', 'ipv6');
loopback.addAddress('::ffff:0.0.0.0', 'ipv6');
loopback.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

const endpointKey = (url) => {
  const protocol = url.protocol.replace(/^ws/, 'http');
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  const address = hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(address);
  const local = hostname === 'localhost' || hostname.endsWith('.localhost')
    || (family !== 0 && loopback.check(address, family === 4 ? 'ipv4' : 'ipv6'));
  const port = url.port || (protocol === 'https:' ? '443' : '80');
  // CONNECT exposes only host and port. Refuse the same server endpoint even
  // when the tunnel is classified as HTTPS for a plain HTTP/WebSocket service.
  return `${local ? 'loopback' : hostname}:${port}`;
};

// Host policy is deliberately independent of user-controlled egress grants.
export const createOriginRefusal = (origins) => {
  if (!Array.isArray(origins)) throw new Error('OpenChamber origins must be an array');
  const protectedOrigins = new Set(origins.map((value) => {
    if (typeof value !== 'string') throw new Error('Invalid OpenChamber origin');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid OpenChamber origin');
    return endpointKey(url);
  }));
  return (value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return true;
    }
    return url.protocol === 'file:' || protectedOrigins.has(endpointKey(url));
  };
};
