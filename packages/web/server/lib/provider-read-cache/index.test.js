import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createProviderReadCache } from './index.js';

function setup({ answer = (req) => ({ items: [req.query.page ?? '1'] }), status = 200 } = {}) {
  let clock = 1_000;
  const cache = createProviderReadCache({ now: () => clock });
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
});
