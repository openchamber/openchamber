import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import http from 'node:http';
import { WebSocket } from 'ws';

import { createClientHandshake } from '../../../../ui/src/lib/relay/handshake.ts';
import { exportPublicKeyJwk, generateEcdhKeyPair } from '../relay/e2ee.js';
import { createDirectE2eeService, DIRECT_E2EE_PATH } from './service.js';

const cleanups = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
};

const fixture = async ({ profile, limits, logs = [], getRelayIdentity } = {}) => {
  const keys = await generateEcdhKeyPair();
  let activeProfile = profile ?? { id: 'profile-1', mode: 'managed-remote', hostname: 'direct.example.test', directE2eeEnabled: true };
  const origin = http.createServer((_req, res) => res.end('{}'));
  await listen(origin);
  const outer = http.createServer((_req, res) => res.end('outer'));
  const service = createDirectE2eeService({
    getActiveProfile: () => activeProfile,
    getRelayIdentity: getRelayIdentity ?? (async () => ({ hostEncPrivateKey: keys.privateKey })),
    getLocalPort: () => origin.address().port,
    internalTransportMarker: 'test-process-marker',
    authenticateBearerToken: async () => null,
    limits,
    logger: { warn: (...args) => logs.push(args) },
  });
  service.attach(outer);
  await listen(outer);
  cleanups.push(() => new Promise((resolve) => { service.detach(); outer.closeAllConnections?.(); outer.close(() => origin.close(resolve)); }));
  return { service, outer, keys, setProfile: (value) => { activeProfile = value; } };
};

const mockUpgrade = (server, { path = DIRECT_E2EE_PATH, host = 'direct.example.test', duplicateHost = false, origins = [] } = {}) => {
  let data = '';
  const socket = {
    destroyed: false,
    write(value, callback) { data += value; callback?.(); },
    end(value = '') { data += value; },
  };
  const rawHeaders = ['Host', host];
  if (duplicateHost) rawHeaders.push('Host', host);
  for (const origin of origins) rawHeaders.push('Origin', origin);
  server.emit('upgrade', { url: path, rawHeaders, headers: { host, ...(origins[0] ? { origin: origins[0] } : {}) } }, socket, Buffer.alloc(0));
  return data;
};

const connect = async (fx, headers = {}) => {
  const ws = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, { headers: { Host: 'direct.example.test', ...headers }, perMessageDeflate: false });
  await new Promise((resolve) => ws.once('open', resolve));
  return ws;
};

const connectTracked = (fx, headers = {}) => {
  const ws = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, { headers: { Host: 'direct.example.test', ...headers }, perMessageDeflate: false });
  return {
    ws,
    opened: new Promise((resolve) => ws.once('open', resolve)),
    closed: new Promise((resolve) => ws.once('close', resolve)),
  };
};

describe('direct E2EE upgrade and lifecycle', () => {
  it('rejects inactive profiles and strictly validates authority', async () => {
    const fx = await fixture({ profile: { id: 'p', mode: 'quick', hostname: 'direct.example.test', directE2eeEnabled: true } });
    expect(mockUpgrade(fx.outer)).toContain('404 Not Found');
    fx.setProfile({ id: 'p', mode: 'managed-remote', hostname: 'direct.example.test', directE2eeEnabled: true });
    for (const host of ['localhost', 'other.example.test', 'direct.example.test.', 'direct.example.test:444', 'dírect.example.test']) {
      expect(mockUpgrade(fx.outer, { host })).toContain('421 Misdirected Request');
    }
    expect(mockUpgrade(fx.outer, { duplicateHost: true })).toContain('421 Misdirected Request');
    expect(mockUpgrade(fx.outer, { path: `${DIRECT_E2EE_PATH}?token=secret` })).toContain('400 Bad Request');
  });

  it('fails ignored pre-establishment text immediately and releases pending admission exactly once', async () => {
    const cases = ['{', JSON.stringify({ t: 'hello', v: 999 }), JSON.stringify({ t: 'ready', v: 1 }), JSON.stringify({ t: 'prohibited', v: 1 }), ''];
    for (const text of cases) {
      const fx = await fixture({ limits: { handshakeTimeoutMs: 5_000 } });
      const ws = await connect(fx);
      let closes = 0;
      ws.on('close', () => { closes += 1; });
      ws.send(text);
      await new Promise((resolve) => ws.once('close', resolve));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(closes).toBe(1);
      expect(fx.service.getCounts()).toEqual({ pending: 0, preauthenticated: 0, authenticated: 0, reserved: 0, total: 0 });
    }
  });

  it('accepts an identical valid hello retry and repeats readiness without rekeying', async () => {
    const fx = await fixture();
    const client = await createClientHandshake(await exportPublicKeyJwk(fx.keys.publicKey), { batch: false });
    const ws = await connect(fx);
    const replies = [];
    ws.on('message', (data, binary) => { if (!binary) replies.push(data.toString()); });
    ws.send(client.helloText);
    while (replies.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    ws.send(client.helloText);
    while (replies.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(replies[1]).toBe(replies[0]);
    expect(fx.service.getCounts()).toMatchObject({ pending: 0, preauthenticated: 1 });
    ws.terminate();
  });

  it('accepts browser and WebView Origin metadata without using it for authorization', async () => {
    for (const origin of ['http://127.0.0.1:5180', 'capacitor://localhost', 'openchamber-ui://app', 'null']) {
      const fx = await fixture();
      const client = await createClientHandshake(await exportPublicKeyJwk(fx.keys.publicKey), { batch: false });
      const ws = await connect(fx, { Origin: origin });
      const ready = new Promise((resolve) => ws.once('message', (data) => resolve(data.toString())));
      ws.send(client.helloText);
      expect(JSON.parse(await ready)).toMatchObject({ t: 'ready', v: 1 });
      expect(fx.service.getCounts().preauthenticated).toBe(1);
      ws.terminate();
    }
  });

  it('rejects duplicate or control-bearing Origin headers without weakening authority checks', async () => {
    const fx = await fixture();
    expect(mockUpgrade(fx.outer, { origins: ['https://one.test', 'https://two.test'] })).toContain('400 Bad Request');
    expect(mockUpgrade(fx.outer, { origins: ['https://good.test\r\nInjected: yes'] })).toContain('400 Bad Request');
    expect(mockUpgrade(fx.outer, { host: 'other.example.test', origins: ['https://good.test'] })).toContain('421 Misdirected Request');
  });

  it('handles only the exact raw origin-form target and rejects related normalized aliases', async () => {
    const fx = await fixture();
    const related = [
      `${DIRECT_E2EE_PATH}?`, `${DIRECT_E2EE_PATH}#fragment`, `${DIRECT_E2EE_PATH}/`,
      '/api/openchamber/x/../direct-e2ee/ws', '/api/openchamber/x/%2e%2e/direct-e2ee/ws',
      '/api/openchamber/direct-e2ee%2fws', `http://direct.example.test${DIRECT_E2EE_PATH}`,
    ];
    for (const target of related) expect(mockUpgrade(fx.outer, { path: target })).toMatch(/400 Bad Request|404 Not Found/);
    let fallback = 0;
    const listener = (_req, socket) => { fallback += 1; socket.end('HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\n\r\n'); };
    fx.outer.on('upgrade', listener);
    expect(mockUpgrade(fx.outer, { path: '/unrelated/ws' })).toContain('418 Teapot');
    expect(fallback).toBe(1);
    fx.outer.off('upgrade', listener);
  });

  it('ignores other upgrade paths and detach removes ownership', async () => {
    const fx = await fixture();
    let fallback = 0;
    const handler = (req, socket) => {
      if (req.url === '/other') { fallback += 1; socket.end('HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\n\r\n'); }
    };
    fx.outer.on('upgrade', handler);
    expect(mockUpgrade(fx.outer, { path: '/other' })).toContain('418 Teapot');
    expect(fallback).toBe(1);
    fx.outer.off('upgrade', handler);
    fx.service.detach();
  });

  it('releases pending accounting exactly once and closes profile sessions', async () => {
    const fx = await fixture({ limits: { handshakeTimeoutMs: 30 } });
    const ws = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, { headers: { Host: 'direct.example.test' }, perMessageDeflate: false });
    await new Promise((resolve) => ws.once('open', resolve));
    expect(fx.service.getCounts().pending).toBe(1);
    fx.service.closeProfile('profile-1');
    await new Promise((resolve) => ws.once('close', resolve));
    expect(fx.service.getCounts()).toEqual({ pending: 0, preauthenticated: 0, authenticated: 0, reserved: 0, total: 0 });
    fx.service.closeProfile('profile-1');
    expect(fx.service.getActiveSessionCount()).toBe(0);
  });

  it('releases admission immediately when relay identity initialization fails', async () => {
    const identityError = new Error('sensitive identity backend detail');
    const logs = [];
    const fx = await fixture({
      logs,
      getRelayIdentity: async () => { throw identityError; },
      limits: { handshakeTimeoutMs: 25, idleTimeoutMs: 25 },
    });
    const closes = [];
    const socket = {
      readyState: WebSocket.OPEN,
      on: () => socket,
      once: () => socket,
      close: (code, reason) => {
        closes.push({ code, reason });
        socket.readyState = WebSocket.CLOSING;
      },
      terminate: () => { socket.readyState = WebSocket.CLOSED; },
    };
    fx.service._webSocketServer.handleUpgrade = (_req, _rawSocket, _head, accept) => accept(socket);
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
    const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

    try {
      mockUpgrade(fx.outer);
      for (let attempt = 0; attempt < 10 && logs.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(fx.service.getCounts()).toEqual({ pending: 0, preauthenticated: 0, authenticated: 0, reserved: 0, total: 0 });
      expect(closes).toEqual([{ code: 1011, reason: 'direct session closed' }]);
      expect(clearTimeoutSpy).toHaveBeenCalled();
      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(logs).toEqual([
        ['[DirectE2EE]', { reason: 'identity-unavailable', connectionId: expect.any(String) }],
        ['[DirectE2EE]', { reason: 'identity-unavailable', connectionId: 'upgrade' }],
      ]);
      expect(JSON.stringify(logs)).not.toContain(identityError.message);

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(closes).toHaveLength(1);
      expect(logs).toHaveLength(2);
    } finally {
      clearTimeoutSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('shares one bounded identity attempt, clears timed-out waiters, and caches late success without revival', async () => {
    const identity = deferred();
    let identityCalls = 0;
    const fx = await fixture({
      getRelayIdentity: () => {
        identityCalls += 1;
        return identity.promise;
      },
      limits: { identityDeadlineMs: 60, identityRetryCooldownMs: 40, handshakeTimeoutMs: 1_000 },
    });
    const first = connectTracked(fx);
    const second = connectTracked(fx);
    await Promise.all([first.opened, second.opened]);
    first.ws.send('first-pending-frame');
    second.ws.send('second-pending-frame');
    await Promise.all([first.closed, second.closed]);

    expect(identityCalls).toBe(1);
    expect(fx.service.getCounts()).toEqual({ pending: 0, preauthenticated: 0, authenticated: 0, reserved: 0, total: 0 });
    expect(fx.service._getPendingFrameCount()).toBe(0);

    const fastFailure = connectTracked(fx);
    await fastFailure.opened;
    await fastFailure.closed;
    expect(identityCalls).toBe(1);

    identity.resolve({ hostEncPrivateKey: fx.keys.privateKey });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fx.service.getCounts().total).toBe(0);

    const client = await createClientHandshake(await exportPublicKeyJwk(fx.keys.publicKey), { batch: false });
    const live = await connect(fx);
    const ready = new Promise((resolve) => live.once('message', (data) => resolve(data.toString())));
    live.send(client.helloText);
    expect(JSON.parse(await ready)).toMatchObject({ t: 'ready', v: 1 });
    expect(identityCalls).toBe(1);
    live.terminate();
  });

  it('fails fast during identity rejection cooldown and permits exactly one shared retry', async () => {
    const firstIdentity = deferred();
    const retryIdentity = deferred();
    let identityCalls = 0;
    const fx = await fixture({
      getRelayIdentity: () => {
        identityCalls += 1;
        return identityCalls === 1 ? firstIdentity.promise : retryIdentity.promise;
      },
      limits: { identityDeadlineMs: 1_000, identityRetryCooldownMs: 40, handshakeTimeoutMs: 1_000 },
    });

    const rejected = connectTracked(fx);
    await rejected.opened;
    firstIdentity.reject(new Error('identity backend unavailable'));
    await rejected.closed;
    expect(fx.service.getCounts().total).toBe(0);

    const cooldown = connectTracked(fx);
    await cooldown.opened;
    await cooldown.closed;
    expect(identityCalls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const retryOne = connectTracked(fx);
    const retryTwo = connectTracked(fx);
    await Promise.all([retryOne.opened, retryTwo.opened]);
    const client = await createClientHandshake(await exportPublicKeyJwk(fx.keys.publicKey), { batch: false });
    const ready = new Promise((resolve) => retryOne.ws.once('message', (data) => resolve(data.toString())));
    retryOne.ws.send(client.helloText);
    expect(identityCalls).toBe(2);
    retryIdentity.resolve({ hostEncPrivateKey: fx.keys.privateKey });
    expect(JSON.parse(await ready)).toMatchObject({ t: 'ready', v: 1 });
    expect(identityCalls).toBe(2);
    retryOne.ws.terminate();
    retryTwo.ws.terminate();
  });

  it('enforces the per-source pending cap by evicting the oldest probation', async () => {
    const fx = await fixture({ limits: { maxPending: 4, maxPendingPerSource: 1, handshakeTimeoutMs: 5_000 } });
    const first = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, { headers: { Host: 'direct.example.test' }, perMessageDeflate: false });
    await new Promise((resolve) => first.once('open', resolve));
    const firstClosed = new Promise((resolve) => first.once('close', resolve));
    const second = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, { headers: { Host: 'direct.example.test' }, perMessageDeflate: false });
    await new Promise((resolve) => second.once('open', resolve));
    await firstClosed;
    expect(fx.service.getCounts()).toMatchObject({ pending: 1, total: 1 });
    second.terminate();
  });

  it('uses noServer with compression disabled and reason-only logs', async () => {
    const logs = [];
    const fx = await fixture({ logs });
    expect(fx.service._webSocketServer.options.noServer).toBe(true);
    expect(fx.service._webSocketServer.options.perMessageDeflate).toBe(false);
    mockUpgrade(fx.outer, { path: `${DIRECT_E2EE_PATH}?bearer=do-not-log-me` });
    expect(JSON.stringify(logs)).not.toContain('do-not-log-me');
  });

  it('supports injected profile disable, stop, and switch lifecycle hooks', async () => {
    const fx = await fixture();
    const lifecycle = {
      disable: (id) => fx.service.closeProfile(id, 'profile-disabled'),
      stop: () => fx.service.closeAll('tunnel-stopped'),
      switch: (oldId) => fx.service.closeProfile(oldId, 'profile-switched'),
      revoke: (clientId) => fx.service.revokeClient(clientId),
    };
    const connect = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, { headers: { Host: 'direct.example.test' }, perMessageDeflate: false });
      await new Promise((resolve) => ws.once('open', resolve));
      return ws;
    };
    for (const action of [() => lifecycle.disable('profile-1'), lifecycle.stop, () => lifecycle.switch('profile-1')]) {
      const ws = await connect();
      action();
      await new Promise((resolve) => ws.once('close', resolve));
      expect(fx.service.getCounts().total).toBe(0);
    }
    lifecycle.revoke('unbound-client');
    expect(fx.service.getCounts().total).toBe(0);
  });

  it('never logs attacker-controlled handshake, header, cookie, payload, key-like, or line-injection values', async () => {
    const logs = [];
    const fx = await fixture({ logs });
    const secrets = [
      'bearer-secret', 'cookie-secret', 'payload-secret', 'private-key-secret',
      'header-secret', 'crlf-secret\r\nforged-record', 'unicode-secret\u2028forged', 'unicode-secret-2\u2029forged',
    ];
    mockUpgrade(fx.outer, { path: `${DIRECT_E2EE_PATH}?token=${encodeURIComponent(secrets.join('|'))}` });
    const ws = new WebSocket(`ws://127.0.0.1:${fx.outer.address().port}${DIRECT_E2EE_PATH}`, {
      headers: { Host: 'direct.example.test', Authorization: `Bearer ${secrets[0]}`, Cookie: `x=${secrets[1]}`, 'X-Attacker': secrets[4] },
      perMessageDeflate: false,
    });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ t: 'hello', payload: secrets[2], privateJwk: { d: secrets[3] }, lines: secrets.slice(5) }));
    ws.send(Buffer.from(secrets.join('|')));
    await new Promise((resolve) => ws.once('close', resolve));
    const serialized = JSON.stringify(logs);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    for (const entry of logs) {
      expect(entry[0]).toBe('[DirectE2EE]');
      expect(Object.keys(entry[1]).sort()).toEqual(['connectionId', 'reason']);
      expect(entry[1].reason).toMatch(/^[a-z-]+$/);
    }
  });
});
