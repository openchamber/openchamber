import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackerProviderTimeoutMs } from '@openchamber/sdk';

import { createOutboundHandles } from '../source-control/outbound-handles.js';
import { createTrackerAccounts, trackerAccountsPersistPath } from './extension-accounts.js';
import { buildExtensionTrackerDescriptor } from './extension-descriptor.js';
import { createTrackerOAuth } from './extension-oauth.js';
import { createExtensionTracker, isTrackerGuest, normalizeTrackerInstance } from './extension-tracker.js';

const contribution = {
  wire: 1,
  label: 'YouTrack',
  instances: { kind: 'user', label: 'Server address', placeholder: 'https://youtrack.example.com' },
  auth: {
    token: { header: 'authorization', scheme: 'bearer' },
    oauth: { authorizeUrl: '/hub/api/rest/oauth2/auth', tokenUrl: '/hub/api/rest/oauth2/token', scopes: ['YouTrack'] },
  },
  capabilities: { multipleAccounts: true, stateUpdate: true, children: true, labels: true, priority: true, filters: { people: true, priority: true }, projectMapping: true, sessionComments: true },
  stateFilters: ['open', 'all', 'todo', 'in-progress', 'done'],
  identifier: 'key-number',
  urls: { item: ['/issue/{id}'] },
};

const trackerGuest = (overrides = {}) => ({
  id: 'youtrack', name: 'YouTrack Bridge', packageRoot: '/pkg/youtrack', enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', provides: ['tracker'] },
  tracker: contribution,
  capabilityGrants: ['service'],
  ...overrides,
});

const INSTANCE = 'https://yt.example.com';
const summary = (identifier = 'PROJ-1') => ({
  id: `id-${identifier}`, identifier, title: `Item ${identifier}`, url: `${INSTANCE}/issue/${identifier}`,
  state: { id: 's-1', name: 'Open', category: 'todo' }, priority: 'high', labels: [], assignee: null, container: { id: 'p-1', key: 'PROJ', name: 'Project' },
});

const dirs = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** An adapter over a real account store and real handles, with a scripted service and a scripted server behind the handles. */
const harness = async ({ guest = trackerGuest(), server = async () => new Response('{}', { status: 200 }), instance = null, wrapAccounts = (value) => value } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-tracker-'));
  dirs.push(dir);
  let clock = Date.now();
  const accounts = createTrackerAccounts({ persistPath: trackerAccountsPersistPath(dir), now: () => (clock += 1) });
  const handles = createOutboundHandles({ fetch: server, now: () => clock });
  const oauth = createTrackerOAuth({ now: () => clock });
  const calls = [];
  const warnings = [];
  let catalog = guest;
  const answers = {
    'auth.probe': () => ({ ok: true, data: { supported: true } }),
    'auth.verify': () => ({ ok: true, data: { account: { id: 'u-1', login: 'mona', name: 'Mona' } } }),
    'items.list': () => ({ ok: true, data: { items: [summary()], cursor: null, hasMore: false } }),
    'items.get': () => ({ ok: true, data: { item: { ...summary(), description: 'Steps', comments: [], children: [summary('PROJ-2')], childrenMore: false, parent: summary('PROJ-0') } } }),
    'items.updateState': (request) => ({ ok: true, data: { item: { ...summary(), state: { id: request.input.stateId, name: 'Done', category: 'done' } } } }),
    'items.liveSummaries': (request) => ({ ok: true, data: { items: request.input.identifiers.map((identifier) => ({ identifier, title: `Item ${identifier}`, state: { name: 'Open', category: 'todo' } })) } }),
    'states.list': () => ({ ok: true, data: { states: [{ id: 's-1', name: 'Open', category: 'todo', position: 0 }] } }),
    'containers.list': () => ({ ok: true, data: { containers: [{ id: 'p-1', key: 'PROJ', name: 'Project' }, { id: 'p-2', key: 'OPS', name: 'Ops' }] } }),
    'comments.create': () => ({ ok: true, data: { comment: { id: 'c-1' } } }),
  };
  let proxyFailure = null;
  /** The scripted service: records the call, optionally sends outbound through the handle, and answers. */
  const proxy = async (params) => {
    const request = JSON.parse(params.body);
    calls.push({ params, request });
    if (proxyFailure) throw proxyFailure;
    const answer = await answers[request.method](request, params);
    return typeof answer === 'string' ? { status: 200, body: answer } : { status: 200, body: JSON.stringify(answer) };
  };
  const reconcile = vi.fn(async () => {});
  const descriptor = buildExtensionTrackerDescriptor({ guestId: guest.id, contribution: guest.tracker, instance });
  const tracker = createExtensionTracker({
    descriptor, guest, contribution: guest.tracker,
    currentGuest: async () => catalog,
    reconcile, accounts: wrapAccounts(accounts), handles, oauth,
    persistPath: '/data/extensions.json',
    proxy,
    now: () => clock,
    createId: (() => { let n = 0; return () => `req-${n += 1}`; })(),
    warn: (...args) => warnings.push(args.join(' ')),
  });
  return {
    tracker, accounts, handles, oauth, calls, warnings, answers, reconcile, descriptor,
    setCatalog: (next) => { catalog = next; },
    failProxyWith: (error) => { proxyFailure = error; },
    tick: (ms) => { clock += ms; },
    /** The service's own outbound request through the call's handle, as the callback listener serves it. */
    outbound: (request, body) => handles.serve({ bearer: request.session.handle, body }),
  };
};

const connect = (h, extra = {}) => h.tracker.auth.connectToken({ instance: INSTANCE, token: 'secret-1', ...extra });

describe('isTrackerGuest and the typed instance', () => {
  it('needs an enabled, fully approved package with the role and its contribution', () => {
    expect(isTrackerGuest(trackerGuest())).toBe(true);
    expect(isTrackerGuest(trackerGuest({ enabled: false }))).toBe(false);
    expect(isTrackerGuest(trackerGuest({ capabilityGrants: [] }))).toBe(false);
    expect(isTrackerGuest(trackerGuest({ tracker: undefined }))).toBe(false);
    expect(isTrackerGuest(trackerGuest({ service: { entry: 'service/main.js', runtime: 'host', provides: ['notifications'] } }))).toBe(false);
    expect(isTrackerGuest(trackerGuest({ id: 'a'.repeat(29) }))).toBe(false);
  });

  it('a typed instance is an https origin, or http on this machine', () => {
    expect(normalizeTrackerInstance(' https://yt.example.com/ ')).toBe('https://yt.example.com');
    expect(normalizeTrackerInstance('http://127.0.0.1:4568')).toBe('http://127.0.0.1:4568');
    for (const value of ['http://yt.example.com', 'https://yt.example.com/issues', 'https://u:p@yt.example.com', 'https://yt.example.com/?x=1', 'ftp://yt.example.com', 'nope', 42]) {
      expect(normalizeTrackerInstance(value)).toBeNull();
    }
  });
});

describe('connecting an extension tracker with a token', () => {
  it('probes the instance, verifies through the service with a handle that carries the token, stores the account and reports it', async () => {
    const h = await harness();
    const view = await connect(h);
    expect(view).toMatchObject({ instance: INSTANCE, activeAccountId: 'u-1', accounts: [{ id: 'u-1', login: 'mona', name: 'Mona', status: 'valid', method: 'token' }] });
    expect(h.calls.map((call) => call.request.method)).toEqual(['auth.probe', 'auth.verify']);
    expect(h.calls[0].request).toMatchObject({ v: 1, provider: 'ext-youtrack', session: { instance: INSTANCE, account: null } });
    expect(h.calls[0].params).toMatchObject({ guestId: 'youtrack', path: '/tracker', method: 'POST', granted: ['service'] });
    // The handle, never the token, travels to the service.
    expect(JSON.stringify(h.calls)).not.toContain('secret-1');
    expect(h.reconcile).toHaveBeenCalled();

    const status = await h.tracker.auth.status({ origin: 'https://app.example.com' });
    expect(status).toMatchObject({
      connected: true,
      account: { id: 'u-1', name: 'Mona', current: true, status: 'valid', method: 'token' },
      connect: { instance: INSTANCE, instances: { kind: 'user', label: 'Server address' }, hasClient: false, redirectUri: 'https://app.example.com/api/tracker/ext-youtrack/oauth/callback' },
    });
    expect(JSON.stringify(status)).not.toContain('secret-1');
  });

  it('refuses what cannot be connected before anything is sent, and a server the extension cannot work with', async () => {
    const h = await harness();
    await expect(connect(h, { token: '  ' })).rejects.toMatchObject({ status: 400, code: 'TOKEN_REQUIRED' });
    await expect(h.tracker.auth.connectToken({ instance: 'http://yt.example.com', token: 't' })).rejects.toMatchObject({ status: 400, code: 'INSTANCE_REQUIRED' });
    expect(h.calls).toHaveLength(0);
    h.answers['auth.probe'] = () => ({ ok: true, data: { supported: false, message: 'Not a YouTrack server' } });
    await expect(connect(h)).rejects.toMatchObject({ status: 400, code: 'UNSUPPORTED_INSTANCE', message: 'Not a YouTrack server' });
    h.answers['auth.probe'] = () => ({ ok: true, data: { supported: true } });
    h.answers['auth.verify'] = () => ({ ok: false, error: { message: 'bad token', status: 401 } });
    // A 401 the server did not give is a malformed answer, and a refused token is said so once the server gave it.
    await expect(connect(h)).rejects.toMatchObject({ status: 502, code: 'MALFORMED_PROVIDER_RESPONSE' });
    const refusing = await harness({ server: async () => new Response('', { status: 401 }) });
    refusing.answers['auth.verify'] = async (request) => {
      await refusing.outbound(request, { method: 'GET', path: '/api/users/me' });
      return { ok: false, error: { message: 'bad token', status: 401 } };
    };
    await expect(connect(refusing)).rejects.toMatchObject({ status: 401, code: 'TOKEN_REFUSED' });
    expect((await refusing.tracker.auth.status()).connected).toBe(false);
  });

  it('a basic-auth tracker stores the typed username as the login and refuses one the handle cannot send', async () => {
    const basic = { ...contribution, auth: { token: { header: 'authorization', scheme: 'basic', username: true } } };
    const h = await harness({ guest: trackerGuest({ tracker: basic }) });
    await expect(connect(h)).rejects.toMatchObject({ code: 'USERNAME_REQUIRED' });
    await expect(connect(h, { username: 'mo:na' })).rejects.toMatchObject({ code: 'USERNAME_INVALID' });
    const view = await connect(h, { username: 'mona@corp' });
    expect(view.accounts[0].login).toBe('mona@corp');
  });

  it('a disconnect while the verification is pending wins, and the next connect lands', async () => {
    const h = await harness();
    let release;
    h.answers['auth.verify'] = () => new Promise((resolve) => { release = resolve; });
    const pending = connect(h);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await h.tracker.auth.disconnect()).toEqual({ removed: false });
    release({ ok: true, data: { account: { id: 'u-1', login: 'mona' } } });
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'CONNECT_SUPERSEDED' });
    expect((await h.tracker.auth.status()).connected).toBe(false);
  });

  it('the first-started connect that finishes last is refused: the newer account stands', async () => {
    const h = await harness();
    let releaseFirst;
    let verifies = 0;
    h.answers['auth.verify'] = async () => {
      verifies += 1;
      if (verifies === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
        return { ok: true, data: { account: { id: 'u-1', login: 'mona' } } };
      }
      return { ok: true, data: { account: { id: 'u-2', login: 'bob' } } };
    };
    const first = connect(h, { token: 'secret-1' });
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    const second = await connect(h, { token: 'secret-2' });
    expect(second.activeAccountId).toBe('u-2');
    releaseFirst();
    await expect(first).rejects.toMatchObject({ status: 409, code: 'CONNECT_SUPERSEDED' });
    const status = await h.tracker.auth.status();
    expect(status.accounts.map((account) => account.id)).toEqual(['u-2']);
    expect(JSON.stringify(await h.accounts.read('ext-youtrack'))).not.toContain('secret-1');
  });

  it('a full tracker refuses the thirty-third account before the service, or the browser, is asked anything', async () => {
    const h = await harness();
    for (let index = 1; index <= 32; index += 1) {
      h.answers['auth.verify'] = () => ({ ok: true, data: { account: { id: `u-${index}`, login: `user${index}` } } });
      await connect(h, { token: `secret-${index}` });
    }
    const sent = h.calls.length;
    await expect(connect(h, { token: 'secret-33' })).rejects.toMatchObject({ status: 409, code: 'ACCOUNTS_FULL' });
    await expect(h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' })).rejects.toMatchObject({ status: 409, code: 'ACCOUNTS_FULL' });
    expect(h.calls).toHaveLength(sent);
    expect((await h.tracker.auth.status()).accounts).toHaveLength(32);
  });

  it('a second account joins the same server; another server is refused while accounts live here', async () => {
    const h = await harness();
    await connect(h);
    h.answers['auth.verify'] = () => ({ ok: true, data: { account: { id: 'u-2', login: 'bob' } } });
    const view = await connect(h, { token: 'secret-2' });
    expect(view.accounts.map((account) => account.id)).toEqual(['u-1', 'u-2']);
    expect(view.activeAccountId).toBe('u-2');
    // Another server is refused while accounts live on this one; the stored one stands when nothing is typed.
    await expect(h.tracker.auth.connectToken({ instance: 'https://other.example.com', token: 'x' })).rejects.toMatchObject({ status: 409, code: 'INSTANCE_MISMATCH' });
    await expect(h.tracker.auth.connectToken({ token: 'x' })).resolves.toMatchObject({ instance: INSTANCE });
    expect((await h.tracker.auth.activate('u-1')).account.id).toBe('u-1');
    expect(await h.tracker.auth.activate('nope')).toBeNull();
    expect(await h.tracker.auth.disconnect()).toEqual({ removed: true });
    expect((await h.tracker.auth.status()).account.id).toBe('u-2');
  });
});

describe('reading and writing through an extension tracker', () => {
  it('answers disconnected without an account and nothing is sent', async () => {
    const h = await harness();
    expect(await h.tracker.list({ state: 'open' })).toEqual({ connected: false });
    expect(await h.tracker.get('id-PROJ-1')).toEqual({ connected: false });
    expect(await h.tracker.liveSummaries(['PROJ-1'])).toEqual({ connected: false });
    expect(await h.tracker.mapping.get()).toEqual({ connected: false });
    expect(h.calls).toHaveLength(0);
  });

  it('forwards reads as the current account and sets the provider on every item, parent and child', async () => {
    const h = await harness();
    await connect(h);
    const list = await h.tracker.list({ query: 'login', state: 'todo', people: 'me', priority: 'all', containerId: null });
    expect(list).toMatchObject({ connected: true, hasMore: false, cursor: null, items: [{ provider: 'ext-youtrack', identifier: 'PROJ-1' }] });
    const listCall = h.calls.at(-1).request;
    expect(listCall).toMatchObject({ method: 'items.list', session: { instance: INSTANCE, account: { id: 'u-1', login: 'mona' } }, input: { query: 'login', state: 'todo', people: 'me', priority: 'all', containerId: null } });
    expect(h.calls.at(-1).params.granted).toEqual(['service']);
    const got = await h.tracker.get('id-PROJ-1');
    expect(got.item).toMatchObject({ provider: 'ext-youtrack', parent: { provider: 'ext-youtrack', identifier: 'PROJ-0' }, children: [{ provider: 'ext-youtrack', identifier: 'PROJ-2' }] });
    expect(await h.tracker.states('p-1')).toEqual({ connected: true, states: [{ id: 's-1', name: 'Open', category: 'todo', position: 0 }] });
    const updated = await h.tracker.updateState({ id: 'id-PROJ-1', stateId: 's-9' });
    expect(updated.item).toMatchObject({ provider: 'ext-youtrack', state: { id: 's-9', category: 'done' } });
    // Defaults the shell leaves out are filled in before the service sees them.
    await h.tracker.list();
    expect(h.calls.at(-1).request.input).toEqual({ state: 'open', people: 'any', priority: 'all', containerId: null });
  });

  it('a pasted link the patterns claim, or an identifier of the declared shape, reads that one item instead of searching', async () => {
    // The descriptor built for the connected server: its link patterns exist only once the instance is known.
    const h = await harness({ instance: INSTANCE });
    await connect(h);
    const linked = await h.tracker.list({ query: ` ${INSTANCE}/issue/proj-1 `, state: 'open' });
    expect(h.calls.at(-1).request).toMatchObject({ method: 'items.get', input: { id: 'PROJ-1' } });
    expect(linked).toEqual({ connected: true, cursor: null, hasMore: false, items: [expect.objectContaining({ provider: 'ext-youtrack', identifier: 'PROJ-1' })] });
    // The listing's shape: what `items.get` adds stays out of a page.
    expect(linked.items[0]).not.toHaveProperty('description');
    expect(linked.items[0]).not.toHaveProperty('children');
    await h.tracker.list({ query: 'proj-9' });
    expect(h.calls.at(-1).request).toMatchObject({ method: 'items.get', input: { id: 'PROJ-9' } });
    h.answers['items.get'] = () => ({ ok: true, data: { item: null } });
    // A link to an item that is not there is an empty page; a bare word that is
    // no identifier after all is searched (a `short-code` shape claims most words).
    expect(await h.tracker.list({ query: `${INSTANCE}/issue/PROJ-404` })).toEqual({ connected: true, items: [], cursor: null, hasMore: false });
    expect(h.calls.at(-1).request.method).toBe('items.get');
    const searched = await h.tracker.list({ query: 'PROJ-404', state: 'open' });
    expect(h.calls.at(-1).request).toMatchObject({ method: 'items.list', input: { query: 'PROJ-404', state: 'open' } });
    expect(searched.items.map((item) => item.identifier)).toEqual(['PROJ-1']);
    // Another host's link, or free text, is a search like any other.
    await h.tracker.list({ query: 'https://other.example.com/issue/PROJ-1' });
    expect(h.calls.at(-1).request).toMatchObject({ method: 'items.list', input: { query: 'https://other.example.com/issue/PROJ-1' } });
    await h.tracker.list({ query: 'proj 1' });
    expect(h.calls.at(-1).request.method).toBe('items.list');
  });

  it('a read\'s handle sends GET only; a write\'s may send anything', async () => {
    const seen = [];
    const h = await harness({ server: async (url, init) => { seen.push(`${init.method} ${new URL(url).pathname}`); return new Response('{}', { status: 200 }); } });
    await connect(h);
    h.answers['items.get'] = async (request) => {
      const refused = await h.outbound(request, { method: 'POST', path: '/api/issues', body: '{}' });
      const allowed = await h.outbound(request, { method: 'GET', path: '/api/issues/1' });
      return { ok: true, data: { item: refused.status === 403 && allowed.status === 200 ? summary() : null } };
    };
    expect((await h.tracker.get('x')).item).not.toBeNull();
    h.answers['items.updateState'] = async (request) => {
      const written = await h.outbound(request, { method: 'POST', path: '/api/issues/1/state', body: '{}' });
      return { ok: true, data: { item: written.status === 200 ? summary() : null } };
    };
    expect((await h.tracker.updateState({ id: 'x', stateId: 's' })).item).not.toBeNull();
    expect(seen).toEqual(['GET /api/issues/1', 'POST /api/issues/1/state']);
    // The handle carried the stored token to the server, never to the service.
    expect(JSON.stringify(h.calls)).not.toContain('secret-1');
  });

  it('a refused credential writes the account off only when the server gave the 401, at the revision it was read at', async () => {
    const h = await harness({ server: async () => new Response('', { status: 401 }) });
    await connect(h);
    h.answers['items.list'] = () => ({ ok: false, error: { message: 'expired', status: 401 } });
    await expect(h.tracker.list()).rejects.toMatchObject({ code: 'MALFORMED_PROVIDER_RESPONSE' });
    expect((await h.tracker.auth.status()).connected).toBe(true);
    h.answers['items.list'] = async (request) => {
      await h.outbound(request, { method: 'GET', path: '/api/issues' });
      return { ok: false, error: { message: 'expired', status: 401 } };
    };
    await expect(h.tracker.list()).rejects.toMatchObject({ status: 401, kind: 'invalid-token' });
    const status = await h.tracker.auth.status();
    // Written off, not gone: the card shows the account with the reason, on its server, and can remove it.
    expect(status).toMatchObject({ connected: false, accounts: [{ id: 'u-1', status: 'invalid', invalidReason: 'unauthorized', current: false }], connect: { instance: INSTANCE } });
    expect(h.warnings.join('\n')).toContain('refused');
    expect(await h.tracker.auth.disconnect()).toEqual({ removed: true });
    expect(await h.tracker.auth.status()).toEqual({ connected: false, connect: expect.objectContaining({ instance: null }) });
    // A delayed 401 for the replaced credential cannot write the replacement off.
    h.answers['auth.probe'] = () => ({ ok: true, data: { supported: true } });
    let release;
    h.answers['items.list'] = async (request) => {
      await h.outbound(request, { method: 'GET', path: '/api/issues' });
      await new Promise((resolve) => { release = resolve; });
      return { ok: false, error: { message: 'expired', status: 401 } };
    };
    await connect(h, { token: 'secret-2' });
    const delayed = h.tracker.list();
    await vi.waitFor(() => expect(release).toBeDefined());
    await connect(h, { token: 'secret-3' });
    release();
    await expect(delayed).rejects.toMatchObject({ status: 401 });
    expect((await h.tracker.auth.status()).connected).toBe(true);
  });

  it('a service that does not answer in time is unavailable, not a refused credential: nothing is written off, and each method gets its own deadline', async () => {
    const h = await harness();
    await connect(h);
    // The proxy gives a timed-out or dropped request `REQUEST_FAILED`, a service that never came up `SERVICE_FAILED`.
    h.failProxyWith(Object.assign(new Error('Guest service request failed.'), { code: 'REQUEST_FAILED' }));
    await expect(h.tracker.list()).rejects.toMatchObject({ status: 503, kind: 'unavailable', code: 'REQUEST_FAILED' });
    await expect(h.tracker.updateState({ id: 'id-PROJ-1', stateId: 's-1' })).rejects.toMatchObject({ status: 503, kind: 'unavailable' });
    await expect(connect(h, { token: 'secret-2' })).rejects.toMatchObject({ status: 503, code: 'TRACKER_UNAVAILABLE' });
    await expect(h.tracker.sessionStatus.post({ kind: 'started', sessionId: 'ses_1', identifier: 'PROJ-1', sessionOrigin: 'https://app.example.com' })).resolves.toMatchObject({ skipped: 'disabled' });
    const status = await h.tracker.auth.status();
    expect(status).toMatchObject({ connected: true, accounts: [{ id: 'u-1', status: 'valid' }] });
    // The deadline handed to the proxy, and to the handle, is the method's own.
    const byMethod = Object.fromEntries(h.calls.map((call) => [call.request.method, call.params.timeoutMs]));
    expect(byMethod['items.list']).toBe(trackerProviderTimeoutMs('items.list'));
    expect(byMethod['items.updateState']).toBe(trackerProviderTimeoutMs('items.updateState'));
    expect(byMethod['auth.probe']).toBe(trackerProviderTimeoutMs('auth.probe'));
    expect(trackerProviderTimeoutMs('items.updateState')).toBeGreaterThan(trackerProviderTimeoutMs('items.list'));
    // Once the service answers again, the account reads as before.
    h.failProxyWith(null);
    expect((await h.tracker.list()).items).toHaveLength(1);
  });

  it('a paused, removed or unapproved extension is refused before anything is sent and the set is reconciled', async () => {
    const h = await harness();
    await connect(h);
    h.setCatalog(trackerGuest({ enabled: false }));
    await expect(h.tracker.list()).rejects.toMatchObject({ code: 'NO_SERVICE', kind: 'unavailable', status: 503 });
    expect(h.calls.map((call) => call.request.method)).toEqual(['auth.probe', 'auth.verify']);
    expect(h.reconcile.mock.calls.length).toBeGreaterThan(1);
    h.setCatalog(trackerGuest());
    h.failProxyWith(Object.assign(new Error('not running'), { code: 'SERVICE_FAILED' }));
    await expect(h.tracker.list()).rejects.toMatchObject({ code: 'SERVICE_FAILED', kind: 'unavailable' });
  });

  it('reads live summaries in batches of fifty and recognises its links', async () => {
    const h = await harness({ instance: INSTANCE });
    await connect(h);
    const identifiers = Array.from({ length: 60 }, (_, index) => `PROJ-${index + 1}`);
    const result = await h.tracker.liveSummaries(identifiers);
    expect(result.connected && result.items).toHaveLength(60);
    expect(h.calls.filter((call) => call.request.method === 'items.liveSummaries').map((call) => call.request.input.identifiers.length)).toEqual([50, 10]);
    expect(h.tracker.matchUrl('https://yt.example.com/issue/proj-7')).toBe('PROJ-7');
    expect(h.tracker.matchUrl('https://other.example.com/issue/PROJ-7')).toBeNull();
  });

  it('merges the stored mapping with the containers the service lists, and keeps preferences', async () => {
    const h = await harness();
    await connect(h);
    expect(await h.tracker.mapping.get()).toEqual({ connected: true, defaultProjectPath: null, containers: [{ id: 'p-1', key: 'PROJ', name: 'Project', projectPath: null }, { id: 'p-2', key: 'OPS', name: 'Ops', projectPath: null }] });
    const saved = await h.tracker.mapping.set({ defaultProjectPath: '/repo', containerProjectPaths: { 'p-2': '/ops', 'p-9': '/gone', 'p-1': '' } });
    expect(saved).toEqual({ connected: true, defaultProjectPath: '/repo', containers: [{ id: 'p-1', key: 'PROJ', name: 'Project', projectPath: null }, { id: 'p-2', key: 'OPS', name: 'Ops', projectPath: '/ops' }] });
    expect(await h.tracker.preferences.get()).toEqual({ sessionComments: false });
    expect(await h.tracker.preferences.set({ sessionComments: true })).toEqual({ sessionComments: true });
  });
});

describe('session comments on an extension tracker', () => {
  const post = (h, input) => h.tracker.sessionStatus.post({ sessionOrigin: 'https://app.example.com', ...input });

  it('posts started, then completed and failure once each, with a link only to a public origin, through comments.create', async () => {
    const h = await harness();
    expect(await post(h, { kind: 'started', sessionId: 'ses_1', identifier: 'proj-1' })).toEqual({ connected: false });
    await connect(h);
    expect(await post(h, { kind: 'started', sessionId: 'ses_1', identifier: 'proj-1' })).toEqual({ connected: true, posted: false, skipped: 'disabled' });
    await h.tracker.preferences.set({ sessionComments: true });
    expect(await post(h, { kind: 'completed', sessionId: 'ses_1', identifier: 'PROJ-1' })).toEqual({ connected: true, posted: false, skipped: 'not-started' });
    expect(await post(h, { kind: 'started', sessionId: 'ses_1', identifier: 'proj-1' })).toEqual({ connected: true, posted: true, commentId: 'c-1' });
    expect(h.calls.at(-1).request).toMatchObject({ method: 'comments.create', input: { identifier: 'PROJ-1', body: '[OpenChamber session started](https://app.example.com/?session=ses_1)' } });
    expect(await post(h, { kind: 'started', sessionId: 'ses_1' })).toEqual({ connected: true, posted: false, skipped: 'already-posted' });
    // The runtime posts completed and failure for a started session, without an identifier or origin of its own.
    const runtime = h.tracker.sessionStatus.createRuntime();
    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_other', status: { type: 'idle' } } });
    runtime.processPayload({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError' } } });
    await vi.waitFor(() => expect(h.calls.filter((call) => call.request.method === 'comments.create')).toHaveLength(2));
    expect(h.calls.at(-1).request.input.body).toBe('[OpenChamber session completed](https://app.example.com/?session=ses_1)');
    runtime.stop();
    runtime.processPayload({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'Boom' } } });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(h.calls.filter((call) => call.request.method === 'comments.create')).toHaveLength(2);
    // A private origin publishes no link.
    expect(await post(h, { kind: 'started', sessionId: 'ses_2', identifier: 'PROJ-2', sessionOrigin: 'http://localhost:3000' })).toEqual({ connected: true, posted: false, skipped: 'origin-not-public' });
    h.answers['comments.create'] = () => ({ ok: true, data: { comment: null } });
    expect(await post(h, { kind: 'started', sessionId: 'ses_3', identifier: 'PROJ-3' })).toEqual({ connected: true, posted: false, skipped: 'issue-not-found' });
    await expect(post(h, { kind: 'started', sessionId: 'ses_4' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(post(h, { kind: 'started', sessionId: 'ses_5', identifier: 'not an identifier' })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('two kinds posted at once keep both flags, and a post that finishes after removal leaves no record behind', async () => {
    const h = await harness();
    await connect(h);
    await h.tracker.preferences.set({ sessionComments: true });
    expect(await post(h, { kind: 'started', sessionId: 'ses_1', identifier: 'PROJ-1' })).toMatchObject({ posted: true });
    // A failed turn emits failure and completed together: each read the record before the other wrote.
    const releases = [];
    h.answers['comments.create'] = async () => {
      await new Promise((resolve) => { releases.push(resolve); });
      return { ok: true, data: { comment: { id: `c-${releases.length}` } } };
    };
    const both = Promise.all([post(h, { kind: 'completed', sessionId: 'ses_1' }), post(h, { kind: 'failure', sessionId: 'ses_1' })]);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const pair = releases.splice(0);
    pair[0]();
    pair[1]();
    expect((await both).map((answer) => answer.posted)).toEqual([true, true]);
    expect(await h.accounts.sessionRecord('ext-youtrack', 'ses_1')).toMatchObject({ started: true, completed: true, failure: true });
    expect(await post(h, { kind: 'completed', sessionId: 'ses_1' })).toMatchObject({ skipped: 'already-posted' });
    expect(await post(h, { kind: 'failure', sessionId: 'ses_1' })).toMatchObject({ skipped: 'already-posted' });

    // Removal lands while the comment is being posted: the comment goes out, the store section stays gone.
    h.answers['comments.create'] = () => ({ ok: true, data: { comment: { id: 'c-2' } } });
    expect(await post(h, { kind: 'started', sessionId: 'ses_2', identifier: 'PROJ-2' })).toMatchObject({ posted: true });
    h.answers['comments.create'] = async () => {
      h.tracker.dispose();
      await h.accounts.remove('ext-youtrack');
      return { ok: true, data: { comment: { id: 'c-late' } } };
    };
    expect(await post(h, { kind: 'completed', sessionId: 'ses_2' })).toEqual({ connected: true, posted: true, commentId: 'c-late' });
    expect(await h.accounts.read('ext-youtrack')).toBeNull();
  });
});

describe('the browser sign-in of an extension tracker', () => {
  const minted = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600 };
  const tokenServer = (payload = minted) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })));

  it('needs the saved client, returns the authorize URL, and the callback stores the account the service names', async () => {
    const h = await harness();
    await expect(h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com', instance: INSTANCE })).rejects.toMatchObject({ code: 'CLIENT_MISSING' });
    await expect(h.tracker.auth.start({ origin: 'web', callbackOrigin: null, instance: INSTANCE })).rejects.toMatchObject({ code: 'ORIGIN_REQUIRED' });
    const withClient = await h.tracker.auth.setOAuthClient({ instance: INSTANCE, clientId: 'client-1', clientSecret: 's3' });
    expect(withClient).toMatchObject({ instance: INSTANCE, hasClient: true, accounts: [] });
    const started = await h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' });
    const url = new URL(started.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://yt.example.com/hub/api/rest/oauth2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/tracker/ext-youtrack/oauth/callback');
    expect(url.searchParams.get('scope')).toBe('YouTrack');

    tokenServer();
    await expect(h.tracker.auth.completeAuthorization({ code: 'c', state: 'wrong', error: '', errorDescription: '' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    const view = await h.tracker.auth.completeAuthorization({ code: 'code-1', state: url.searchParams.get('state'), error: '', errorDescription: '' });
    expect(view).toMatchObject({ instance: INSTANCE, activeAccountId: 'u-1', accounts: [{ id: 'u-1', method: 'oauth', status: 'valid' }] });
    // The exchange went to the token endpoint resolved against the instance, with the verifier; the service saw the bearer only through the handle.
    const exchange = fetch.mock.calls[0];
    expect(String(exchange[0])).toBe('https://yt.example.com/hub/api/rest/oauth2/token');
    expect(Object.fromEntries(new URLSearchParams(exchange[1].body))).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', client_id: 'client-1', client_secret: 's3' });
    expect(h.calls.at(-1).request).toMatchObject({ method: 'auth.verify', session: { instance: INSTANCE, account: null } });
    expect(JSON.stringify(h.calls)).not.toContain('at-1');
    // The account then reads through the OAuth bearer.
    await h.tracker.list();
    expect(h.calls.at(-1).request.session.account).toEqual({ id: 'u-1', login: 'mona' });
    // A denied sign-in says so only for the sign-in it names; the callback is public, so
    // a denial with a state nobody issued cancels nothing, not even a token connect in flight.
    const again = await h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' });
    const againState = new URL(again.authorizationUrl).searchParams.get('state');
    let release;
    h.answers['auth.verify'] = async () => {
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, data: { account: { id: 'u-2', login: 'bob' } } };
    };
    const tokenConnect = connect(h, { token: 'secret-2' });
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(h.tracker.auth.completeAuthorization({ code: '', state: 'x', error: 'access_denied', errorDescription: 'The user said no' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    release();
    expect(await tokenConnect).toMatchObject({ activeAccountId: 'u-2' });
    await expect(h.tracker.auth.completeAuthorization({ code: '', state: againState, error: 'access_denied', errorDescription: 'The user said no' })).rejects.toMatchObject({ code: 'OAUTH_DENIED', message: 'The user said no' });
    await expect(h.tracker.auth.completeAuthorization({ code: '', state: againState, error: 'access_denied', errorDescription: '' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
  });

  it('a denied sign-in cancels only its own connect: a token connect started after it still lands', async () => {
    const h = await harness();
    await h.tracker.auth.setOAuthClient({ instance: INSTANCE, clientId: 'client-1', clientSecret: 's3' });
    const started = await h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    // The user gives up on the browser and pastes a token instead; its verification is still running when the denial arrives.
    let release;
    h.answers['auth.verify'] = async () => {
      await new Promise((resolve) => { release = resolve; });
      return { ok: true, data: { account: { id: 'u-2', login: 'bob' } } };
    };
    const tokenConnect = connect(h, { token: 'secret-2' });
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(h.tracker.auth.completeAuthorization({ code: '', state, error: 'access_denied', errorDescription: 'no' })).rejects.toMatchObject({ code: 'OAUTH_DENIED' });
    release();
    expect(await tokenConnect).toMatchObject({ activeAccountId: 'u-2' });
  });

  it('a client saved before any account pins no server: the typed address wins until an account lives there', async () => {
    const h = await harness();
    await h.tracker.auth.setOAuthClient({ instance: 'https://typo.example.com', clientId: 'client-1', clientSecret: 's3' });
    // The card keeps asking for the address: a mistyped one is corrected by typing again.
    expect((await h.tracker.auth.status()).connect).toMatchObject({ instance: null, hasClient: true });
    const view = await connect(h);
    expect(view.instance).toBe(INSTANCE);
    expect((await h.tracker.auth.status()).connect).toMatchObject({ instance: INSTANCE });
    // With an account on the server, the stored address stands whatever is typed.
    await expect(h.tracker.auth.setOAuthClient({ instance: 'https://other.example.com', clientId: 'client-2' })).rejects.toMatchObject({ code: 'INSTANCE_MISMATCH' });
    expect((await h.tracker.auth.status()).connect).toMatchObject({ instance: INSTANCE });
  });

  it('a disconnect between start and callback wins; the saved client stays until the last account leaves', async () => {
    const h = await harness();
    await h.tracker.auth.setOAuthClient({ instance: INSTANCE, clientId: 'client-1', clientSecret: 's3' });
    const started = await h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' });
    const state = new URL(started.authorizationUrl).searchParams.get('state');
    await h.tracker.auth.disconnect();
    tokenServer();
    await expect(h.tracker.auth.completeAuthorization({ code: 'code-1', state, error: '', errorDescription: '' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    // Nothing was connected, so the client the user just saved is still there, and a new sign-in starts.
    expect((await h.tracker.auth.status()).connect.hasClient).toBe(true);
    const again = await h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' });
    await h.tracker.auth.completeAuthorization({ code: 'code-2', state: new URL(again.authorizationUrl).searchParams.get('state'), error: '', errorDescription: '' });
    expect((await h.tracker.auth.status()).connected).toBe(true);
    // Disconnecting the last account forgets the server and the client with it.
    await h.tracker.auth.disconnect();
    await expect(h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com', instance: INSTANCE })).rejects.toMatchObject({ code: 'CLIENT_MISSING' });
  });

  it('renews an access token about to lapse before a call, against the revision it read, and keeps the account on a failed renewal', async () => {
    const h = await harness();
    await h.tracker.auth.setOAuthClient({ instance: INSTANCE, clientId: 'client-1', clientSecret: 's3' });
    const started = await h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' });
    tokenServer({ ...minted, expires_in: 30 });
    await h.tracker.auth.completeAuthorization({ code: 'code-1', state: new URL(started.authorizationUrl).searchParams.get('state'), error: '', errorDescription: '' });
    const before = (await h.accounts.read('ext-youtrack')).accounts[0];
    expect(before.credential).toMatchObject({ kind: 'oauth', accessToken: 'at-1', refreshToken: 'rt-1' });

    tokenServer({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'bearer', expires_in: 3600 });
    await h.tracker.list();
    const after = (await h.accounts.read('ext-youtrack')).accounts[0];
    expect(after.credential).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
    expect(after.revision).not.toBe(before.revision);
    expect(Object.fromEntries(new URLSearchParams(fetch.mock.calls[0][1].body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'client-1', client_secret: 's3' });
    // Fresh enough now: no second renewal.
    await h.tracker.list();
    expect(fetch).toHaveBeenCalledTimes(1);
    // A renewal the endpoint refuses leaves the account as it is; the call goes out with the old token.
    h.tick(3600 * 1000);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));
    await h.tracker.list();
    expect((await h.accounts.read('ext-youtrack')).accounts[0].credential.accessToken).toBe('at-2');
    expect(h.warnings.join('\n')).toContain('could not be renewed');
  });

  it('a renewal that lands after the account was replaced writes nothing: the newer credential stands', async () => {
    const h = await harness();
    await h.tracker.auth.setOAuthClient({ instance: INSTANCE, clientId: 'client-1', clientSecret: 's3' });
    const started = await h.tracker.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com' });
    tokenServer({ ...minted, expires_in: 30 });
    await h.tracker.auth.completeAuthorization({ code: 'code-1', state: new URL(started.authorizationUrl).searchParams.get('state'), error: '', errorDescription: '' });
    // The renewal waits at the token endpoint; meanwhile the same user connects again with a pasted token.
    let releaseRefresh;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      releaseRefresh = () => resolve(new Response(JSON.stringify({ access_token: 'at-stale', refresh_token: 'rt-stale', token_type: 'bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    })));
    const listing = h.tracker.list();
    await vi.waitFor(() => expect(releaseRefresh).toBeDefined());
    await connect(h, { token: 'secret-new' });
    releaseRefresh();
    await listing;
    const stored = await h.accounts.read('ext-youtrack');
    expect(stored.accounts).toHaveLength(1);
    expect(stored.accounts[0].credential).toMatchObject({ kind: 'token', token: 'secret-new' });
    expect(JSON.stringify(stored)).not.toContain('at-stale');
    expect(h.calls.at(-1).request).toMatchObject({ method: 'items.list', session: { account: { id: 'u-1' } } });
  });
});

describe('a detached extension tracker', () => {
  it('refuses account writes still in flight after dispose', async () => {
    const h = await harness();
    h.tracker.dispose();
    await expect(connect(h)).rejects.toMatchObject({ status: 404, code: 'UNKNOWN_TRACKER' });
    await expect(h.tracker.list()).rejects.toMatchObject({ status: 404, code: 'UNKNOWN_TRACKER' });
  });

  it('a client saved while removal lands never recreates the store section: the secret does not outlive the uninstall', async () => {
    let removal = null;
    const h = await harness({
      // Removal lands between the adapter's read of the store and its write.
      wrapAccounts: (accounts) => ({
        ...accounts,
        read: async (...args) => {
          const stored = await accounts.read(...args);
          if (removal) await removal();
          return stored;
        },
      }),
    });
    removal = async () => { removal = null; h.tracker.dispose(); await h.accounts.remove('ext-youtrack'); };
    await expect(h.tracker.auth.setOAuthClient({ instance: INSTANCE, clientId: 'client-1', clientSecret: 's3' })).rejects.toMatchObject({ code: 'UNKNOWN_TRACKER' });
    expect(await h.accounts.read('ext-youtrack')).toBeNull();
  });
});
