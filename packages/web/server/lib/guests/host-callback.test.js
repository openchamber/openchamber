import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { hostCallbackUrl, setHostCallbackRoute, stopHostCallbackListener } from './host-callback.js';

const removals = [];
afterEach(() => { while (removals.length) removals.pop()(); });
afterAll(() => stopHostCallbackListener());

const post = async (path, { bearer = 'handle', body = '{}', headers = {} } = {}) => {
  const sent = { 'content-type': 'application/json', ...headers };
  if (bearer) sent.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${await hostCallbackUrl()}${path}`, { method: 'POST', headers: sent, body });
  return { status: response.status, body: await response.json() };
};

const route = (path, handler, refusal = () => null) => removals.push(setHostCallbackRoute(path, { refusal, serve: handler }));

/**
 * Streams a body chunk by chunk until `total` bytes are sent or the listener
 * answers or cuts the connection, never ending it first; resolves with how
 * many bytes went out by then and the status, if one came.
 */
const stream = async (path, { bearer = 'handle', total, chunk = 64 * 1024 }) => {
  const url = new URL(path, await hostCallbackUrl());
  return new Promise((resolve) => {
    let sent = 0;
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve({ sent, status });
    };
    const request = http.request(url, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } });
    request.on('response', (response) => { response.resume(); finish(response.statusCode); });
    request.on('error', () => finish(null));
    const block = Buffer.alloc(chunk, 0x78);
    const pump = () => {
      while (!settled && sent < total) {
        sent += block.length;
        if (!request.write(block)) {
          request.once('drain', pump);
          return;
        }
      }
      // Everything went out without an answer: the listener read it all.
      if (!settled && sent >= total) setTimeout(() => finish('read-everything'), 1_000);
    };
    request.flushHeaders();
    pump();
  });
};

describe('the callback listener', () => {
  it('listens on loopback only, on one port for every caller', async () => {
    const url = new URL(await hostCallbackUrl());
    expect(url.hostname).toBe('127.0.0.1');
    expect(await hostCallbackUrl()).toBe(url.origin);
    const external = Object.values(os.networkInterfaces()).flat()
      .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
    if (external) {
      const reached = await new Promise((resolve) => {
        const socket = net.connect({ host: external.address, port: Number(url.port) });
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
      });
      expect(reached).toBe(false);
    }
  });

  it('hands the route its bearer and parsed body, and answers what the route answers', async () => {
    const seen = [];
    route('/echo', async (request) => { seen.push(request); return { status: 200, body: { ok: true } }; });
    expect(await post('/echo', { bearer: 'abc', body: '{"x":1}' })).toEqual({ status: 200, body: { ok: true } });
    expect(seen).toEqual([{ bearer: 'abc', body: { x: 1 } }]);
  });

  it('refuses unknown routes, missing bearers, browsers, other methods, malformed and oversized bodies', async () => {
    route('/echo', async () => ({ status: 200, body: {} }));
    expect(await post('/nowhere')).toMatchObject({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
    expect(await post('/echo', { bearer: '' })).toMatchObject({ status: 401, body: { error: { code: 'HANDLE_UNKNOWN' } } });
    expect(await post('/echo', { headers: { origin: 'https://evil.example' } })).toMatchObject({ status: 403, body: { error: { code: 'BAD_ORIGIN' } } });
    expect(await post('/echo', { body: 'not json' })).toMatchObject({ status: 400, body: { error: { code: 'BAD_REQUEST' } } });
    expect(await post('/echo', { body: JSON.stringify({ body: 'x'.repeat(6_300_000) }) }))
      .toMatchObject({ status: 413, body: { error: { code: 'BODY_TOO_LARGE' } } });
    const get = await fetch(`${await hostCallbackUrl()}/echo`, { headers: { authorization: 'Bearer handle' } });
    expect(get.status).toBe(405);
  });

  it('refuses an unknown bearer before it reads any body', async () => {
    const asked = [];
    route('/echo', async () => ({ status: 200, body: {} }), (bearer) => {
      asked.push(bearer);
      return bearer === 'live' ? null : { status: 403, body: { error: { message: 'unknown', code: 'HANDLE_UNKNOWN' } } };
    });
    // A body that never ends: only an answer given before reading it arrives.
    const answer = await stream('/echo', { bearer: 'junk', total: 64 * 1024 });
    expect(answer.status).toBe(403);
    expect(asked).toEqual(['junk']);
  });

  it('stops reading a body as soon as it passes the cap and cuts the connection', async () => {
    let served = 0;
    route('/echo', async () => { served += 1; return { status: 200, body: {} }; });
    const total = 64 * 1024 * 1024;
    const answer = await stream('/echo', { total });
    expect(answer.status).not.toBe('read-everything');
    expect(answer.sent).toBeLessThan(total);
    expect(served).toBe(0);
  });

  it('answers a route that throws with a generic failure', async () => {
    route('/boom', async () => { throw new Error('secret detail'); });
    const answer = await post('/boom');
    expect(answer).toMatchObject({ status: 500, body: { error: { code: 'HOST_FAILED' } } });
    expect(JSON.stringify(answer.body)).not.toContain('secret detail');
  });
});
