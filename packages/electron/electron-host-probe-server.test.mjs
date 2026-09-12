import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { probeElectronHostWithDeadline } from './electron-host-probe.mjs';

const version = { status: 'ok', compatibility: { capabilities: ['api.runtime-url.v1'], apiVersion: 1, minClientApiVersion: 1 } };

const serve = async (t, handler) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
};
const probe = (url, options = {}) => probeElectronHostWithDeadline({
  url, timeoutMs: 150, chromiumFetch: fetch, isReady: () => true, ...options,
});

test('redirected identity cannot authorize the candidate or receive credentials', async (t) => {
  let targetCalls = 0;
  let credentialCalls = 0;
  const target = await serve(t, (_req, res) => { targetCalls++; res.end(JSON.stringify({ serverId: 'expected' })); });
  const candidate = await serve(t, (req, res) => {
    if (req.headers.authorization) credentialCalls++;
    res.writeHead(302, { Location: `${target}/health` });
    res.end();
  });
  const result = await probe(candidate, { expectedServerId: 'expected', clientToken: 'fixture-only' });
  assert.equal(result.status, 'wrong-service');
  assert.equal(targetCalls, 0);
  assert.equal(credentialCalls, 0);
});

for (const endpoint of ['/health', '/api/version']) {
  test(`deadline aborts a stalled ${endpoint} body`, async (t) => {
    let closed;
    const bodyClosed = new Promise((resolve) => { closed = resolve; });
    const url = await serve(t, (req, res) => {
      if (req.url === endpoint) {
        res.on('close', closed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
      } else res.end(JSON.stringify({ serverId: 'expected' }));
    });
    const result = await probe(url, { expectedServerId: endpoint === '/health' ? 'expected' : '' });
    assert.equal(result.status, 'unreachable');
    await bodyClosed;
  });
}

for (const status of [200, 401, 403, 500]) {
  test(`disposes unused session body after ${status} headers`, async (t) => {
    let closed;
    const bodyClosed = new Promise((resolve) => { closed = resolve; });
    const url = await serve(t, (req, res) => {
      if (req.url === '/api/version') return res.end(JSON.stringify(version));
      res.on('close', closed);
      res.writeHead(status);
      res.write('unused');
    });
    const result = await probe(url, { timeoutMs: 1000 });
    assert.equal(result.status, status === 200 ? 'ok' : status === 500 ? 'unreachable' : 'auth');
    await bodyClosed;
  });
}

test('readiness false starts no requests', async () => {
  let calls = 0;
  const result = await probe('https://instance.example', {
    isReady: () => false,
    chromiumFetch: () => { calls++; throw new Error('must not run'); },
  });
  assert.equal(result.status, 'unreachable');
  assert.equal(calls, 0);
});
