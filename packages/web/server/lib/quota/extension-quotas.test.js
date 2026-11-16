import { describe, expect, it, vi } from 'vitest';

import { readEnterprisePolicy } from '../enterprise-mode.js';
import { enterpriseBlockedCapabilities } from '../guests/enterprise.js';
import { createExtensionQuotaProviders } from './extension-quotas.js';

const guestRow = (overrides = {}) => ({
  id: 'teapot-usage', name: 'Teapot Usage', icon: 'cup', version: '1.0.0', packageRoot: '/pkg/teapot', enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', provides: ['quota'] },
  quota: { providers: ['teapot'] }, capabilityGrants: ['service'], ...overrides,
});

const AUTH = { teapot: { type: 'api', key: 'demo' } };
const usage = { ok: true, data: { ok: true, configured: true, usage: { windows: { '5h': { usedPercent: 24, windowSeconds: 18_000 } } } } };

/** A reconciler over a scripted catalog and a fake registry that records attach order. */
const harness = (catalog = [guestRow()]) => {
  const attached = new Map();
  const registry = {
    attachExtensionQuotaProvider: vi.fn((provider) => { attached.set(provider.providerId, provider); }),
    detachExtensionQuotaProvider: vi.fn((id) => attached.delete(id)),
  };
  const loadRegistry = vi.fn(async () => registry);
  const emitChanged = vi.fn();
  const warnings = [];
  const state = { catalog, listFailure: null, proxied: 0 };
  const quotas = createExtensionQuotaProviders({
    listGuests: async () => { if (state.listFailure) throw state.listFailure; return state.catalog; },
    currentGuest: async (guestId) => state.catalog.find((guest) => guest.id === guestId) ?? null,
    loadRegistry,
    persistPath: '/data/extensions.json',
    proxyServiceRequest: async () => { state.proxied += 1; return { status: 200, body: JSON.stringify(usage) }; },
    readCredentials: async () => AUTH,
    emitChanged,
    warn: (...args) => warnings.push(args.join(' ')),
  });
  return { quotas, attached, registry, loadRegistry, emitChanged, warnings, state, ids: () => [...attached.keys()] };
};

describe('extension usage providers follow the catalog', () => {
  it('attaches an eligible guest once, and again only when it changed', async () => {
    const h = harness();
    await h.quotas.reconcile();
    expect(h.ids()).toEqual(['ext-teapot-usage']);
    expect(h.attached.get('ext-teapot-usage')).toMatchObject({ providerName: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' });
    expect(h.emitChanged).toHaveBeenCalledTimes(1);
    const first = h.attached.get('ext-teapot-usage');

    await h.quotas.reconcile();
    expect(h.registry.attachExtensionQuotaProvider).toHaveBeenCalledTimes(1);
    expect(h.emitChanged).toHaveBeenCalledTimes(1);

    // A new version, a new icon or a changed list rebuilds the entry.
    h.state.catalog = [guestRow({ version: '1.1.0', icon: 'flask' })];
    await h.quotas.reconcile();
    expect(h.attached.get('ext-teapot-usage')).not.toBe(first);
    expect(h.attached.get('ext-teapot-usage').icon).toBe('flask');
    expect(h.emitChanged).toHaveBeenCalledTimes(2);
  });

  it('never loads the quota module on a host without such an extension', async () => {
    const h = harness([]);
    await h.quotas.reconcile();
    expect(h.loadRegistry).not.toHaveBeenCalled();
    expect(h.emitChanged).not.toHaveBeenCalled();
    h.state.catalog = [guestRow()];
    await h.quotas.reconcile();
    expect(h.loadRegistry).toHaveBeenCalledTimes(1);
  });

  it('detaches a guest that stopped being eligible: paused, removed, unapproved, or whose list changed', async () => {
    const h = harness();
    await h.quotas.reconcile();
    h.state.catalog = [guestRow({ enabled: false })];
    await h.quotas.deactivated({ guestId: 'teapot-usage' });
    expect(h.ids()).toEqual([]);
    expect(h.emitChanged).toHaveBeenCalledTimes(2);

    h.state.catalog = [guestRow()];
    await h.quotas.reconcile();
    expect(h.ids()).toEqual(['ext-teapot-usage']);
    // The catalog drops the grant when the scope changed: the card leaves until the user approves again.
    h.state.catalog = [guestRow({ quota: { providers: ['teapot', 'openrouter'] }, capabilityGrants: [] })];
    await h.quotas.reconcile();
    expect(h.ids()).toEqual([]);
    h.state.catalog = [];
    await h.quotas.deactivated({ guestId: 'teapot-usage', removed: true });
    expect(h.ids()).toEqual([]);
  });

  it('enterprise mode through the real policy: outside the allowlist the card leaves and a call refuses; inside it, and with the mode off, it serves', async () => {
    // What the catalog does on every read, from the real policy reader and the real gate; no policy file on this machine is consulted.
    const noPolicyFile = () => { throw Object.assign(new Error('no policy file'), { code: 'ENOENT' }); };
    const underPolicy = (guest, env) => {
      const policy = readEnterprisePolicy({ env, readFile: noPolicyFile });
      const blocked = enterpriseBlockedCapabilities(guest, { source: guest.source, gitUrl: guest.gitOrigin?.url }, policy);
      if (blocked.length === 0) return guest;
      return { ...guest, capabilityGrants: guest.capabilityGrants.filter((capability) => !blocked.includes(capability)), enterpriseBlocked: blocked };
    };
    const guest = guestRow({ source: 'git', gitOrigin: { url: 'https://github.com/acme/teapot-usage.git' } });
    const off = {};
    const blocked = { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_ALLOWED_EXTENSIONS: 'https://github.com/acme/another-extension' };
    const allowed = { OPENCHAMBER_ENTERPRISE_MODE: '1', OPENCHAMBER_ALLOWED_EXTENSIONS: 'https://github.com/acme/teapot-usage' };
    expect(underPolicy(guest, blocked)).toMatchObject({ capabilityGrants: [], enterpriseBlocked: ['service'] });
    expect(underPolicy(guest, allowed)).toBe(guest);
    expect(underPolicy(guest, off)).toBe(guest);

    const h = harness([underPolicy(guest, off)]);
    await h.quotas.reconcile();
    const provider = h.attached.get('ext-teapot-usage');
    expect((await provider.fetchQuota()).ok).toBe(true);
    expect(h.state.proxied).toBe(1);

    // The administrator turns the mode on with this extension outside the allowlist. Nothing announced it yet: the next call refuses before sending.
    h.state.catalog = [underPolicy(guest, blocked)];
    expect(await provider.fetchQuota()).toMatchObject({ ok: false, configured: true, error: expect.stringContaining('may no longer report usage') });
    expect(h.state.proxied).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.quotas.reconcile();
    expect(h.ids()).toEqual([]);

    // Added to the allowlist: the card is back and the credentials cross again.
    h.state.catalog = [underPolicy(guest, allowed)];
    await h.quotas.reconcile();
    expect(h.ids()).toEqual(['ext-teapot-usage']);
    expect((await h.attached.get('ext-teapot-usage').fetchQuota()).ok).toBe(true);
    expect(h.state.proxied).toBe(2);
  });

  it('keeps the providers as they are when the catalog cannot be read, and runs one reconcile at a time', async () => {
    const h = harness();
    await Promise.all([h.quotas.reconcile(), h.quotas.reconcile(), h.quotas.reconcile()]);
    expect(h.ids()).toEqual(['ext-teapot-usage']);
    expect(h.emitChanged).toHaveBeenCalledTimes(1);
    h.state.listFailure = new Error('disk');
    await h.quotas.reconcile();
    expect(h.ids()).toEqual(['ext-teapot-usage']);
    expect(h.warnings.join('\n')).toContain('catalog could not be read');
  });
});
