import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { createOriginRefusal } from './origin-refusal.js';

const ALWAYS_DENIED_V4 = new net.BlockList();
const ALWAYS_DENIED_V6 = new net.BlockList();
const PRIVATE_V4 = new net.BlockList();
const PRIVATE_V6 = new net.BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) ALWAYS_DENIED_V4.addSubnet(network, prefix, 'ipv4');

for (const [network, prefix] of [
  ['::', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96],
]) ALWAYS_DENIED_V6.addSubnet(network, prefix, 'ipv6');

for (const [network, prefix] of [
  ['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16],
]) PRIVATE_V4.addSubnet(network, prefix, 'ipv4');
PRIVATE_V6.addAddress('::1', 'ipv6');

const normalizeHost = (host) => String(host || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
const familyOf = (address) => net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
export const isPrivateAddress = (address) => (familyOf(address) === 'ipv6'
  ? PRIVATE_V6.check(address, 'ipv6')
  : PRIVATE_V4.check(address, 'ipv4'));

const permanentlyDenied = (address) => {
  const family = familyOf(address);
  if (!net.isIP(address)) return 'DNS returned an invalid address';
  const denied = family === 'ipv6'
    ? ALWAYS_DENIED_V6.check(address, family)
    : ALWAYS_DENIED_V4.check(address, family);
  if (!denied) return null;
  if (family === 'ipv6' && address.toLowerCase().startsWith('::ffff:')) {
    return 'IPv4-mapped addresses are denied';
  }
  if (family === 'ipv4' && address.startsWith('169.254.')) return 'IPv4 link-local addresses are denied';
  return 'Unspecified, link-local, transition, multicast, CGNAT, or reserved addresses are denied';
};

const grantProtocol = (protocol) => protocol === 'ws:' ? 'http:' : protocol === 'wss:' ? 'https:' : protocol;

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

// A host grant matches the name the page asked for, never an address that name
// resolves to, so a domain that resolves or rebinds to a granted address stays
// blocked. localhost may use a loopback address's grant because the proxy pins
// it below instead of asking DNS. Network blocks match by address.
const hasGrant = (grants, hostname, address, port, protocol) => grants.some((grant) => {
  if (grant.block) {
    return grant.ports.some(([first, last]) => port >= first && port <= last) && grant.block.check(address, familyOf(address));
  }
  const host = normalizeHost(grant.host);
  return grant.port === port
    && (!grant.protocol || grant.protocol === grantProtocol(protocol))
    && (host === hostname || (hostname === 'localhost' && host === address && LOOPBACK_ADDRESSES.includes(address)));
});

// When private addresses are allowed wholesale, `localhost` goes to whichever
// loopback family has a listener on the port, IPv4 first, like a browser would
// after falling back.
const loopbackListening = (address, port, timeoutMs = 300) => new Promise((resolve) => {
  const socket = net.connect({ host: address, port });
  const done = (result) => { socket.destroy(); resolve(result); };
  socket.setTimeout(timeoutMs, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

export const classifyProxyTarget = async (target, {
  grants = [],
  devServerGrants = null,
  allowPrivateNetwork = null,
  openchamberOrigins = [],
  lookup = dns.promises.lookup,
} = {}) => {
  let url;
  try {
    url = target instanceof URL ? new URL(target) : new URL(String(target));
  } catch {
    return { allowed: false, reason: 'Invalid proxy target' };
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    return { allowed: false, reason: 'Unsupported proxy target protocol' };
  }
  if (createOriginRefusal(openchamberOrigins)(url.href)) {
    return { allowed: false, reason: 'OpenChamber endpoint is denied' };
  }
  const hostname = normalizeHost(url.hostname);
  const port = Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80));
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { allowed: false, reason: 'Invalid proxy target authority' };
  }
  if (hostname === 'metadata.google.internal') {
    return { allowed: false, reason: 'Cloud metadata host is denied' };
  }

  // Live development servers are looked up only when a private target needs a grant.
  let resolvedGrants = null;
  const grantsFor = async () => {
    resolvedGrants ??= devServerGrants ? [...grants, ...await devServerGrants()] : grants;
    return resolvedGrants;
  };

  // Read per request: the setting can change while browsers are open.
  const privateAllowed = typeof allowPrivateNetwork === 'function' ? allowPrivateNetwork() === true : allowPrivateNetwork === true;

  let answers;
  if (privateAllowed && hostname === 'localhost') {
    for (const candidate of ['127.0.0.1', '::1']) {
      if (await loopbackListening(candidate, port)) {
        answers = [{ address: candidate, family: net.isIP(candidate) }];
        break;
      }
    }
  }
  // An exact localhost request uses the loopback family that has a grant, so
  // a server listening on only one of them still works when DNS lists both.
  if (!answers && hostname === 'localhost') {
    const granted = await grantsFor();
    const address = LOOPBACK_ADDRESSES.find((candidate) => hasGrant(granted, hostname, candidate, port, url.protocol));
    if (address) answers = [{ address, family: net.isIP(address) }];
  }
  if (!answers && net.isIP(hostname)) {
    answers = [{ address: hostname, family: net.isIP(hostname) }];
  } else if (!answers) {
    try {
      answers = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      return { allowed: false, reason: 'DNS resolution failed' };
    }
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    return { allowed: false, reason: 'DNS returned no addresses' };
  }
  for (const answer of answers) {
    const address = normalizeHost(answer?.address);
    const reason = permanentlyDenied(address);
    if (reason) return { allowed: false, reason };
    if (isPrivateAddress(address) && !privateAllowed && !hasGrant(await grantsFor(), hostname, address, port, url.protocol)) {
      return { allowed: false, reason: 'Private or loopback address requires an allowed origin', grantable: true };
    }
  }
  const pinned = answers[0];
  return {
    allowed: true,
    address: normalizeHost(pinned.address),
    family: Number(pinned.family) || net.isIP(pinned.address),
    port,
    url,
  };
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const originOf = (target) => {
  try {
    const { origin } = new URL(target);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
};

const isLoopbackOrigin = (origin) => {
  try {
    return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(new URL(origin).hostname);
  } catch {
    return false;
  }
};

const deniedPage = (reason, { origin = null, grantable = false, configPath = null, discoverDevServers = false, projectDirectory = null }) => {
  const shownOrigin = origin ? `<code>${escapeHtml(origin)}</code>` : '';
  const configFile = configPath ? `<code>${escapeHtml(configPath)}</code>` : 'the extension\'s <code>config.json</code>';
  const project = projectDirectory
    ? `<p>Development servers started inside this chat's project, <code>${escapeHtml(projectDirectory)}</code>, open without configuration; no server started there is listening on this port.</p>`
    : '';
  // Discovery only grants loopback listeners, so it is only mentioned for them.
  const discovery = !isLoopbackOrigin(origin) ? ''
    : discoverDevServers
      ? `${project}<p>Development-server discovery is on, but no eligible server is listening on this port. Servers run by OpenChamber itself, OpenCode, or this extension are never granted.</p>`
      : `${project}<p>To reach local development servers without listing each one, set <code>"discoverDevServers": true</code> instead.</p>`;
  const [title, content] = grantable && origin ? [
    `Blocked: ${origin}`,
    `<h1>This private address is blocked</h1>
<p>To open your own development servers, turn on <b>Allow localhost and private addresses</b> in OpenChamber's Settings → Browser.</p>
<p>${shownOrigin} points to the machine running OpenChamber or its local network. Server Browser blocks private and loopback addresses until you allow them, so pages and agents cannot reach those services without permission.</p>
<p>To allow it, add the origin to <code>allowedOrigins</code> in ${configFile} and restart the extension:</p>
<pre>${escapeHtml(`{\n  "allowedOrigins": [${JSON.stringify(origin)}]\n}`)}</pre>
<p>For several machines or ports, add a private CIDR block and its ports to <code>allowedNetworks</code> instead.</p>
${discovery}
<p class="note"><code>localhost</code> and private addresses resolve on the machine running OpenChamber, not on your device.</p>`,
  ] : [
    `Can't open ${origin ?? 'this address'}`,
    `<h1>This address can't be opened</h1>
<p>${shownOrigin ? `${shownOrigin}: ` : ''}${escapeHtml(reason)}.</p>`,
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; font: 15px/1.55 system-ui, sans-serif; }
body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: Canvas; color: CanvasText; }
main { box-sizing: border-box; width: 100%; max-width: 560px; padding: 32px 24px; }
small { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; opacity: .55; }
h1 { margin: 6px 0 12px; font-size: 20px; line-height: 1.3; }
p, pre { margin: 0 0 12px; }
code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { overflow-wrap: anywhere; }
pre { padding: 12px 14px; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 8px; background: rgba(127, 127, 127, .12); }
.note { font-size: 13px; opacity: .7; }
</style>
</head>
<body><main><small>Server Browser</small>
${content}
</main></body>
</html>
`;
};

const denyHttp = (response, reason, page = {}) => {
  response.writeHead(403, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(deniedPage(reason, page));
};

const denySocket = (socket, reason, status = '403 Forbidden') => {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nForbidden: ${reason}\n`);
};

export const createPolicyProxy = (policy = {}) => {
  const downstreamSockets = new Set();
  const upstreamSockets = new Set();
  let listening = false;
  let closed = false;
  let closePromise = null;

  const track = (collection, socket) => {
    collection.add(socket);
    socket.once('close', () => collection.delete(socket));
    return socket;
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      let upstream = null;
      let downstreamClosed = request.aborted || response.destroyed;
      const closeDownstream = () => {
        downstreamClosed = true;
        upstream?.destroy();
      };
      request.once('aborted', closeDownstream);
      response.once('close', closeDownstream);
      const decision = await classifyProxyTarget(request.url, policy);
      await new Promise((resolve) => setImmediate(resolve));
      if (downstreamClosed || response.writableEnded) return;
      if (closed) return denyHttp(response, 'Browser proxy is closed');
      if (!decision.allowed) {
        return denyHttp(response, decision.reason, {
          origin: originOf(request.url),
          grantable: decision.grantable,
          configPath: policy.configPath,
          discoverDevServers: policy.discoverDevServers ?? Boolean(policy.devServerGrants),
          projectDirectory: policy.projectDirectory ?? null,
        });
      }
      if (decision.url.protocol !== 'http:') return denyHttp(response, 'Plain proxy requests must use HTTP');
      const headers = { ...request.headers, host: decision.url.host };
      delete headers['proxy-connection'];
      upstream = http.request({
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
        if (!response.headersSent) response.writeHead(502, { connection: 'close' });
        response.end();
      });
      request.pipe(upstream);
    })().catch(() => denyHttp(response, 'Proxy classification failed'));
  });

  server.on('connection', (socket) => {
    track(downstreamSockets, socket);
    socket.on('error', () => socket.destroy());
  });
  server.on('connect', (request, client, head) => {
    void (async () => {
      let upstream = null;
      let downstreamClosed = client.destroyed;
      client.once('close', () => {
        downstreamClosed = true;
        upstream?.destroy();
      });
      const decision = await classifyProxyTarget(`https://${request.url}`, policy);
      await new Promise((resolve) => setImmediate(resolve));
      if (downstreamClosed) return;
      if (closed) return client.destroy();
      if (!decision.allowed) return denySocket(client, decision.reason);
      upstream = track(upstreamSockets, net.connect({
        host: decision.address,
        family: decision.family,
        port: decision.port,
      }));
      upstream.once('close', () => client.destroy());
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
      let upstream = null;
      let downstreamClosed = client.destroyed;
      client.once('close', () => {
        downstreamClosed = true;
        upstream?.destroy();
      });
      const decision = await classifyProxyTarget(request.url, policy);
      await new Promise((resolve) => setImmediate(resolve));
      if (downstreamClosed) return;
      if (closed) return client.destroy();
      if (!decision.allowed) return denySocket(client, decision.reason);
      if (decision.url.protocol !== 'ws:') return denySocket(client, 'Plain upgrades must use WebSocket');
      upstream = track(upstreamSockets, net.connect({
        host: decision.address,
        family: decision.family,
        port: decision.port,
      }));
      upstream.once('close', () => client.destroy());
      upstream.once('connect', () => {
        const lines = [`${request.method} ${decision.url.pathname}${decision.url.search} HTTP/${request.httpVersion}`];
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          const name = request.rawHeaders[index];
          const value = name.toLowerCase() === 'host' ? decision.url.host : request.rawHeaders[index + 1];
          lines.push(`${name}: ${value}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.once('error', () => denySocket(client, 'Upstream connection failed', '502 Bad Gateway'));
    })().catch(() => denySocket(client, 'Proxy classification failed'));
  });

  return {
    get address() {
      const value = server.address();
      return value && typeof value === 'object' ? `127.0.0.1:${value.port}` : null;
    },
    async listen() {
      if (listening) return this.address;
      if (closed) throw new Error('Browser proxy is closed');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      listening = true;
      return this.address;
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
};
