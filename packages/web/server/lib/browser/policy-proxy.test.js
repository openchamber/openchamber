import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';

import { classifyProxyTarget, createPolicyProxy } from './policy-proxy.js';

const cleanups = [];

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return address.port;
};

const startHttpServer = async (handler = (_req, res) => res.end('allowed')) => {
  const server = http.createServer(handler);
  return { server, port: await listen(server) };
};

const startTcpEcho = async () => {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => socket.write(`echo:${data}`));
  });
  const port = await listen(server);
  return { server, port, sockets, get connections() { return connections; } };
};

const startProxy = async (options = {}) => {
  const proxy = createPolicyProxy(options);
  await proxy.listen();
  cleanups.push(() => proxy.close());
  return proxy;
};

const proxyRequest = (proxyServer, target, options = {}) => new Promise((resolve, reject) => {
  const [host, port] = proxyServer.split(':');
  const request = http.request({
    hostname: host,
    port: Number(port),
    method: options.method ?? 'GET',
    path: target,
    headers: options.headers,
    agent: options.agent,
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({
      status: response.statusCode,
      body: Buffer.concat(chunks).toString(),
      headers: response.headers,
    }));
  });
  request.once('error', reject);
  request.end();
});

const connectTunnel = (proxyServer, authority, head = '') => new Promise((resolve, reject) => {
  const [host, port] = proxyServer.split(':');
  const socket = net.connect({ host, port: Number(port) });
  let received = '';
  socket.once('error', reject);
  socket.on('data', (chunk) => {
    received += chunk.toString();
    if (received.includes('echo:') || received.includes('403 Forbidden')) resolve({ socket, received });
  });
  socket.once('connect', () => {
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${head}`);
  });
});

const waitForClose = (socket) => new Promise((resolve) => {
  if (socket.destroyed) resolve();
  else socket.once('close', resolve);
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

describe('classifyProxyTarget', () => {
  const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }];

  it.each([
    ['http://169.254.169.254/latest/meta-data', 'link-local'],
    ['http://metadata.google.internal/', 'metadata'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://[fc00::1]/', 'unique-local'],
    ['http://[::ffff:127.0.0.1]/', 'transition'],
    ['http://[2002:7f00:1::]/', 'transition'],
  ])('always denies %s', async (target, reason) => {
    const result = await classifyProxyTarget(target, { lookup: lookupPublic });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it.each(['10.0.0.5', '127.0.0.1', '::1'])('requires a host-and-port grant for %s', async (host) => {
    const authority = net.isIPv6(host) ? `[${host}]:5173` : `${host}:5173`;
    const denied = await classifyProxyTarget(`http://${authority}/`);
    const allowed = await classifyProxyTarget(`http://${authority}/`, {
      grants: [{ host, port: 5173 }],
    });
    expect(denied.allowed).toBe(false);
    expect(allowed).toMatchObject({ allowed: true, port: 5173 });
  });

  it('denies every hostname answer when any answer is private', async () => {
    const result = await classifyProxyTarget('http://mixed.example/', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/private/i);
  });

  it.each(['http:', 'https:', 'ws:', 'wss:'])('pins localhost to its granted IPv4 listener for %s', async (protocol) => {
    let lookups = 0;
    const result = await classifyProxyTarget(`${protocol}//LOCALHOST.:5173/app`, {
      grants: [{ host: '127.0.0.1', port: 5173 }],
      lookup: async () => {
        lookups += 1;
        return [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
      },
    });

    expect(result).toMatchObject({ allowed: true, hostname: 'localhost', address: '127.0.0.1', family: 4, port: 5173 });
    expect(result.url.hostname).toBe('localhost.');
    expect(lookups).toBe(0);
  });

  it.each([
    ['http://localhost:5174/', '127.0.0.1'],
    ['http://[::1]:5173/', '127.0.0.1'],
    ['http://127.0.0.2:5173/', '127.0.0.1'],
    ['http://127.0.0.1:5173/', '::1'],
    ['http://localhost.example:5173/', '127.0.0.1'],
  ])('does not extend the loopback grant to %s', async (target, grantedHost) => {
    const result = await classifyProxyTarget(target, {
      grants: [{ host: grantedHost, port: 5173 }],
      lookup: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/grant/i);
  });

  it('rewrites own tunnel hostnames only for plain HTTP and WebSocket targets', async () => {
    const policy = {
      grants: [{ host: '127.0.0.1', port: 5173 }],
      tunnelHosts: [{ hostname: 'preview.example', port: 5173 }],
      lookup: lookupPublic,
    };
    const httpTarget = await classifyProxyTarget('http://preview.example/app', policy);
    const wsTarget = await classifyProxyTarget('ws://preview.example/socket', policy);
    const httpsTarget = await classifyProxyTarget('https://preview.example/app', policy);

    expect(httpTarget).toMatchObject({ allowed: true, hostname: '127.0.0.1', port: 5173 });
    expect(wsTarget).toMatchObject({ allowed: true, hostname: '127.0.0.1', port: 5173 });
    expect(httpsTarget).toMatchObject({ allowed: true, hostname: 'preview.example', address: '93.184.216.34', port: 443 });
  });
});

describe('policy proxy', () => {
  it('forwards granted plain HTTP and denies ungranted loopback', async () => {
    const upstream = await startHttpServer();
    const deniedProxy = await startProxy();
    const allowedProxy = await startProxy({ grants: [{ host: '127.0.0.1', port: upstream.port }] });

    const denied = await proxyRequest(deniedProxy.proxyServer, `http://127.0.0.1:${upstream.port}/`);
    const allowed = await proxyRequest(allowedProxy.proxyServer, `http://127.0.0.1:${upstream.port}/`);

    expect(denied.status).toBe(403);
    expect(denied.body).toMatch(/private/i);
    expect(allowed).toMatchObject({ status: 200, body: 'allowed' });
  });

  it('uses current dev-server discovery as the default grant source', async () => {
    const upstream = await startHttpServer();
    const proxy = await startProxy({
      discoverDevServers: async () => ({ ok: true, servers: [{ port: upstream.port }] }),
    });
    const response = await proxyRequest(proxy.proxyServer, `http://127.0.0.1:${upstream.port}/`);
    expect(response.status).toBe(200);
  });

  it('opens discovered localhost on an IPv4-only listener and revokes its stopped port', async () => {
    const upstream = await startHttpServer((req, res) => res.end(req.headers.host));
    let discovered = true;
    const proxy = await startProxy({
      discoverDevServers: async () => ({ ok: true, servers: discovered ? [{ port: upstream.port }] : [] }),
      lookup: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
    });
    const target = `http://localhost:${upstream.port}/`;

    const response = await proxyRequest(proxy.proxyServer, target);
    discovered = false;
    const stopped = await proxyRequest(proxy.proxyServer, target);

    expect(response).toMatchObject({ status: 200, body: `localhost:${upstream.port}` });
    expect(stopped.status).toBe(403);
  });

  it('connects localhost tunnels to the granted IPv4-only listener', async () => {
    const upstream = await startTcpEcho();
    const proxy = await startProxy({
      grants: [{ host: '127.0.0.1', port: upstream.port }],
      lookup: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }],
    });
    const { socket, received } = await connectTunnel(proxy.proxyServer, `localhost:${upstream.port}`, 'EARLY');
    socket.destroy();
    expect(received).toContain('200 Connection Established');
    expect(received).toContain('echo:EARLY');
  });

  it('pipes CONNECT end-to-end and preserves initial head bytes', async () => {
    const upstream = await startTcpEcho();
    const proxy = await startProxy({ grants: [{ host: '127.0.0.1', port: upstream.port }] });
    const { socket, received } = await connectTunnel(proxy.proxyServer, `127.0.0.1:${upstream.port}`, 'EARLY');
    expect(received).toContain('200 Connection Established');
    expect(received).toContain('echo:EARLY');
    socket.destroy();
  });

  it('denies CONNECT without creating an upstream socket', async () => {
    const upstream = await startTcpEcho();
    const proxy = await startProxy();
    const { socket, received } = await connectTunnel(proxy.proxyServer, `127.0.0.1:${upstream.port}`);
    expect(received).toContain('403 Forbidden');
    expect(upstream.connections).toBe(0);
    socket.destroy();
  });

  it('pins a validated DNS answer and re-checks DNS on the next request', async () => {
    const upstream = await startHttpServer();
    let lookups = 0;
    const proxy = await startProxy({
      grants: [{ host: 'flip.example', port: upstream.port }],
      lookup: async () => {
        lookups += 1;
        return lookups === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }];
      },
    });

    const first = await proxyRequest(proxy.proxyServer, `http://flip.example:${upstream.port}/`);
    const second = await proxyRequest(proxy.proxyServer, `http://flip.example:${upstream.port}/`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(lookups).toBe(2);
  });

  it('denies a public redirect when the browser follows it to private space', async () => {
    const privateUpstream = await startHttpServer();
    const publicUpstream = await startHttpServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${privateUpstream.port}/secret` }).end();
    });
    const proxy = await startProxy({ grants: [{ host: '127.0.0.1', port: publicUpstream.port }] });

    const first = await proxyRequest(proxy.proxyServer, `http://127.0.0.1:${publicUpstream.port}/`);
    const redirected = await proxyRequest(proxy.proxyServer, first.headers.location);
    expect(first.status).toBe(302);
    expect(redirected.status).toBe(403);
  });

  it('close destroys keep-alive sockets and established tunnels without affecting another session', async () => {
    const upstream = await startTcpEcho();
    const first = await startProxy({ grants: [{ host: '127.0.0.1', port: upstream.port }] });
    const second = await startProxy({ grants: [{ host: '127.0.0.1', port: upstream.port }] });
    const firstTunnel = await connectTunnel(first.proxyServer, `127.0.0.1:${upstream.port}`, 'one');
    const secondTunnel = await connectTunnel(second.proxyServer, `127.0.0.1:${upstream.port}`, 'two');

    const firstClosed = waitForClose(firstTunnel.socket);
    await first.close();
    await firstClosed;
    secondTunnel.socket.write('still-up');
    const reply = await new Promise((resolve) => secondTunnel.socket.once('data', (chunk) => resolve(chunk.toString())));
    expect(reply).toContain('echo:still-up');
    secondTunnel.socket.destroy();
  });

  it('close destroys accepted keep-alive sockets', async () => {
    const upstream = await startHttpServer();
    const proxy = await startProxy({ grants: [{ host: '127.0.0.1', port: upstream.port }] });
    const agent = new http.Agent({ keepAlive: true });
    await proxyRequest(proxy.proxyServer, `http://127.0.0.1:${upstream.port}/`, { agent });
    const socket = Object.values(agent.sockets)[0]?.[0] ?? Object.values(agent.freeSockets)[0]?.[0];
    expect(socket).toBeDefined();
    const closed = waitForClose(socket);
    await proxy.close();
    await closed;
    expect(socket.destroyed).toBe(true);
    agent.destroy();
  });
});
