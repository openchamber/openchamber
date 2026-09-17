import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';

const ALWAYS_DENIED_V4 = new net.BlockList();
const ALWAYS_DENIED_V6 = new net.BlockList();
const GRANTABLE_PRIVATE_V4 = new net.BlockList();
const GRANTABLE_PRIVATE_V6 = new net.BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) ALWAYS_DENIED_V4.addSubnet(network, prefix, 'ipv4');

for (const [network, prefix] of [
  ['::', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['::ffff:0:0', 96],
]) ALWAYS_DENIED_V6.addSubnet(network, prefix, 'ipv6');

for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]) GRANTABLE_PRIVATE_V4.addSubnet(network, prefix, 'ipv4');
GRANTABLE_PRIVATE_V6.addAddress('::1', 'ipv6');

const normalizeHost = (host) => String(host || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
const addressFamily = (address) => net.isIP(address) === 6 ? 'ipv6' : 'ipv4';

const deniedAddressReason = (address) => {
  const family = addressFamily(address);
  if (!net.isIP(address)) return 'DNS returned an invalid address';
  const alwaysDenied = family === 'ipv6'
    ? ALWAYS_DENIED_V6.check(address, family)
    : ALWAYS_DENIED_V4.check(address, family);
  if (alwaysDenied) {
    if (family === 'ipv6' && address.toLowerCase().startsWith('::ffff:')) return 'IPv4-mapped and transition addresses are denied';
    if (family === 'ipv6' && address.toLowerCase().startsWith('fe')) return 'IPv6 link-local addresses are denied';
    if (family === 'ipv6' && /^[fd]/i.test(address)) return 'IPv6 unique-local addresses are denied';
    if (family === 'ipv6' && (address.toLowerCase().startsWith('2002:') || address.toLowerCase().startsWith('2001:') || address.toLowerCase().startsWith('64:ff9b:'))) return 'IPv6 transition addresses are denied';
    if (family === 'ipv4' && address.startsWith('169.254.')) return 'IPv4 link-local addresses are denied';
    return 'Unspecified, multicast, CGNAT, or reserved addresses are denied';
  }
  return null;
};

const hasGrant = (grants, hostname, address, port) => grants.some((grant) => {
  if (Number(grant?.port) !== port) return false;
  const grantedHost = normalizeHost(grant?.host ?? grant?.hostname);
  return grantedHost === hostname || grantedHost === normalizeHost(address);
});

const loadGrants = async (policy) => {
  const grants = [...(policy.grants ?? [])];
  if (typeof policy.discoverDevServers === 'function') {
    const discovered = await policy.discoverDevServers();
    if (discovered?.ok && Array.isArray(discovered.servers)) {
      for (const server of discovered.servers) {
        if (Number.isInteger(server?.port) && server.port > 0 && server.port <= 65535) {
          grants.push({ host: '127.0.0.1', port: server.port });
        }
      }
    }
  }
  if (typeof policy.discoverTunnelHosts === 'function') {
    const tunnels = await policy.discoverTunnelHosts();
    for (const tunnel of Array.isArray(tunnels) ? tunnels : []) {
      if (Number.isInteger(tunnel?.port) && tunnel.port > 0 && tunnel.port <= 65535) {
        grants.push({ host: '127.0.0.1', port: tunnel.port });
      }
    }
  }
  return grants;
};

const loadTunnelHosts = async (policy) => {
  const hosts = [...(policy.tunnelHosts ?? [])];
  if (typeof policy.discoverTunnelHosts !== 'function') return hosts;
  const discovered = await policy.discoverTunnelHosts();
  return Array.isArray(discovered) ? hosts.concat(discovered) : hosts;
};

/**
 * Classify one absolute proxy target and return the validated, pinned address.
 * A denied result is safe to expose as the body of a 403 response.
 *
 * @param {string|URL} target
 * @param {{grants?: Array<{host?: string, hostname?: string, port: number}>, tunnelHosts?: Array<{hostname: string, port: number}>, discoverDevServers?: Function, lookup?: Function}} policy
 */
export async function classifyProxyTarget(target, policy = {}) {
  let parsed;
  try {
    parsed = target instanceof URL ? new URL(target) : new URL(String(target));
  } catch {
    return { allowed: false, reason: 'Invalid proxy target' };
  }

  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return { allowed: false, reason: 'Unsupported proxy target protocol' };
  }

  let hostname = normalizeHost(parsed.hostname);
  let port = Number(parsed.port || (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80));
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { allowed: false, reason: 'Invalid proxy target authority' };
  }
  if (hostname === 'metadata.google.internal') {
    return { allowed: false, reason: 'Cloud metadata host is denied' };
  }

  const grants = await loadGrants(policy);
  if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') {
    const tunnel = (await loadTunnelHosts(policy)).find((entry) => normalizeHost(entry?.hostname) === hostname);
    if (tunnel && hasGrant(grants, '127.0.0.1', '127.0.0.1', Number(tunnel.port))) {
      hostname = '127.0.0.1';
      port = Number(tunnel.port);
    }
  }

  let answers;
  if (hostname === 'localhost' && hasGrant(grants, '127.0.0.1', '127.0.0.1', port)) {
    answers = [{ address: '127.0.0.1', family: 4 }];
  } else if (net.isIP(hostname)) {
    answers = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      const lookup = policy.lookup ?? dns.promises.lookup;
      answers = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      return { allowed: false, reason: 'DNS resolution failed' };
    }
  }
  if (!Array.isArray(answers) || answers.length === 0) return { allowed: false, reason: 'DNS returned no addresses' };

  for (const answer of answers) {
    const address = normalizeHost(answer?.address);
    const alwaysDenied = deniedAddressReason(address);
    if (alwaysDenied) return { allowed: false, reason: alwaysDenied };
    const family = addressFamily(address);
    const privateAddress = family === 'ipv6'
      ? GRANTABLE_PRIVATE_V6.check(address, family)
      : GRANTABLE_PRIVATE_V4.check(address, family);
    if (privateAddress && !hasGrant(grants, hostname, address, port)) {
      return { allowed: false, reason: 'Private or loopback address requires a session grant' };
    }
  }

  const pinned = answers[0];
  return {
    allowed: true,
    hostname,
    address: normalizeHost(pinned.address),
    family: Number(pinned.family) || net.isIP(pinned.address),
    port,
    url: parsed,
  };
}

const denyHttp = (response, reason) => {
  response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
  response.end(`Forbidden: ${reason}\n`);
};

const denySocket = (socket, reason, status = '403 Forbidden') => {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nForbidden: ${reason}\n`);
};

/**
 * Create one loopback-only forward proxy with policy and socket ownership bound
 * to a browser session. Call listen(), pass proxyServer to CDP, then close().
 */
export function createPolicyProxy(policy = {}) {
  const downstreamSockets = new Set();
  const upstreamSockets = new Set();
  let closePromise = null;
  let listening = false;
  let closed = false;

  const track = (set, socket) => {
    set.add(socket);
    socket.once('close', () => set.delete(socket));
    return socket;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const decision = await classifyProxyTarget(request.url, policy);
      if (closed) return denyHttp(response, 'Session proxy is closed');
      if (!decision.allowed) return denyHttp(response, decision.reason);
      if (decision.url.protocol !== 'http:') return denyHttp(response, 'Plain proxy requests must use HTTP');

      const headers = { ...request.headers, host: decision.url.host };
      delete headers['proxy-connection'];
      const upstream = http.request({
        hostname: decision.address,
        family: decision.family,
        port: decision.port,
        method: request.method,
        path: `${decision.url.pathname}${decision.url.search}`,
        headers,
        agent: false,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.on('socket', (socket) => track(upstreamSockets, socket));
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { Connection: 'close' });
        response.end();
      });
      request.pipe(upstream);
    })().catch(() => denyHttp(response, 'Proxy classification failed'));
  });

  server.on('connection', (socket) => track(downstreamSockets, socket));
  server.on('connect', (request, client, head) => {
    void (async () => {
      const decision = await classifyProxyTarget(`https://${request.url}`, policy);
      if (closed) return client.destroy();
      if (!decision.allowed) return denySocket(client, decision.reason);
      const upstream = track(upstreamSockets, net.connect({
        host: decision.address,
        family: decision.family,
        port: decision.port,
      }));
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.once('error', () => denySocket(client, 'Upstream connection failed', '502 Bad Gateway'));
    })().catch(() => denySocket(client, 'Proxy classification failed'));
  });

  server.on('upgrade', (request, client, head) => {
    void (async () => {
      const decision = await classifyProxyTarget(request.url, policy);
      if (closed) return client.destroy();
      if (!decision.allowed) return denySocket(client, decision.reason);
      if (decision.url.protocol !== 'ws:') return denySocket(client, 'Plain upgrades must use WebSocket');
      const upstream = track(upstreamSockets, net.connect({ host: decision.address, family: decision.family, port: decision.port }));
      upstream.once('connect', () => {
        const headers = [...request.rawHeaders];
        const hostIndex = headers.findIndex((name) => name.toLowerCase() === 'host');
        if (hostIndex >= 0) headers[hostIndex + 1] = decision.url.host;
        let raw = `${request.method} ${decision.url.pathname}${decision.url.search} HTTP/${request.httpVersion}\r\n`;
        for (let index = 0; index < headers.length; index += 2) raw += `${headers[index]}: ${headers[index + 1]}\r\n`;
        upstream.write(`${raw}\r\n`);
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.once('error', () => denySocket(client, 'Upstream connection failed', '502 Bad Gateway'));
    })().catch(() => denySocket(client, 'Proxy classification failed'));
  });

  return {
    get proxyServer() {
      const address = server.address();
      if (!address || typeof address === 'string') return null;
      return `127.0.0.1:${address.port}`;
    },
    async listen() {
      if (listening) return this.proxyServer;
      if (closed) throw new Error('Session proxy is closed');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      listening = true;
      return this.proxyServer;
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = new Promise((resolve) => {
        if (listening) server.close(resolve);
        else resolve();
        for (const socket of downstreamSockets) socket.destroy();
        for (const socket of upstreamSockets) socket.destroy();
        listening = false;
      });
      return closePromise;
    },
  };
}
