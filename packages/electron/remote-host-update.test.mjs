import assert from 'node:assert/strict';
import test from 'node:test';
import { requestRemoteHostUpdate } from './remote-host-update.mjs';

const response = (status, payload = null) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => payload,
});

test('posts to the host update route with the saved token and headers', async () => {
  const calls = [];
  const result = await requestRemoteHostUpdate({
    url: 'https://host.example/base/?ignored=1',
    clientToken: ' secret-token ',
    requestHeaders: { 'X-Instance': 'remote', Authorization: 'attacker' },
    chromiumFetch: async (url, options) => {
      calls.push({ url, options });
      return response(200, { success: true, autoRestart: true, version: '2.1.2' });
    },
  });

  assert.deepEqual(result, { status: 'started' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://host.example/base/api/openchamber/update-install');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].options.headers['X-Instance'], 'remote');
});

for (const [name, reply, expected] of [
  ['refused token', response(401), { status: 'auth' }],
  ['forbidden token', response(403), { status: 'auth' }],
  ['service manager refusal', response(409, { error: 'Run openchamber update on the server.' }), { status: 'failed', error: 'Run openchamber update on the server.' }],
  ['no update available', response(400, { error: 'No update available' }), { status: 'failed', error: 'No update available' }],
  ['unexpected success body', response(200, { ok: true }), { status: 'failed', error: null }],
  ['web page instead of JSON', { status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }, { status: 'failed', error: null }],
]) {
  test(`classifies ${name}`, async () => {
    const result = await requestRemoteHostUpdate({ url: 'https://host.example', chromiumFetch: async () => reply });
    assert.deepEqual(result, expected);
  });
}

test('fails without a request for an address that is not http', async () => {
  let calls = 0;
  const result = await requestRemoteHostUpdate({
    url: 'relay://server-id',
    chromiumFetch: async () => { calls += 1; return response(200, { success: true }); },
  });
  assert.deepEqual(result, { status: 'failed', error: null });
  assert.equal(calls, 0);
});

test('fails when the host does not answer in time', async () => {
  const result = await requestRemoteHostUpdate({
    url: 'https://host.example',
    timeoutMs: 10,
    chromiumFetch: async (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.deepEqual(result, { status: 'failed', error: null });
});
