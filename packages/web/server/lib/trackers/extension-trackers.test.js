import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readEnterprisePolicy } from '../enterprise-mode.js';
import { enterpriseBlockedCapabilities } from '../guests/enterprise.js';
import { createOutboundHandles } from '../source-control/outbound-handles.js';
import { createTrackerAccounts, trackerAccountsPersistPath } from './extension-accounts.js';
import { createTrackerOAuth } from './extension-oauth.js';
import { createExtensionTrackers } from './extension-trackers.js';
import { createTrackerRegistry } from './registry.js';

const contribution = {
  wire: 1, label: 'YouTrack', instances: { kind: 'user', label: 'Server address' },
  auth: { token: { header: 'authorization', scheme: 'bearer' } },
  capabilities: { stateUpdate: true, filters: {} }, stateFilters: ['open', 'all'], identifier: 'key-number', urls: { item: ['/issue/{id}'] },
};
const guestRow = (overrides = {}) => ({
  id: 'youtrack', name: 'YouTrack Bridge', version: '1.0.0', packageRoot: '/pkg/yt', enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', provides: ['tracker'] },
  tracker: contribution, capabilityGrants: ['service'], ...overrides,
});

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

const harness = async (catalog = [guestRow()]) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-trackers-'));
  dirs.push(dir);
  const registry = createTrackerRegistry([], { foreignIds: [] });
  const accounts = createTrackerAccounts({ persistPath: trackerAccountsPersistPath(dir) });
  const realHandles = createOutboundHandles({ fetch: async () => new Response('{}', { status: 200 }) });
  const revokeGuest = vi.fn(realHandles.revokeGuest);
  const handles = { ...realHandles, revokeGuest };
  const sessionStatus = { forget: vi.fn() };
  const emitChanged = vi.fn();
  const warnings = [];
  let listFailure = null;
  const state = { catalog };
  const trackers = createExtensionTrackers({
    listGuests: async () => { if (listFailure) throw listFailure; return state.catalog; },
    currentGuest: async (guestId) => state.catalog.find((guest) => guest.id === guestId) ?? null,
    registry, accounts, handles, oauth: createTrackerOAuth(), sessionStatus,
    proxyServiceRequest: async (params) => {
      state.proxied = (state.proxied ?? 0) + 1;
      const request = JSON.parse(params.body);
      if (request.method === 'auth.verify' && state.holdVerify) {
        state.verifyWaiting = true;
        await state.holdVerify;
      }
      const data = request.method === 'auth.probe' ? { supported: true }
        : request.method === 'comments.create' ? { comment: { id: 'c-1' } }
          : { account: { id: 'u-1', login: 'mona' } };
      return { status: 200, body: JSON.stringify({ ok: true, data }) };
    },
    persistPath: '/data/extensions.json',
    emitChanged,
    warn: (...args) => warnings.push(args.join(' ')),
  });
  return { trackers, registry, accounts, sessionStatus, emitChanged, warnings, revokeGuest, state, proxied: () => state.proxied ?? 0, failListWith: (error) => { listFailure = error; } };
};

describe('extension trackers follow the catalog', () => {
  it('attaches an eligible guest once, and again only when it changed', async () => {
    const h = await harness();
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual(['ext-youtrack']);
    expect(h.registry.descriptor('ext-youtrack')).toMatchObject({ name: 'YouTrack', urlPatterns: [] });
    expect(h.emitChanged).toHaveBeenCalledTimes(1);
    const first = await h.registry.implementation('ext-youtrack');

    await h.trackers.reconcile();
    expect(h.emitChanged).toHaveBeenCalledTimes(1);
    expect(await h.registry.implementation('ext-youtrack')).toBe(first);

    // A new version rebuilds the descriptor and the adapter; the guest's handles stay, the comment runtime is rebuilt.
    h.state.catalog = [guestRow({ version: '1.1.0', tracker: { ...contribution, label: 'YouTrack 2' } })];
    await h.trackers.reconcile();
    expect(h.registry.descriptor('ext-youtrack').name).toBe('YouTrack 2');
    expect(await h.registry.implementation('ext-youtrack')).not.toBe(first);
    expect(h.emitChanged).toHaveBeenCalledTimes(2);
    expect(h.sessionStatus.forget).toHaveBeenCalledWith('ext-youtrack');
    expect(h.revokeGuest).not.toHaveBeenCalled();
  });

  it('a replacement keeps what the old adapter started: a connect in flight still commits', async () => {
    const h = await harness();
    await h.trackers.reconcile();
    const first = await h.registry.implementation('ext-youtrack');
    let release;
    h.state.holdVerify = new Promise((resolve) => { release = resolve; });
    const connecting = first.auth.connectToken({ instance: 'https://yt.example.com', token: 't' });
    await vi.waitFor(() => expect(h.state.verifyWaiting).toBe(true));
    // The extension updates while the service verifies the token.
    h.state.catalog = [guestRow({ version: '1.1.0' })];
    await h.trackers.reconcile();
    const second = await h.registry.implementation('ext-youtrack');
    expect(second).not.toBe(first);
    release();
    expect(await connecting).toMatchObject({ instance: 'https://yt.example.com', activeAccountId: 'u-1' });
    expect((await second.auth.status()).connected).toBe(true);
  });

  it('the descriptor\'s links follow the connected server, and a connect brings the set up to date', async () => {
    const h = await harness();
    await h.trackers.reconcile();
    const tracker = await h.registry.implementation('ext-youtrack');
    await tracker.auth.connectToken({ instance: 'https://yt.example.com', token: 't' });
    // The adapter asked for a reconcile; wait for it.
    await h.trackers.reconcile();
    expect(h.registry.descriptor('ext-youtrack').urlPatterns).toEqual([{ host: 'yt.example.com', path: expect.stringContaining('^/issue/') }]);
    expect((await h.registry.implementation('ext-youtrack')).matchUrl('https://yt.example.com/issue/PROJ-1')).toBe('PROJ-1');
    expect(h.emitChanged).toHaveBeenCalledTimes(2);
  });

  it('detaches a guest that stopped being eligible, stops its comments and handles, and forgets accounts only on removal', async () => {
    const h = await harness();
    await h.trackers.reconcile();
    const tracker = await h.registry.implementation('ext-youtrack');
    await tracker.auth.connectToken({ instance: 'https://yt.example.com', token: 't' });

    h.state.catalog = [guestRow({ enabled: false })];
    await h.trackers.deactivated({ guestId: 'youtrack' });
    expect(h.registry.list()).toEqual([]);
    expect(h.sessionStatus.forget).toHaveBeenCalledWith('ext-youtrack');
    expect(h.revokeGuest).toHaveBeenCalledWith('youtrack');
    await expect(tracker.list()).rejects.toMatchObject({ code: 'UNKNOWN_TRACKER' });
    // Paused keeps the account; the user comes back to it.
    expect((await h.accounts.publicView('ext-youtrack')).accounts).toHaveLength(1);

    h.state.catalog = [];
    await h.trackers.deactivated({ guestId: 'youtrack', removed: true });
    expect(await h.accounts.read('ext-youtrack')).toBeNull();
    // A withdrawn grant and a refused policy read the same way: not eligible.
    h.state.catalog = [guestRow({ capabilityGrants: [] })];
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual([]);
  });

  it('enterprise mode: an extension outside the allowlist loses its tracker on the next reconcile and on its next call, and keeps its accounts', async () => {
    const h = await harness();
    await h.trackers.reconcile();
    const tracker = await h.registry.implementation('ext-youtrack');
    await h.accounts.connect('ext-youtrack', {
      instance: 'https://yt.example.com', account: { id: 'u-1', login: 'mona', name: 'Mona' }, credential: { kind: 'token', token: 'secret-1', login: null },
    });
    // The catalog applies the policy on every read: a blocked guest keeps its row, loses the grant and names what was blocked.
    h.state.catalog = [guestRow({ capabilityGrants: [], enterpriseBlocked: ['service'] })];
    // Nothing announced the policy yet: the next call reads the catalog and refuses, and withdraws the tracker itself.
    await expect(tracker.list()).rejects.toMatchObject({ code: 'NO_SERVICE', status: 503 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual([]);
    expect(h.sessionStatus.forget).toHaveBeenCalledWith('ext-youtrack');
    expect(h.revokeGuest).toHaveBeenCalledWith('youtrack');
    // Blocked is paused, not removed: the account waits for the administrator's allowlist.
    expect((await h.accounts.publicView('ext-youtrack')).accounts).toHaveLength(1);

    h.state.catalog = [guestRow()];
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual(['ext-youtrack']);
    expect((await h.accounts.publicView('ext-youtrack')).accounts).toHaveLength(1);
  });

  it('a browser sign-in started before a pause cannot finish after the resume', async () => {
    const withOauth = { ...contribution, auth: { oauth: { authorizeUrl: '/hub/auth', tokenUrl: '/hub/token' } } };
    const h = await harness([guestRow({ tracker: withOauth })]);
    await h.trackers.reconcile();
    const first = await h.registry.implementation('ext-youtrack');
    await first.auth.setOAuthClient({ instance: 'https://yt.example.com', clientId: 'client-1', clientSecret: 's' });
    const started = await first.auth.start({ origin: 'web', callbackOrigin: 'https://app.example.com', instance: 'https://yt.example.com' });
    const state = new URL(started.authorizationUrl).searchParams.get('state');

    h.state.catalog = [guestRow({ tracker: withOauth, enabled: false })];
    await h.trackers.deactivated({ guestId: 'youtrack' });
    expect(h.registry.list()).toEqual([]);
    h.state.catalog = [guestRow({ tracker: withOauth })];
    await h.trackers.reconcile();
    const second = await h.registry.implementation('ext-youtrack');
    expect(second).not.toBe(first);
    await expect(second.auth.completeAuthorization({ code: 'c', state, error: '', errorDescription: '' })).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    // The client the user saved is still there for a fresh sign-in.
    expect((await second.auth.status()).connect.hasClient).toBe(true);
  });

  it('enterprise mode through the real policy: outside the allowlist every crossing refuses and the tracker leaves; inside it, and with the mode off, it serves', async () => {
    // What the catalog does on every read (`withEnterprisePolicy`), from the real policy reader and the real gate; no policy file on this machine is consulted.
    const noPolicyFile = () => { throw Object.assign(new Error('no policy file'), { code: 'ENOENT' }); };
    const underPolicy = (guest, env) => {
      const policy = readEnterprisePolicy({ env, readFile: noPolicyFile });
      const blocked = enterpriseBlockedCapabilities(guest, { source: guest.source, gitUrl: guest.gitOrigin?.url }, policy);
      if (blocked.length === 0) return guest;
      return { ...guest, capabilityGrants: guest.capabilityGrants.filter((capability) => !blocked.includes(capability)), enterpriseBlocked: blocked };
    };
    const guest = guestRow({ source: 'git', gitOrigin: { url: 'https://github.com/acme/youtrack-bridge.git' } });
    const off = {};
    const blocked = { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_ALLOWED_EXTENSIONS: 'https://github.com/acme/another-extension' };
    const allowed = { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_ALLOWED_EXTENSIONS: 'https://github.com/acme/youtrack-bridge' };
    expect(underPolicy(guest, blocked)).toMatchObject({ capabilityGrants: [], enterpriseBlocked: ['service'] });
    expect(underPolicy(guest, allowed)).toBe(guest);
    expect(underPolicy(guest, off)).toBe(guest);

    const h = await harness([underPolicy(guest, off)]);
    await h.trackers.reconcile();
    const tracker = await h.registry.implementation('ext-youtrack');
    await tracker.auth.connectToken({ instance: 'https://yt.example.com', token: 't' });
    await tracker.preferences.set({ sessionComments: true });
    expect(await tracker.sessionStatus.post({ kind: 'started', sessionId: 'ses_1', identifier: 'PROJ-1', sessionOrigin: 'https://app.example.com' })).toMatchObject({ posted: true });

    // The administrator turns the mode on with this extension outside the allowlist. Nothing announced it yet.
    h.state.catalog = [underPolicy(guest, blocked)];
    const sent = h.proxied();
    await expect(tracker.list()).rejects.toMatchObject({ code: 'NO_SERVICE', status: 503 });
    await expect(tracker.sessionStatus.post({ kind: 'completed', sessionId: 'ses_1' })).rejects.toMatchObject({ code: 'NO_SERVICE' });
    expect(h.proxied()).toBe(sent);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual([]);
    expect((await h.accounts.publicView('ext-youtrack')).accounts).toHaveLength(1);

    // Added to the allowlist: the tracker is back with its account, and comments flow again.
    h.state.catalog = [underPolicy(guest, allowed)];
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual(['ext-youtrack']);
    const again = await h.registry.implementation('ext-youtrack');
    expect((await again.auth.status()).connected).toBe(true);
    expect(await again.sessionStatus.post({ kind: 'completed', sessionId: 'ses_1' })).toMatchObject({ posted: true });
  });

  it('keeps the trackers as they are when the catalog cannot be read, and one broken contribution leaves the others', async () => {
    const h = await harness([guestRow(), guestRow({ id: 'broken', name: 'Broken', tracker: { ...contribution, urls: { item: ['/browse/(.*)'] } } })]);
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual(['ext-youtrack']);
    expect(h.warnings.join('\n')).toContain('broken cannot serve a tracker');
    h.failListWith(new Error('disk'));
    await h.trackers.reconcile();
    expect(h.registry.list()).toEqual(['ext-youtrack']);
    expect(h.warnings.join('\n')).toContain('catalog could not be read');
  });

  it('runs one reconcile at a time', async () => {
    const h = await harness();
    const runs = Promise.all([h.trackers.reconcile(), h.trackers.reconcile(), h.trackers.reconcile()]);
    await runs;
    expect(h.registry.list()).toEqual(['ext-youtrack']);
    expect(h.emitChanged).toHaveBeenCalledTimes(1);
  });
});
