import { describe, expect, it, vi } from 'vitest';

import { QUOTA_PROVIDER_IDLE_MS, QUOTA_PROVIDER_PATH, QUOTA_PROVIDER_RESPONSE_MAX, QUOTA_PROVIDER_TIMEOUT_MS } from '@openchamber/sdk';

import { createExtensionQuotaProvider, isQuotaGuest, pickCredentials } from './extension-quota.js';
import { QuotaRouteError } from './route-error.js';

const contribution = { providers: ['teapot', 'openrouter'] };
const quotaGuest = (overrides = {}) => ({
  id: 'teapot-usage', name: 'Teapot Usage', icon: 'cup', packageRoot: '/pkg/teapot', enabled: true,
  service: { entry: 'service/main.js', runtime: 'host', provides: ['quota'] },
  quota: contribution,
  capabilityGrants: ['service'],
  ...overrides,
});

const AUTH = {
  teapot: { type: 'api', key: 'demo' },
  openrouter: { type: 'oauth', access: 'a', refresh: 'r', expires: 1_800_000_000_000 },
  anthropic: { type: 'api', key: 'never-handed-over' },
};

const usageAnswer = (data = {}) => ({
  ok: true,
  data: {
    ok: true,
    configured: true,
    planLabel: 'Pro',
    usage: {
      windows: {
        '5h': { usedPercent: 24, windowSeconds: 18_000, resetAt: 1_800_000_000_000, value: { kind: 'requests', count: 120 } },
        credits_balance: { usedPercent: null, valueLabel: '$12.50' },
      },
      models: { 'teapot-large': { windows: { weekly: { usedPercent: 10, creditsUsed: 3 } } } },
    },
    ...data,
  },
});

/** An adapter over a scripted catalog, credential store and service. */
const harness = ({ guest = quotaGuest(), auth = AUTH, answer = usageAnswer() } = {}) => {
  const calls = [];
  const warnings = [];
  const state = { catalog: guest, auth, answer, proxyFailure: null, readFailure: null };
  const reconcile = vi.fn(async () => {});
  const provider = createExtensionQuotaProvider({
    guest,
    contribution: guest.quota,
    currentGuest: async () => state.catalog,
    reconcile,
    persistPath: '/data/extensions.json',
    proxy: async (params) => {
      calls.push({ params, request: JSON.parse(params.body) });
      if (state.proxyFailure) throw state.proxyFailure;
      const current = state.answer;
      return typeof current === 'string' ? { status: 200, body: current } : { status: current.status ?? 200, body: JSON.stringify(current) };
    },
    readCredentials: async () => {
      if (state.readFailure) throw state.readFailure;
      return state.auth;
    },
    createId: () => 'req-1',
    warn: (...args) => warnings.push(args.join(' ')),
  });
  return { provider, calls, warnings, state, reconcile };
};

describe('isQuotaGuest and pickCredentials', () => {
  it('serves usage only for an enabled, fully approved guest that provides the role with a contribution', () => {
    expect(isQuotaGuest(quotaGuest())).toBe(true);
    expect(isQuotaGuest(quotaGuest({ enabled: false }))).toBe(false);
    expect(isQuotaGuest(quotaGuest({ capabilityGrants: [] }))).toBe(false);
    expect(isQuotaGuest(quotaGuest({ quota: undefined }))).toBe(false);
    expect(isQuotaGuest(quotaGuest({ service: { entry: 'service/main.js', runtime: 'host', provides: ['tracker'] } }))).toBe(false);
    expect(isQuotaGuest(quotaGuest({ id: 'a'.repeat(29) }))).toBe(false);
    expect(isQuotaGuest(null)).toBe(false);
  });

  it('hands over the listed entries OpenCode holds, as stored, and nothing else of the map', () => {
    expect(pickCredentials(AUTH, ['teapot', 'openrouter', 'deepinfra'])).toEqual({ teapot: AUTH.teapot, openrouter: AUTH.openrouter });
    expect(pickCredentials(AUTH, [])).toEqual({});
    // Only own keys count: an id that names a prototype member hands over nothing.
    expect(pickCredentials({}, ['constructor', 'toString'])).toEqual({});
    // A `__proto__` id from a manifest cannot pass the parse; should one arrive, the pick is an own key and never the prototype.
    const picked = pickCredentials(JSON.parse('{"__proto__":{"type":"api","key":"x"}}'), ['__proto__']);
    expect(Object.hasOwn(picked, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(picked)).toBe(Object.prototype);
  });
});

describe('an extension usage provider', () => {
  it('names itself after the guest and is configured when OpenCode holds at least one listed credential, always with an empty list', () => {
    const { provider } = harness();
    expect(provider).toMatchObject({ providerId: 'ext-teapot-usage', providerName: 'Teapot Usage', icon: 'cup', guestId: 'teapot-usage' });
    expect(provider.isConfigured(AUTH)).toBe(true);
    expect(provider.isConfigured({ teapot: AUTH.teapot })).toBe(true);
    expect(provider.isConfigured({ anthropic: AUTH.anthropic })).toBe(false);
    expect(provider.isConfigured({})).toBe(false);
    expect(harness({ guest: quotaGuest({ quota: { providers: [] } }) }).provider.isConfigured({})).toBe(true);
  });

  it('posts one usage.read with exactly the listed credentials and answers a built-in\'s result with the derived window fields', async () => {
    const h = harness();
    const result = await h.provider.fetchQuota();
    expect(h.calls).toHaveLength(1);
    const { params, request } = h.calls[0];
    expect(params).toMatchObject({
      guestId: 'teapot-usage', guestName: 'Teapot Usage', packageRoot: '/pkg/teapot', granted: ['service'], persistPath: '/data/extensions.json',
      method: 'POST', path: QUOTA_PROVIDER_PATH, timeoutMs: QUOTA_PROVIDER_TIMEOUT_MS, responseMax: QUOTA_PROVIDER_RESPONSE_MAX, idleStopMs: QUOTA_PROVIDER_IDLE_MS,
    });
    expect(request).toEqual({
      v: 1, requestId: 'req-1', method: 'usage.read', provider: 'ext-teapot-usage',
      input: { credentials: { teapot: AUTH.teapot, openrouter: AUTH.openrouter } },
    });
    expect(params.body).not.toContain('never-handed-over');

    expect(result).toMatchObject({ providerId: 'ext-teapot-usage', providerName: 'Teapot Usage', ok: true, configured: true, planLabel: 'Pro' });
    expect(typeof result.fetchedAt).toBe('number');
    expect(result.usage.windows['5h']).toMatchObject({
      usedPercent: 24, remainingPercent: 76, windowSeconds: 18_000, resetAt: 1_800_000_000_000, value: { kind: 'requests', count: 120 },
    });
    expect(typeof result.usage.windows['5h'].resetAfterSeconds).toBe('number');
    expect(typeof result.usage.windows['5h'].resetAtFormatted).toBe('string');
    expect(result.usage.windows.credits_balance).toMatchObject({ usedPercent: null, remainingPercent: null, windowSeconds: null, resetAt: null, resetAtFormatted: null, valueLabel: '$12.50' });
    expect(result.usage.windows.credits_balance).not.toHaveProperty('value');
    expect(result.usage.models['teapot-large'].windows.weekly).toMatchObject({ usedPercent: 10, remainingPercent: 90, creditsUsed: 3 });
  });

  it('answers not configured without a call when OpenCode holds none of the listed credentials', async () => {
    const h = harness({ auth: { anthropic: AUTH.anthropic } });
    expect(await h.provider.fetchQuota()).toMatchObject({ ok: false, configured: false, error: 'Not configured' });
    expect(h.calls).toHaveLength(0);
    // An empty list is configured, and the service is called with an empty map.
    const empty = harness({ guest: quotaGuest({ quota: { providers: [] } }), auth: { anthropic: AUTH.anthropic } });
    expect((await empty.provider.fetchQuota()).ok).toBe(true);
    expect(empty.calls[0].request.input).toEqual({ credentials: {} });
  });

  it('lets a credential read that fails throw, as a built-in\'s does', async () => {
    const h = harness();
    h.state.readFailure = new Error('OpenCode is not connected yet');
    await expect(h.provider.fetchQuota()).rejects.toThrow('OpenCode is not connected yet');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses before sending when the catalog no longer lets the guest serve, and asks for a reconcile', async () => {
    const h = harness();
    h.state.catalog = quotaGuest({ capabilityGrants: [], enterpriseBlocked: ['service'] });
    expect(await h.provider.fetchQuota()).toMatchObject({ ok: false, configured: true, error: expect.stringContaining('may no longer report usage') });
    expect(h.calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.reconcile).toHaveBeenCalled();
    h.state.catalog = quotaGuest({ enabled: false });
    expect((await h.provider.fetchQuota()).ok).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('reports a service that was not reached as a failed result that keeps the card configured', async () => {
    const h = harness();
    h.state.proxyFailure = Object.assign(new Error('Guest service request failed.'), { code: 'REQUEST_FAILED' });
    expect(await h.provider.fetchQuota()).toMatchObject({ ok: false, configured: true, error: 'Teapot Usage could not answer (REQUEST_FAILED): Guest service request failed.' });
    h.state.proxyFailure = Object.assign(new Error('Allow this extension\'s local service in Settings → Extensions.'), { code: 'NO_SERVICE' });
    expect(await h.provider.fetchQuota()).toMatchObject({ ok: false, configured: true, error: expect.stringContaining('(NO_SERVICE)') });
  });

  it('passes the service\'s own failure through as the card\'s error', async () => {
    const h = harness({ answer: { ok: true, data: { ok: false, configured: true, error: 'Teapot refused the key.', usage: null } } });
    expect(await h.provider.fetchQuota()).toMatchObject({ ok: false, configured: true, error: 'Teapot refused the key.', usage: null });
    h.state.answer = { ok: false, error: { message: 'wrong wire', status: 400 } };
    expect(await h.provider.fetchQuota()).toMatchObject({ ok: false, configured: true, error: 'wrong wire' });
  });

  it('answers 502 MALFORMED_PROVIDER_RESPONSE, never an empty result, for an answer it cannot use', async () => {
    const h = harness();
    const malformed = async (answer, detail) => {
      h.state.answer = answer;
      const error = await h.provider.fetchQuota().catch((thrown) => thrown);
      expect(error).toBeInstanceOf(QuotaRouteError);
      expect(error).toMatchObject({ status: 502, code: 'MALFORMED_PROVIDER_RESPONSE', message: `Teapot Usage answered something OpenChamber cannot use: ${detail}` });
    };
    await malformed('not json', 'not JSON');
    await malformed({ status: 500, error: 'boom' }, 'HTTP 500');
    await malformed({ ok: 'yes' }, 'not a usage answer');
    await malformed({ ok: true, data: { ok: true, configured: true, usage: { windows: { '5h': { usedPercent: 'lots' } } } } }, 'usage.read does not match its schema');
    await malformed({ ok: true, data: { ...usageAnswer().data, extra: 1 } }, 'usage.read does not match its schema');
    await malformed({ ok: true, data: { ok: true, configured: true, usage: { windows: { '5h': { usedPercent: 1, valueLabel: 'x'.repeat(129) } } } } }, 'usage.read does not match its schema');
  });
});
