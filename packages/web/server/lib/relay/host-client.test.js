// Integration test: fake relay (minimal Layer 1) + real host-client + a scripted
// client using the JS e2ee initiator. Verifies the full handshake and a tunneled
// HTTP GET /health, and asserts only binary frames cross the relay post-handshake.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

import { startRelayHost } from './host-client.js';
import {
  bytesToBase64Url,
  createFrameDecryptor,
  createFrameEncryptor,
  deriveSessionKeys,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  generateHandshakeNonce,
  importEcdhPrivateKey,
  RELAY_PROTOCOL_VERSION,
} from './e2ee.js';
import {
  TunnelFrameType,
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';

// ---------------------------------------------------------------------------
// Fake relay: routes host-control <-> host-data <-> client by (serverId, connectionId).
// Forwards frames verbatim, never inspects them.
// ---------------------------------------------------------------------------
const startFakeRelay = () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state = {
    control: null,
    hostData: new Map(), // connectionId -> ws
    clients: new Map(), // connectionId -> ws
    buffered: new Map(), // connectionId -> [[data, isBinary]] awaiting host-data
    relayFrames: [], // observed forwarded frames (for plaintext assertions)
    apps: new Map(),
  };

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role');
    state.apps.set(role, {
      appId: url.searchParams.get('appId'),
      appVersion: url.searchParams.get('appVersion'),
      platform: url.searchParams.get('platform'),
    });
    const connectionId = url.searchParams.get('connectionId');

    if (role === 'host-control') {
      state.control = ws;
      // Announce any already-waiting clients.
      ws.send(JSON.stringify({ type: 'sync', connectionIds: [...state.clients.keys()] }));
      for (const id of state.clients.keys()) {
        ws.send(JSON.stringify({ type: 'connected', connectionId: id }));
      }
      return;
    }

    if (role === 'host-data') {
      state.hostData.set(connectionId, ws);
      // Flush any client frames that arrived before this socket attached.
      const buffered = state.buffered.get(connectionId) || [];
      state.buffered.delete(connectionId);
      for (const [data, isBinary] of buffered) ws.send(data, { binary: isBinary });
      ws.on('message', (data, isBinary) => {
        state.relayFrames.push({ from: 'host', isBinary });
        const client = state.clients.get(connectionId);
        if (client && client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      ws.on('close', () => state.hostData.delete(connectionId));
      return;
    }

    if (role === 'client') {
      state.clients.set(connectionId, ws);
      ws.on('message', (data, isBinary) => {
        state.relayFrames.push({ from: 'client', isBinary });
        const host = state.hostData.get(connectionId);
        if (host && host.readyState === WebSocket.OPEN) {
          host.send(data, { binary: isBinary });
        } else {
          const queue = state.buffered.get(connectionId) || [];
          queue.push([data, isBinary]);
          state.buffered.set(connectionId, queue);
        }
      });
      ws.on('close', () => state.clients.delete(connectionId));
      if (state.control && state.control.readyState === WebSocket.OPEN) {
        state.control.send(JSON.stringify({ type: 'connected', connectionId }));
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        wsUrl: `ws://127.0.0.1:${port}`,
        state,
        stop: () => new Promise((r) => {
          // A socket a failed test left open would hold server.close() until
          // the hook timeout; drop them so a failure is reported once.
          for (const client of wss.clients) client.terminate();
          server.closeAllConnections();
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
};

// A stub loopback origin serving /health.
const startLoopbackOrigin = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        const expectedOrigin = `http://127.0.0.1:${server.address().port}`;
        if (req.headers.origin !== expectedOrigin) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid origin' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          service: 'stub',
          relayConn: req.headers['x-openchamber-relay-connection'] || null,
          origin: req.headers.origin,
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, stop: () => new Promise((r) => server.close(() => r())) }));
  });

// Build the host identity around a fresh keypair (ECDH enc key + ECDSA sign key).
const buildIdentity = async () => {
  const enc = await generateEcdhKeyPair();
  const encPrivJwk = await globalThis.crypto.subtle.exportKey('jwk', enc.privateKey);
  const { privateKey: signPriv, publicKey: signPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signPubJwk = signPub.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: signPubJwk.crv, kty: signPubJwk.kty, x: signPubJwk.x, y: signPubJwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  return {
    serverId,
    hostEncPubJwk: await exportPublicKeyJwk(enc.publicKey),
    hostEncPrivateKey: await importEcdhPrivateKey(encPrivJwk),
    signRelayAuth: (role, connectionId) => {
      const ts = Date.now();
      const sig = crypto
        .sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: signPriv, dsaEncoding: 'ieee-p1363' })
        .toString('base64url');
      return { ts, sig, pk: Buffer.from(canonical, 'utf8').toString('base64url') };
    },
  };
};

// Scripted client using the JS initiator: connects, handshakes, does a GET.
const runScriptedClient = async ({ relayUrl, serverId, hostEncPubJwk }) => {
  const connectionId = 'conn-test-1';
  const url = new URL(`${relayUrl}/`);
  url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
  url.searchParams.set('role', 'client');
  url.searchParams.set('serverId', serverId);
  url.searchParams.set('connectionId', connectionId);

  const hostPub = await globalThis.crypto.subtle.importKey(
    'jwk',
    { kty: hostEncPubJwk.kty, crv: hostEncPubJwk.crv, x: hostEncPubJwk.x, y: hostEncPubJwk.y, ext: true },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  const ephemeral = await generateEcdhKeyPair();
  const nonce = generateHandshakeNonce();

  let channel = null;
  const responseChunks = [];
  let responseStatus = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  // Dialed only now, with the key material ready and the listeners attached
  // in the same tick. Dialing before the WebCrypto awaits above let a loopback
  // socket open while the key generation was still queued on the threadpool,
  // and an `open` event with no listener means no hello, no ready, and a
  // client that waits forever. Loaded CI runners hit exactly that.
  const ws = new WebSocket(url.toString());
  ws.on('open', async () => {
    ws.send(JSON.stringify({
      t: 'hello',
      v: RELAY_PROTOCOL_VERSION,
      clientPubJwk: await exportPublicKeyJwk(ephemeral.publicKey),
      nonce: bytesToBase64Url(nonce),
    }));
  });

  // Serialize message handling: an async ws handler runs per-message tasks
  // concurrently, letting StreamEnd overtake HttpBody and trip the decryptor's
  // strict counter ordering (the production tunnel client chains decrypts).
  let processing = Promise.resolve();
  const handleMessage = async (data, isBinary) => {
    if (!isBinary) {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.t === 'ready') {
        const keys = await deriveSessionKeys(ephemeral.privateKey, hostPub, nonce);
        channel = {
          encryptor: createFrameEncryptor(keys.clientToHost),
          decryptor: createFrameDecryptor(keys.hostToClient),
        };
        // Send an HTTP GET /health over stream 1.
        const req = encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
          method: 'GET',
          path: '/health',
          query: '',
          headers: { accept: 'application/json' },
        }));
        ws.send(await channel.encryptor.encrypt(req), { binary: true });
        ws.send(await channel.encryptor.encrypt(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0))), { binary: true });
      }
      return;
    }
    if (!channel) return;
    const plaintext = await channel.decryptor.decrypt(new Uint8Array(data));
    const frame = decodeTunnelFrame(plaintext);
    if (frame.frameType === TunnelFrameType.HttpResponse) {
      responseStatus = JSON.parse(new TextDecoder().decode(frame.payload)).status;
    } else if (frame.frameType === TunnelFrameType.HttpBody) {
      responseChunks.push(frame.payload);
    } else if (frame.frameType === TunnelFrameType.StreamEnd) {
      const total = responseChunks.reduce((n, c) => n + c.length, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of responseChunks) {
        body.set(c, off);
        off += c.length;
      }
      resolveDone({ status: responseStatus, body: JSON.parse(new TextDecoder().decode(body)) });
      ws.close();
    }
  };
  ws.on('message', (data, isBinary) => {
    processing = processing.then(() => handleMessage(data, isBinary));
  });

  return done;
};

describe('relay host-client integration', () => {
  let relay;
  let origin;
  let host;

  beforeAll(async () => {
    relay = await startFakeRelay();
    origin = await startLoopbackOrigin();
  });

  afterAll(async () => {
    host?.stop();
    await relay?.stop();
    await origin?.stop();
  });

  it('tunnels an HTTP GET /health with only binary frames post-handshake', async () => {
    const identity = await buildIdentity();
    let markHostConnected;
    const hostConnected = new Promise((resolve) => { markHostConnected = resolve; });
    host = startRelayHost({
      relayUrl: `${relay.wsUrl}/`,
      identity,
      getLocalPort: () => origin.port,
      onStatus: (status) => {
        if (status.state === 'connected') markHostConnected();
      },
      logger: { warn: () => {} },
    });

    await hostConnected;

    const result = await runScriptedClient({
      relayUrl: relay.wsUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
    });

    expect(result.status).toBe(200);
    for (const role of ['host-control', 'host-data']) {
      expect(relay.state.apps.get(role)).toEqual({
        appId: 'openchamber',
        appVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
        platform: process.env.OPENCHAMBER_RUNTIME || 'web',
      });
    }
    expect(result.body.ok).toBe(true);
    expect(result.body.relayConn).toBe('conn-test-1');
    expect(result.body.origin).toBe(`http://127.0.0.1:${origin.port}`);

    // Every forwarded frame after the two plaintext handshake frames (client
    // hello, host ready) must be binary.
    const forwarded = relay.state.relayFrames;
    const plaintextForwarded = forwarded.filter((f) => !f.isBinary);
    expect(plaintextForwarded.length).toBe(2); // hello + ready only
    expect(forwarded.filter((f) => f.isBinary).length).toBeGreaterThan(0);
  });
});

// Control-only relay whose host-data upgrades the test scripts: each dial is
// answered by the next entry of `outcomes` ('reject' -> 503, 'hang' -> no
// answer, 'accept' -> 101),
// accepting once the list runs out.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startScriptedRelay = (outcomes) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const state = { control: null, dials: [], dataSockets: [] };
  // Upgraded sockets leave the server's connection tracking, so a hung one
  // would hold server.close() open: destroy them on stop.
  const hungSockets = [];
  let notifyDial = () => {};
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.searchParams.get('role');
    if (role === 'host-data') {
      state.dials.push(url.searchParams.get('connectionId'));
      notifyDial();
      const outcome = outcomes.shift() ?? 'accept';
      if (outcome === 'reject') {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      if (outcome === 'hang') {
        socket.on('error', () => {});
        hungSockets.push(socket);
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (role === 'host-control') state.control = ws;
      else state.dataSockets.push(ws);
    });
  });
  const waitForDials = (count, timeoutMs) => new Promise((resolve) => {
    const check = () => {
      if (state.dials.length >= count) resolve(true);
    };
    notifyDial = check;
    check();
    setTimeout(() => resolve(state.dials.length >= count), timeoutMs);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        wsUrl: `ws://127.0.0.1:${server.address().port}/`,
        state,
        waitForDials,
        send: (message) => state.control.send(JSON.stringify(message)),
        stop: () => new Promise((r) => {
          for (const client of wss.clients) client.terminate();
          for (const socket of hungSockets) socket.destroy();
          server.closeAllConnections();
          wss.close();
          server.close(() => r());
        }),
      });
    });
  });
};

describe('relay host-client data socket retry', () => {
  let relay;
  let host;

  afterEach(async () => {
    host?.stop();
    host = null;
    await relay?.stop();
    relay = null;
  });

  const startHost = async (outcomes) => {
    relay = await startScriptedRelay(outcomes);
    const identity = await buildIdentity();
    let markConnected;
    const connected = new Promise((resolve) => { markConnected = resolve; });
    host = startRelayHost({
      relayUrl: relay.wsUrl,
      identity,
      getLocalPort: () => 1,
      onStatus: (status) => {
        if (status.state === 'connected') markConnected();
      },
      logger: { warn: () => {}, info: () => {} },
    });
    await connected;
  };

  it('dials a waiting client again after a dial the relay refused', async () => {
    await startHost(['reject', 'reject']);
    relay.send({ type: 'connected', connectionId: 'conn-retry' });

    // No second `connected` arrives: the host retries on its own.
    expect(await relay.waitForDials(3, 6000)).toBe(true);
    expect(relay.state.dials).toEqual(['conn-retry', 'conn-retry', 'conn-retry']);
    await sleep(100);
    expect(host.getStatus().connectedClients).toBe(1);
  }, 10000);

  it('gives up on a hung dial well inside the client handshake timeout and dials again', async () => {
    await startHost(['hang']);
    relay.send({ type: 'connected', connectionId: 'conn-hung' });

    expect(await relay.waitForDials(2, 9000)).toBe(true);
    await sleep(100);
    expect(host.getStatus().connectedClients).toBe(1);
  }, 12000);

  it('stops retrying once the relay reports the client gone', async () => {
    await startHost(['reject', 'reject', 'reject']);
    relay.send({ type: 'connected', connectionId: 'conn-gone' });
    expect(await relay.waitForDials(1, 2000)).toBe(true);
    relay.send({ type: 'disconnected', connectionId: 'conn-gone' });

    expect(await relay.waitForDials(2, 2500)).toBe(false);
    expect(relay.state.dials).toEqual(['conn-gone']);
  }, 10000);

  it('leaves a data socket that opened and then closed to the client reconnect', async () => {
    await startHost([]);
    relay.send({ type: 'connected', connectionId: 'conn-opened' });
    expect(await relay.waitForDials(1, 2000)).toBe(true);
    await sleep(100);
    relay.state.dataSockets[0].close(1012, 'gone');

    expect(await relay.waitForDials(2, 2500)).toBe(false);
  }, 10000);
});
