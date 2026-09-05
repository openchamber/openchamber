import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';

import { createDevTunnelClient } from './client.js';
import { createDevTunnelRuntime, isDevTunnelPath } from './runtime.js';

/**
 * These exercise the real socket path end to end: a dev server, an OpenChamber
 * host tunnelling to it, and a client binding a local port. Anything less would
 * not prove the thing that matters — that a page loads over the tunnel exactly
 * as it does locally.
 */

const started = [];

const listen = (server, host = '127.0.0.1') => new Promise((resolve) => {
  server.listen(0, host, () => resolve(server.address().port));
});

const trackSockets = (server) => {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return sockets;
};

const stopServer = (server, sockets) => async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
};

const startDevServer = async (handler) => {
  const server = http.createServer(handler);
  const sockets = trackSockets(server);
  const port = await listen(server);
  started.push(stopServer(server, sockets));
  return port;
};

const startHost = async ({ allowedPorts, auth = null, discoveryOk = true }) => {
  const server = http.createServer((_req, res) => res.end('host'));
  const sockets = trackSockets(server);
  const port = await listen(server);
  const runtime = createDevTunnelRuntime({
    server,
    discoverDevServers: async () => (discoveryOk
      ? {
        ok: true,
        servers: allowedPorts.map((value) => ({ port: value, url: `http://localhost:${value}/`, command: 'node', pid: 1 })),
      }
      : { ok: false, reason: 'no-listener-source' }),
    uiAuthController: auth ?? { enabled: false },
    isRequestOriginAllowed: async (req) => req.headers.origin === 'http://allowed.example',
    rejectWebSocketUpgrade: (socket, status, message) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
      socket.destroy();
    },
    logger: { warn: () => {} },
  });
  started.push(async () => {
    runtime.dispose();
    await stopServer(server, sockets)();
  });
  return { port, baseUrl: `http://127.0.0.1:${port}`, runtime, sockets };
};

const httpGet = (port, path = '/') => new Promise((resolve, reject) => {
  const request = http.get({ host: '127.0.0.1', port, path }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
  });
  request.on('error', reject);
  request.setTimeout(5_000, () => request.destroy(new Error('timeout')));
});

afterEach(async () => {
  while (started.length) {
    const stop = started.pop();
    await stop();
  }
});

describe('dev tunnel path matching', () => {
  test('only claims its own upgrade path', () => {
    expect(isDevTunnelPath('/api/dev-tunnel?port=5173')).toBe(true);
    expect(isDevTunnelPath('/api/terminal/ws')).toBe(false);
    expect(isDevTunnelPath('')).toBe(false);
  });
});

describe('dev tunnel end to end', () => {
  test('serves the dev server through a local port, unmodified', async () => {
    const devPort = await startDevServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.setHeader('x-dev-header', 'kept');
      res.end(`<html><body>path:${req.url}</body></html>`);
    });
    const host = await startHost({ allowedPorts: [devPort] });

    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());
    const { localPort } = await client.open({ baseUrl: host.baseUrl, port: devPort });

    const response = await httpGet(localPort, '/some/page?q=1');
    expect(response.status).toBe(200);
    expect(response.body).toBe('<html><body>path:/some/page?q=1</body></html>');
    expect(response.headers['x-dev-header']).toBe('kept');
  });

  test('drops a connection that floods a handshake that never completes', async () => {
    // A host that accepts the TCP connection and then says nothing: the
    // WebSocket handshake hangs, which is when buffering could run away.
    const stalled = net.createServer(() => {});
    const stalledSockets = trackSockets(stalled);
    const stalledPort = await listen(stalled);
    started.push(stopServer(stalled, stalledSockets));

    const client = createDevTunnelClient({
      logger: { warn: () => {} },
      handshakeTimeoutMs: 300,
    });
    started.push(() => client.closeAll());
    const { localPort } = await client.open({ baseUrl: `http://127.0.0.1:${stalledPort}`, port: 4321 });

    const closed = await new Promise((resolve) => {
      const socket = net.createConnection({ port: localPort, host: '127.0.0.1' }, () => {
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        const write = () => {
          // Keep writing while the handshake hangs; the tunnel must stop this
          // rather than hold every byte in the desktop app's memory.
          if (socket.destroyed) return;
          socket.write(chunk, () => setTimeout(write, 1));
        };
        write();
      });
      socket.on('close', () => resolve(true));
      socket.on('error', () => resolve(true));
      setTimeout(() => resolve(false), 3_000);
    });

    expect(closed).toBe(true);
  });

  test('reuses one listener for repeat opens of the same target', async () => {
    const devPort = await startDevServer((_req, res) => res.end('ok'));
    const host = await startHost({ allowedPorts: [devPort] });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const first = await client.open({ baseUrl: host.baseUrl, port: devPort });
    const second = await client.open({ baseUrl: host.baseUrl, port: devPort });

    expect(second.localPort).toBe(first.localPort);
    expect(second.reused).toBe(true);
  });

  test('refuses a port discovery does not report, so it is not a loopback proxy', async () => {
    const secret = await startDevServer((_req, res) => res.end('secret service'));
    const host = await startHost({ allowedPorts: [] });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const { localPort } = await client.open({ baseUrl: host.baseUrl, port: secret });
    await expect(httpGet(localPort, '/')).rejects.toThrow();
  });

  test('closing a tunnel frees its local port', async () => {
    const devPort = await startDevServer((_req, res) => res.end('ok'));
    const host = await startHost({ allowedPorts: [devPort] });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });

    const { localPort } = await client.open({ baseUrl: host.baseUrl, port: devPort });
    expect(client.close({ baseUrl: host.baseUrl, port: devPort })).toBe(true);
    expect(client.list()).toEqual([]);

    // The port is free again: binding it back succeeds.
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(localPort, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  });

  test('rejects an invalid remote port before binding anything', async () => {
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    await expect(client.open({ baseUrl: 'http://127.0.0.1:1', port: 0 })).rejects.toThrow('valid remote port');
    await expect(client.open({ baseUrl: '', port: 5173 })).rejects.toThrow('base URL');
    expect(client.list()).toEqual([]);
  });

  test('rejects a non-http(s) base URL instead of crashing on first connection', async () => {
    // A non-special scheme survives the `ws:` protocol assignment (WHATWG URL
    // ignores it), so `new WebSocket(...)` used to throw inside the connection
    // handler and take the whole process down.
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    await expect(client.open({ baseUrl: 'openchamber-ui://index', port: 5173 })).rejects.toThrow('must be http(s)');
    expect(client.list()).toEqual([]);
  });

  // Not covered here: recovery after a request the dev server kills mid-flight.
  // The behaviour is real (each connection tears down independently), but the
  // abandoned socket makes this harness's teardown unreliable, and a flaky test
  // is worse than a documented gap. Verify it by hand against a restarting dev
  // server.
});

/**
 * The desktop shell dials this from the main process, where there is no browser
 * and therefore no Origin header. Requiring one — as the browser-facing sockets
 * rightly do — silently rejected every tunnel and surfaced as an empty response
 * in the panel, with nothing to connect it back to authentication.
 */
describe('dev tunnel authentication', () => {
  const clientAuth = {
    enabled: true,
    resolveAuthContext: async (req) => (
      req.headers.authorization === 'Bearer good' ? { type: 'client' } : null
    ),
  };
  const sessionAuth = {
    enabled: true,
    resolveAuthContext: async () => ({ type: 'session' }),
  };
  const urlTokenAuth = {
    enabled: true,
    resolveAuthContext: async (req, _res, options) => (
      options?.allowUrlToken === true && req.url.includes('oc_url_token=good') ? { type: 'client', token: 'url:authenticated' } : null
    ),
  };

  test('accepts a bearer-authenticated client that sends no origin', async () => {
    const devPort = await startDevServer((_req, res) => res.end('ok'));
    const host = await startHost({ allowedPorts: [devPort], auth: clientAuth });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const { localPort } = await client.open({
      baseUrl: host.baseUrl,
      port: devPort,
      headers: { Authorization: 'Bearer good' },
    });
    expect((await httpGet(localPort, '/')).body).toBe('ok');
  });

  test('accepts a URL-token client carried by the E2EE relay', async () => {
    const devPort = await startDevServer((_req, res) => res.end('relay-ok'));
    const host = await startHost({ allowedPorts: [devPort], auth: urlTokenAuth });

    const body = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${host.port}/api/dev-tunnel?port=${devPort}&oc_url_token=good`);
      socket.on('open', () => socket.send('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      socket.on('message', (data) => resolve(Buffer.from(data).toString()));
      socket.on('error', reject);
    });
    expect(body).toContain('relay-ok');
  });

  test('rejects a client with no credentials', async () => {
    const devPort = await startDevServer((_req, res) => res.end('ok'));
    const host = await startHost({ allowedPorts: [devPort], auth: clientAuth });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const { localPort } = await client.open({ baseUrl: host.baseUrl, port: devPort });
    await expect(httpGet(localPort, '/')).rejects.toThrow();
  });

  test('still refuses a session-authenticated request that sends no origin', async () => {
    // Only an explicit bearer may skip the origin check; ambient session
    // credentials are exactly what the origin check exists to protect.
    const devPort = await startDevServer((_req, res) => res.end('ok'));
    const host = await startHost({ allowedPorts: [devPort], auth: sessionAuth });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const { localPort } = await client.open({ baseUrl: host.baseUrl, port: devPort });
    await expect(httpGet(localPort, '/')).rejects.toThrow();
  });

  test('rejects a disallowed origin even with valid credentials', async () => {
    const devPort = await startDevServer((_req, res) => res.end('ok'));
    const host = await startHost({ allowedPorts: [devPort], auth: clientAuth });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const { localPort } = await client.open({
      baseUrl: host.baseUrl,
      port: devPort,
      headers: { Authorization: 'Bearer good', Origin: 'http://evil.example' },
    });
    await expect(httpGet(localPort, '/')).rejects.toThrow();
  });

  test('refuses every port when discovery itself is unavailable', async () => {
    const devPort = await startDevServer((_req, res) => res.end('ok'));
    const host = await startHost({ allowedPorts: [devPort], discoveryOk: false });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const { localPort } = await client.open({ baseUrl: host.baseUrl, port: devPort });
    await expect(httpGet(localPort, '/')).rejects.toThrow();
  });
});
