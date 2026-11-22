import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createProviderReadCache } from './index.js';

function setup({ answer = (req) => ({ items: [req.query.page ?? '1'] }), status = 200, cacheOptions = {} } = {}) {
  let clock = 1_000;
  const cache = createProviderReadCache({ now: () => clock, ...cacheOptions });
  const app = express();
  app.use(cache.middleware);
  const calls = { list: 0 };
  let gate = null;
  app.get('/api/source-control/github/pulls/list', async (req, res) => {
    calls.list += 1;
    if (gate) await gate.promise;
    res.status(status).json(answer(req));
  });
  app.post('/api/source-control/github/pr/merge', (_req, res) => res.json({ ok: true }));
  app.get('/api/source-control/github/auth/status', (_req, res) => { calls.status = (calls.status ?? 0) + 1; res.json({ ok: true }); });
  const hold = () => {
    let release;
    gate = { promise: new Promise((resolve) => { release = resolve; }) };
    return () => { gate = null; release(); };
  };
  return { app, cache, calls, hold, tick: (ms) => { clock += ms; } };
}

describe('provider read cache', () => {
  it('answers the same read from the cache within its TTL and asks again after it', async () => {
    const { app, calls, tick } = setup();
    await request(app).get('/api/source-control/github/pulls/list?accountId=a&page=1').expect(200);
    await request(app).get('/api/source-control/github/pulls/list?page=1&accountId=a').expect(200);
    expect(calls.list).toBe(1);
    // Another account is another answer.
    await request(app).get('/api/source-control/github/pulls/list?accountId=b&page=1').expect(200);
    expect(calls.list).toBe(2);
    tick(31_000);
    await request(app).get('/api/source-control/github/pulls/list?accountId=a&page=1').expect(200);
    expect(calls.list).toBe(3);
  });

  it('lets identical reads in flight share one provider call', async () => {
    const { app, calls, hold } = setup();
    const release = hold();
    const first = request(app).get('/api/source-control/github/pulls/list');
    const second = request(app).get('/api/source-control/github/pulls/list');
    const pending = Promise.all([first, second]);
    await vi.waitFor(() => expect(calls.list).toBe(1));
    release();
    const [one, two] = await pending;
    expect([one.body, two.body]).toEqual([{ items: ['1'] }, { items: ['1'] }]);
    expect(calls.list).toBe(1);
  });

  it('never keeps a failure or a not-connected answer, and leaves other routes alone', async () => {
    const disconnected = setup({ answer: () => ({ connected: false }) });
    await request(disconnected.app).get('/api/source-control/github/pulls/list').expect(200);
    await request(disconnected.app).get('/api/source-control/github/pulls/list').expect(200);
    expect(disconnected.calls.list).toBe(2);

    const failing = setup({ status: 502, answer: () => ({ error: 'down' }) });
    await request(failing.app).get('/api/source-control/github/pulls/list').expect(502);
    await request(failing.app).get('/api/source-control/github/pulls/list').expect(502);
    expect(failing.calls.list).toBe(2);

    const other = setup();
    await request(other.app).get('/api/source-control/github/auth/status');
    await request(other.app).get('/api/source-control/github/auth/status');
    expect(other.calls.status).toBe(2);
  });

  it('forgets a provider\'s answers after a change to it, including one still in flight', async () => {
    const { app, cache, calls, hold } = setup();
    await request(app).get('/api/source-control/github/pulls/list').expect(200);
    await request(app).post('/api/source-control/github/pr/merge').expect(200);
    await request(app).get('/api/source-control/github/pulls/list').expect(200);
    expect(calls.list).toBe(2);

    const release = hold();
    const settled = request(app).get('/api/source-control/github/pulls/list?page=2').then((response) => response);
    await vi.waitFor(() => expect(calls.list).toBe(3));
    cache.clear();
    release();
    await settled;
    await request(app).get('/api/source-control/github/pulls/list?page=2').expect(200);
    expect(calls.list).toBe(4);
  });

  it('forgets a provider\'s answers when asked to refresh, and only that provider\'s', async () => {
    const { app, calls } = setup();
    await request(app).get('/api/source-control/github/pulls/list').expect(200);
    await request(app).post('/api/source-control/gitlab/read-cache/refresh').expect(200, { ok: true });
    await request(app).get('/api/source-control/github/pulls/list').expect(200);
    expect(calls.list).toBe(1);

    await request(app).post('/api/source-control/github/read-cache/refresh').expect(200, { ok: true });
    await request(app).get('/api/source-control/github/pulls/list').expect(200);
    expect(calls.list).toBe(2);
  });

  // #1770: the total-bytes bound. Bodies are sized so exactly two answers
  // fit under the cap; the byte size is the JSON the cache counts.
  const sizedAnswer = (req) => ({ page: req.query.page ?? '1', data: 'x'.repeat(200) });
  const sizedBytes = (page) => Buffer.byteLength(JSON.stringify(sizedAnswer({ query: { page } })));
  const twoFit = () => sizedBytes('1') + sizedBytes('2');

  it('evicts the oldest answers while the total-bytes bound is exceeded, keeping recent ones', async () => {
    const { app, calls } = setup({ answer: sizedAnswer, cacheOptions: { maxTotalBytes: twoFit() } });
    const get = (page) => request(app).get(`/api/source-control/github/pulls/list?accountId=a&page=${page}`).expect(200);
    await get('1');
    await get('2');
    await get('3');
    expect(calls.list).toBe(3);
    // Recent answers still hit; the oldest was evicted and is re-fetched.
    await get('3');
    await get('2');
    expect(calls.list).toBe(3);
    await get('1');
    expect(calls.list).toBe(4);
  });

  it('does not double-count bytes when an answer is remembered again after expiry', async () => {
    const { app, calls, tick } = setup({ answer: sizedAnswer, cacheOptions: { maxTotalBytes: twoFit() } });
    const get = (page) => request(app).get(`/api/source-control/github/pulls/list?accountId=a&page=${page}`).expect(200);
    await get('1');
    tick(31_000);
    await get('1');
    expect(calls.list).toBe(2);
    await get('2');
    expect(calls.list).toBe(3);
    // Both fit exactly under the cap; a double-counted page 1 would have
    // evicted one of them.
    await get('1');
    await get('2');
    expect(calls.list).toBe(3);
  });

  it('leaves the byte accounting at the true retained total after a clear', async () => {
    const { app, cache, calls } = setup({ answer: sizedAnswer, cacheOptions: { maxTotalBytes: twoFit() } });
    const get = (page) => request(app).get(`/api/source-control/github/pulls/list?accountId=a&page=${page}`).expect(200);
    await get('1');
    await get('2');
    expect(calls.list).toBe(2);
    cache.clear('github');
    await get('1');
    await get('2');
    expect(calls.list).toBe(4);
    // Refills retained exactly two answers: both still hit. Leaked bytes
    // from before the clear would have evicted one during the refill.
    await get('1');
    await get('2');
    expect(calls.list).toBe(4);
  });
});
