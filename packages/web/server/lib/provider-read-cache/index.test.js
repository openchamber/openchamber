import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createProviderReadCache } from './index.js';

function setup({ answer = (req) => ({ items: [req.query.page ?? '1'] }), status = 200 } = {}) {
  let clock = 1_000;
  const changed = [];
  const cache = createProviderReadCache({ now: () => clock, onChange: (provider) => changed.push(provider) });
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
  app.post('/api/source-control/github/references/across', (_req, res) => res.json({ items: [] }));
  app.get('/api/source-control/github/auth/status', (_req, res) => { calls.status = (calls.status ?? 0) + 1; res.json({ ok: true }); });
  const hold = () => {
    let release;
    gate = { promise: new Promise((resolve) => { release = resolve; }) };
    return () => { gate = null; release(); };
  };
  return { app, cache, calls, changed, hold, tick: (ms) => { clock += ms; } };
}

describe('provider read cache', () => {
  it('forgets only what a scoped refresh names: one item, or the lists', async () => {
    const changed = [];
    const refreshed = [];
    const cache = createProviderReadCache({
      now: () => 1_000,
      onChange: (provider) => changed.push(provider),
      onItemRefresh: (provider, item) => refreshed.push({ provider, ...item }),
    });
    const app = express();
    app.use(cache.middleware);
    const calls = {};
    const count = (name) => (_req, res) => { calls[name] = (calls[name] ?? 0) + 1; res.json({ connected: true }); };
    app.get('/api/source-control/github/references/detail', count('detail'));
    app.get('/api/source-control/github/references/status', count('status'));
    app.get('/api/source-control/github/references', count('search'));
    const reads = () => Promise.all([
      request(app).get('/api/source-control/github/references/detail').query({ owner: 'Acme', repo: 'App', number: 7 }),
      request(app).get('/api/source-control/github/references/detail').query({ owner: 'acme', repo: 'app', number: 8 }),
      request(app).get('/api/source-control/github/references/status').query({ pulls: 'acme/app#7,acme/app#9' }),
      request(app).get('/api/source-control/github/references').query({ kind: 'pull', query: 'https://github.com/acme/app/pull/7' }),
      request(app).get('/api/source-control/github/references').query({ kind: 'pull', state: 'open' }),
    ]);
    await reads();
    expect(calls).toEqual({ detail: 2, status: 1, search: 2 });

    // One item: its detail, a status read that asked for it, and the Tracker's
    // lookup of its link go; #8 and the plain list stay.
    await request(app).post('/api/source-control/github/read-cache/refresh').query({ scope: 'item', owner: 'acme', repo: 'app', number: 7 }).expect(200);
    await reads();
    expect(calls).toEqual({ detail: 3, status: 2, search: 3 });
    expect(refreshed).toEqual([{ provider: 'github', owner: 'acme', repo: 'app', number: 7 }]);

    // The lists: the searches and statuses go, the details stay.
    await request(app).post('/api/source-control/github/read-cache/refresh').query({ scope: 'lists' }).expect(200);
    await reads();
    expect(calls).toEqual({ detail: 3, status: 3, search: 5 });
    // Neither asks every followed item again.
    expect(changed).toEqual([]);
  });

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

  it('reports a change and a refresh to the provider, never a read sent as a POST', async () => {
    const { app, calls, changed } = setup();
    await request(app).get('/api/source-control/github/pulls/list').expect(200);
    await request(app).post('/api/source-control/github/references/across').expect(200);
    await request(app).get('/api/source-control/github/pulls/list').expect(200);
    expect(calls.list).toBe(1);
    expect(changed).toEqual([]);

    await request(app).post('/api/source-control/github/pr/merge').expect(200);
    await request(app).post('/api/source-control/gitlab/read-cache/refresh').expect(200);
    expect(changed).toEqual(['github', 'gitlab']);
  });

  it('serves a tracker under its route and the legacy Linear alias as one provider', async () => {
    const changed = [];
    const cache = createProviderReadCache({ trackerIds: ['linear'], now: () => 1_000, onChange: (provider) => changed.push(provider) });
    const app = express();
    app.use(cache.middleware);
    const calls = { tracker: 0, legacy: 0 };
    app.get('/api/tracker/linear/items/list', (_req, res) => { calls.tracker += 1; res.json({ connected: true, items: [] }); });
    app.get('/api/linear/issues/list', (_req, res) => { calls.legacy += 1; res.json({ connected: true, issues: [] }); });
    app.post('/api/tracker/linear/items/update', (_req, res) => res.json({ connected: true }));
    // `providers` is not a tracker: the descriptor list is never cached here.
    app.get('/api/tracker/providers', (_req, res) => res.json({ providers: [] }));
    const reads = () => Promise.all([
      request(app).get('/api/tracker/linear/items/list').query({ state: 'open' }),
      request(app).get('/api/linear/issues/list').query({ status: 'open' }),
    ]);
    await reads();
    await reads();
    expect(calls).toEqual({ tracker: 1, legacy: 1 });

    // A change through the tracker route forgets the alias's answers too.
    await request(app).post('/api/tracker/linear/items/update').expect(200);
    expect(changed).toEqual(['linear']);
    await reads();
    expect(calls).toEqual({ tracker: 2, legacy: 2 });

    // A list refresh through the alias, sliced with the alias's own prefix,
    // forgets the tracker route's lists as well.
    await request(app).post('/api/linear/read-cache/refresh').query({ scope: 'lists' }).expect(200);
    await reads();
    expect(calls).toEqual({ tracker: 3, legacy: 3 });
  });

  it('forgets one tracker item by its identifier and reports it', async () => {
    const refreshed = [];
    const cache = createProviderReadCache({
      trackerIds: ['linear'],
      now: () => 1_000,
      onItemRefresh: (provider, item) => refreshed.push({ provider, ...item }),
    });
    const app = express();
    app.use(cache.middleware);
    const calls = {};
    const count = (name, body) => (_req, res) => { calls[name] = (calls[name] ?? 0) + 1; res.json(body); };
    app.get('/api/tracker/linear/items/get', (req, res) => count(`get-${req.query.id}`, {
      connected: true, item: { identifier: req.query.id === 'uuid-12' ? 'ENG-12' : 'ENG-13' },
    })(req, res));
    app.get('/api/linear/issues/get', count('legacy-get', { connected: true, issue: { identifier: 'ENG-12' } }));
    app.get('/api/tracker/linear/items/list', count('list', { connected: true, items: [] }));
    const reads = () => Promise.all([
      request(app).get('/api/tracker/linear/items/get').query({ id: 'uuid-12' }),
      request(app).get('/api/tracker/linear/items/get').query({ id: 'uuid-13' }),
      request(app).get('/api/linear/issues/get').query({ id: 'uuid-12' }),
      request(app).get('/api/tracker/linear/items/list').query({ state: 'open' }),
    ]);
    await reads();
    await request(app).post('/api/tracker/linear/read-cache/refresh').query({ scope: 'item' }).expect(400);
    await request(app).post('/api/tracker/linear/read-cache/refresh').query({ scope: 'item', identifier: 'eng-12' }).expect(200);
    await reads();
    // ENG-12's reads under both prefixes go; ENG-13 and the list stay.
    expect(calls).toEqual({ 'get-uuid-12': 2, 'get-uuid-13': 1, 'legacy-get': 2, list: 1 });
    expect(refreshed).toEqual([{ provider: 'linear', identifier: 'ENG-12' }]);
  });

  it('caches only the source-control providers it was given', async () => {
    const cache = createProviderReadCache({ sourceControlProviderIds: ['gitlab'] });
    const app = express();
    app.use(cache.middleware);
    let calls = 0;
    app.get('/api/source-control/github/pulls/list', (_req, res) => { calls += 1; res.json({ items: [] }); });
    await request(app).get('/api/source-control/github/pulls/list');
    await request(app).get('/api/source-control/github/pulls/list');
    expect(calls).toBe(2);
  });
});
