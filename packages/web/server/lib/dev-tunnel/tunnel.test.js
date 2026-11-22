import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';

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

const startDevServer = async (handler, host = '127.0.0.1') => {
  const server = http.createServer(handler);
  const sockets = trackSockets(server);
  const port = await listen(server, host);
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

  test('reaches a dev server that listens on IPv6 loopback only', async () => {
    // `localhost` resolves to ::1 first on many systems, so a dev server started
    // with its defaults often never binds 127.0.0.1. Discovery lists it anyway.
    const devPort = await startDevServer((req, res) => res.end(`v6:${req.url}`), '::1');
    const host = await startHost({ allowedPorts: [devPort] });
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());

    const { localPort } = await client.open({ baseUrl: host.baseUrl, port: devPort });
    const response = await httpGet(localPort, '/page');
    expect(response.status).toBe(200);
    expect(response.body).toBe('v6:/page');
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

  test('a space tunnel names the space\'s root on the host, and is a tunnel of its own', async () => {
    // The host forwards a tunnel that names `/spaces/<id>` into the space; what matters
    // here is that the client asks for exactly that, under its own key.
    const paths = [];
    const server = http.createServer((_req, res) => res.end('host'));
    const sockets = trackSockets(server);
    server.on('upgrade', (req, socket) => {
      paths.push(req.url);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    });
    const hostPort = await listen(server);
    started.push(stopServer(server, sockets));
    const baseUrl = `http://127.0.0.1:${hostPort}`;

    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());
    const space = await client.open({ baseUrl, port: 4321, spaceId: '84369ed6edda' });
    const host = await client.open({ baseUrl, port: 4321 });
    expect(space.localPort).not.toBe(host.localPort);
    expect(client.list()).toEqual([
      { localPort: space.localPort, remotePort: 4321, baseUrl, spaceId: '84369ed6edda' },
      { localPort: host.localPort, remotePort: 4321, baseUrl, spaceId: null },
    ]);

    await expect(httpGet(space.localPort, '/')).rejects.toThrow();
    await expect(httpGet(host.localPort, '/')).rejects.toThrow();
    expect(paths).toEqual([`/api/dev-tunnel?port=4321&directory=${encodeURIComponent('/spaces/84369ed6edda')}`, '/api/dev-tunnel?port=4321']);

    expect(client.close({ baseUrl, port: 4321, spaceId: '84369ed6edda' })).toBe(true);
    expect(client.list()).toEqual([{ localPort: host.localPort, remotePort: 4321, baseUrl, spaceId: null }]);
    await expect(client.open({ baseUrl, port: 4321, spaceId: '../etc' })).rejects.toThrow(/space id/);
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

  test('rejects a malformed remote port instead of coercing it to another port', async () => {
    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    await expect(client.open({ baseUrl: 'http://127.0.0.1:1', port: '8080junk' })).rejects.toThrow('valid remote port');
    await expect(client.open({ baseUrl: 'http://127.0.0.1:1', port: '80.9' })).rejects.toThrow('valid remote port');
    await expect(client.open({ baseUrl: 'http://127.0.0.1:1', port: 8080.5 })).rejects.toThrow('valid remote port');
    await expect(client.open({ baseUrl: 'http://127.0.0.1:1', port: '' })).rejects.toThrow('valid remote port');
    expect(client.list()).toEqual([]);
  });

  test('refuses a malformed port spelling that would coerce to a discovered port', async () => {
    const devPort = await startDevServer((_req, res) => res.end('secret service'));
    const host = await startHost({ allowedPorts: [devPort] });

    const body = await new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${host.port}/api/dev-tunnel?port=${devPort}junk`);
      const settle = (value) => { try { socket.close(); } catch { /* already closed */ } resolve(value); };
      socket.on('open', () => socket.send('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      socket.on('message', (data) => settle(Buffer.from(data).toString()));
      socket.on('error', () => settle(null));
      socket.on('close', () => settle(null));
      setTimeout(() => settle(null), 3_000);
    });
    expect(body).toBeNull();
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

describe('dev tunnel backpressure', () => {
  const CHUNK = 256 * 1024;

  test('client pauses the WebSocket when the local consumer stalls, then delivers everything', async () => {
    const TOTAL = 48 * 1024 * 1024;
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => wss.on('listening', resolve));
    started.push(async () => { await new Promise((resolve) => wss.close(resolve)); });
    let serverSocket = null;
    wss.on('connection', (ws) => {
      serverSocket = ws;
      const chunk = Buffer.alloc(CHUNK, 0x62);
      for (let sent = 0; sent < TOTAL; sent += CHUNK) ws.send(chunk);
    });

    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());
    const { localPort } = await client.open({ baseUrl: `http://127.0.0.1:${wss.address().port}`, port: 4321 });

    // The consumer connects and reads nothing: without backpressure the
    // client would buffer the whole flood in this process; with it the
    // WebSocket is paused and the run-ahead stays with the producer.
    const consumer = net.createConnection({ port: localPort, host: '127.0.0.1' });
    started.push(async () => { consumer.destroy(); });
    await new Promise((resolve) => consumer.on('connect', resolve));
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(serverSocket.bufferedAmount).toBeGreaterThan(16 * 1024 * 1024);

    let received = 0;
    await new Promise((resolve, reject) => {
      consumer.on('data', (chunk) => {
        received += chunk.length;
        if (received >= TOTAL) resolve();
      });
      consumer.on('error', reject);
      setTimeout(() => reject(new Error(`consumer received only ${received} of ${TOTAL} bytes`)), 10_000);
    });
    expect(received).toBe(TOTAL);
  }, 20_000);

  test('client pauses the local socket while the host WebSocket is not draining', async () => {
    const TOTAL = 48 * 1024 * 1024;
    // A host that completes the WebSocket handshake by hand and then reads
    // nothing: a real WebSocket server cannot be paused on every runtime,
    // and a host that never reads its socket is the stall being tested.
    let hostSocket = null;
    let hostReceived = 0;
    const hostServer = net.createServer((socket) => {
      hostSocket = socket;
      let upgraded = false;
      let head = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (upgraded) {
          hostReceived += chunk.length;
          return;
        }
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head.subarray(0, end).toString())?.[1];
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        socket.pause();
      });
    });
    const hostSockets = trackSockets(hostServer);
    const hostPort = await listen(hostServer);
    started.push(stopServer(hostServer, hostSockets));

    const client = createDevTunnelClient({ logger: { warn: () => {} } });
    started.push(() => client.closeAll());
    const { localPort } = await client.open({ baseUrl: `http://127.0.0.1:${hostPort}`, port: 4321 });

    const producer = net.createConnection({ port: localPort, host: '127.0.0.1' });
    started.push(async () => { producer.destroy(); });
    await new Promise((resolve) => producer.on('connect', resolve));
    const chunk = Buffer.alloc(CHUNK, 0x63);
    let accepted = 0;
    const pump = () => {
      while (accepted < TOTAL) {
        accepted += CHUNK;
        if (!producer.write(chunk)) {
          producer.once('drain', pump);
          return;
        }
      }
    };
    pump();
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Without backpressure the client would have accepted the whole flood
    // into its WebSocket send buffer; with it the local socket is paused
    // once the buffered amount passes the bound, so writes stall early.
    expect(accepted).toBeLessThan(TOTAL / 2);
    expect(hostReceived).toBe(0);

    hostSocket.resume();
    const deadline = Date.now() + 10_000;
    while ((accepted < TOTAL || hostReceived <= TOTAL) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(accepted).toBe(TOTAL);
    // Raw bytes on the wire are the payload plus WebSocket framing.
    expect(hostReceived).toBeGreaterThan(TOTAL);
  }, 20_000);

  test('runtime drops the connection when a dev server stalls past the held bound', async () => {
    const TOTAL = 32 * 1024 * 1024;
    let devReceived = 0;
    const devServer = net.createServer({ pauseOnConnect: true }, (socket) => {
      socket.on('data', (chunk) => { devReceived += chunk.length; });
    });
    const devSockets = trackSockets(devServer);
    const devPort = await listen(devServer);
    started.push(stopServer(devServer, devSockets));
    const host = await startHost({ allowedPorts: [devPort] });

    const sender = new WebSocket(`ws://127.0.0.1:${host.port}/api/dev-tunnel?port=${devPort}`);
    started.push(async () => { try { sender.close(); } catch { /* already closed */ } });
    await new Promise((resolve) => sender.on('open', resolve));
    const closed = new Promise((resolve) => sender.on('close', () => resolve(true)));
    const chunk = Buffer.alloc(CHUNK, 0x64);
    for (let sent = 0; sent < TOTAL; sent += CHUNK) sender.send(chunk);

    // The dev server reads nothing. Without backpressure the runtime would
    // buffer the whole flood in this process and hold the connection open;
    // with it the held bytes are capped and the connection is dropped.
    const wasClosed = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    expect(wasClosed).toBe(true);
    expect(host.runtime.openSocketCount).toBe(0);
    expect(devReceived).toBe(0);
  }, 20_000);
});

describe('dev tunnel frame size (#1082)', () => {
  test('a single frame over the held cap is refused by the ws layer and the dev server receives none of it', async () => {
    let devReceived = 0;
    const devServer = net.createServer((socket) => {
      socket.on('data', (chunk) => { devReceived += chunk.length; });
    });
    const devSockets = trackSockets(devServer);
    const devPort = await listen(devServer);
    started.push(stopServer(devServer, devSockets));
    const host = await startHost({ allowedPorts: [devPort] });

    const sender = new WebSocket(`ws://127.0.0.1:${host.port}/api/dev-tunnel?port=${devPort}`);
    started.push(async () => { try { sender.close(); } catch { /* already closed */ } });
    await new Promise((resolve) => sender.on('open', resolve));
    const closed = new Promise((resolve) => sender.on('close', (code) => resolve(code)));
    sender.send(Buffer.alloc(1_000_001, 0x65));

    const closeCode = await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(() => resolve(0), 5_000)),
    ]);
    expect(closeCode).toBe(1009);
    expect(host.runtime.openSocketCount).toBe(0);
    expect(devReceived).toBe(0);
  }, 20_000);

  test('a single frame at the held cap forwards byte-identically', async () => {
    const received = [];
    const devServer = net.createServer((socket) => {
      socket.on('data', (chunk) => received.push(chunk));
    });
    const devSockets = trackSockets(devServer);
    const devPort = await listen(devServer);
    started.push(stopServer(devServer, devSockets));
    const host = await startHost({ allowedPorts: [devPort] });

    const sender = new WebSocket(`ws://127.0.0.1:${host.port}/api/dev-tunnel?port=${devPort}`);
    started.push(async () => { try { sender.close(); } catch { /* already closed */ } });
    await new Promise((resolve) => sender.on('open', resolve));
    const frame = Buffer.alloc(1_000_000, 0x66);
    sender.send(frame);

    const delivered = await Promise.race([
      (async () => {
        while (received.reduce((sum, chunk) => sum + chunk.length, 0) < frame.length) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    expect(delivered).toBe(true);
    expect(createHash('sha256').update(Buffer.concat(received)).digest('hex'))
      .toBe(createHash('sha256').update(frame).digest('hex'));
  }, 20_000);
});
