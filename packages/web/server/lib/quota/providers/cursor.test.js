import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchQuota } from './cursor.js';

const futureToken = () => {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `header.${payload}.signature`;
};

const mockResponses = (routes) => {
  const fetchMock = vi.fn(async (url) => {
    const match = Object.entries(routes).find(([fragment]) => String(url).includes(fragment));
    if (!match) throw new Error(`Unexpected fetch: ${url}`);
    const { status = 200, body = {} } = match[1];
    return { ok: status < 400, status, json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const ok = (body) => ({ status: 200, body });
const notFound = () => ({ status: 404 });

const enterpriseRoutes = {
  GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088', billingCycleEnd: '1787932328088', displayThreshold: 100 }),
  GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', price: 'Custom', billingCycleEnd: '1788220800000' } }),
  GetCreditGrantsBalance: ok({}),
  full_stripe_profile: ok({ teamId: 424242, isTeamMember: true, membershipType: 'enterprise' }),
  'auth/usage': ok({ 'gpt-4': { numRequests: 590, maxRequestUsage: 1000 } }),
  GetHardLimit: ok({ hardLimit: 12500, hardLimitPerUser: 250 }),
  GetTeamSpend: ok({ teamMemberSpend: [] }),
  GetMe: ok({ userId: 424242, email: 'me@example.com', teamId: 424242, isEnterpriseUser: true })
};

beforeEach(() => {
  process.env.CURSOR_TOKEN = futureToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CURSOR_TOKEN;
  delete process.env.CURSOR_REFRESH_TOKEN;
});

describe('Cursor quota', () => {
  it('does not fabricate on-demand exhaustion when spendLimitUsage omits the remaining amount', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 },
        spendLimitUsage: { individualLimit: 2000 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.on_demand.usedPercent).toBeNull();
    expect(result.usage.windows.on_demand.valueLabel).toBe('$20.00 limit');
  });

  it.each([
    [1500, 25, '$15.00 remaining of $20.00'],
    [0, 100, '$0.00 remaining of $20.00']
  ])('reports on-demand remaining %s as %s%% used', async (individualRemaining, expectedUsedPercent, expectedLabel) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 },
        spendLimitUsage: { individualLimit: 2000, individualRemaining }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.on_demand.usedPercent).toBe(expectedUsedPercent);
    expect(result.usage.windows.on_demand.valueLabel).toBe(expectedLabel);
  });

  it('makes no remaining claim for plan_limit when the payload omits the remaining amount', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300, limit: 2000 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.plan_limit.usedPercent).toBeNull();
    expect(result.usage.windows.plan_limit.valueLabel).toBe('$20.00 limit');
  });

  it('reports plan_limit from a reported remaining amount', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300, limit: 2000, remaining: 500 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.plan_limit.usedPercent).toBe(75);
    expect(result.usage.windows.plan_limit.valueLabel).toBe('$5.00 remaining of $20.00');
  });

  it('keeps the planUsage path for Pro accounts', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: true, planUsage: { totalPercentUsed: 42, totalSpend: 2300 } }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerName).toBe('Cursor Pro');
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(42);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('$23.00');
  });

  it.each([
    [150, 100],
    [-20, 0],
    [200, 100],
    [42, 42]
  ])('clamps billing_cycle totalPercentUsed %s to %s', async (totalPercentUsed, expectedUsedPercent) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: true, planUsage: { totalPercentUsed, totalSpend: 2300 } }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(expectedUsedPercent);
  });

  it.each([
    [150, 100],
    [-20, 0],
    [200, 100],
    [42, 42]
  ])('clamps autoPercentUsed %s to %s', async (autoPercentUsed, expectedUsedPercent) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, autoPercentUsed, apiPercentUsed: 10, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.auto.usedPercent).toBe(expectedUsedPercent);
    expect(result.usage.windows.auto.remainingPercent).toBe(100 - expectedUsedPercent);
  });

  it.each([
    [150, 100],
    [-20, 0],
    [200, 100],
    [42, 42]
  ])('clamps apiPercentUsed %s to %s', async (apiPercentUsed, expectedUsedPercent) => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, autoPercentUsed: 10, apiPercentUsed, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.api.usedPercent).toBe(expectedUsedPercent);
    expect(result.usage.windows.api.remainingPercent).toBe(100 - expectedUsedPercent);
  });

  it('omits the auto and api windows when their percentages are missing', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: true, planUsage: { totalPercentUsed: 42, totalSpend: 2300 } }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(42);
    expect(result.usage.windows.auto).toBeUndefined();
    expect(result.usage.windows.api).toBeUndefined();
  });

  it('reports windowSeconds as the billing-cycle duration, not time until reset', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        billingCycleStart: '1700000000000',
        billingCycleEnd: '1702592000000',
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBe(2592000);
  });

  it('reports windowSeconds as null when the billing-cycle start is missing', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        billingCycleEnd: 1702592000000,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
    expect(result.usage.windows.billing_cycle.resetAt).toBe(1702592000000);
  });

  it('reports windowSeconds as null when the billing-cycle start is not before the end', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        billingCycleStart: 1702592000000,
        billingCycleEnd: 1702592000000,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
  });

  it('falls back to auth/usage and team-scoped GetHardLimit for enterprise accounts', async () => {
    const fetchMock = mockResponses(enterpriseRoutes);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerName).toBe('Cursor Enterprise');
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('590 / 1000');
    expect(result.usage.windows.billing_cycle.usedPercent).toBe(59);
    expect(result.usage.windows.on_demand).toBeUndefined();
    const hardLimitCall = fetchMock.mock.calls.find(([url]) => String(url).includes('GetHardLimit'));
    expect(JSON.parse(hardLimitCall[1].body)).toEqual({ teamId: '424242' });
  });

  it('reports enterprise windowSeconds as the billing-cycle duration', async () => {
    mockResponses(enterpriseRoutes);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBe(288471);
  });

  it('reports enterprise windowSeconds when billingCycleStart is only in planInfo', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetCurrentPeriodUsage: ok({ billingCycleEnd: '1787932328088', displayThreshold: 100 }),
      GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', price: 'Custom', billingCycleStart: '1787932328088', billingCycleEnd: '1788220800000' } })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBe(288471);
  });

  it('reports enterprise windowSeconds as null when the billing-cycle start is missing', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetCurrentPeriodUsage: ok({ billingCycleEnd: '1787932328088', displayThreshold: 100 })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
  });

  it('reports enterprise windowSeconds as null when the billing-cycle start is not before the end', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1788220800000', billingCycleEnd: '1787932328088', displayThreshold: 100 })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.windowSeconds).toBeNull();
  });

  it('picks the largest request bucket and skips metadata', async () => {
    mockResponses({
      ...enterpriseRoutes,
      'auth/usage': ok({
        startOfMonth: '2026-08-01',
        'gpt-4o': { numRequests: 120, maxRequestUsage: 500 },
        'gpt-4': { numRequests: 829, maxRequestUsage: 1000 }
      })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('829 / 1000');
  });

  it('reports on-demand spend from GetTeamSpend for enterprise accounts', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetTeamSpend: ok({
        teamMemberSpend: [
          { userId: 999999, spendCents: 100 },
          { userId: 424242, spendCents: 672 }
        ]
      })
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.on_demand.valueLabel).toBe('$6.72 / $250.00');
    expect(result.usage.windows.on_demand.usedPercent).toBeCloseTo(2.688, 3);
  });

  it('does not report success from plan name alone', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088' }),
      GetPlanInfo: ok({ planInfo: { planName: 'Enterprise', billingCycleEnd: '1788220800000' } }),
      GetCreditGrantsBalance: notFound(),
      full_stripe_profile: ok({ teamId: 424242, isTeamMember: true }),
      'auth/usage': notFound(),
      GetHardLimit: notFound(),
      GetTeamSpend: notFound(),
      GetMe: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });

  it('omits the on-demand window when spend cannot be verified', async () => {
    mockResponses({
      ...enterpriseRoutes,
      GetTeamSpend: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.billing_cycle.valueLabel).toBe('590 / 1000');
    expect(result.usage.windows.on_demand).toBeUndefined();
  });

  it('reports a disabled subscription as an error', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ enabled: false }),
      GetPlanInfo: notFound(),
      GetCreditGrantsBalance: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });

  it('still errors when an enterprise fallback finds no usable data', async () => {
    mockResponses({
      GetCurrentPeriodUsage: ok({ billingCycleStart: '1787932328088' }),
      GetPlanInfo: notFound(),
      GetCreditGrantsBalance: notFound(),
      full_stripe_profile: notFound(),
      'auth/usage': notFound(),
      GetHardLimit: notFound()
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('No active Cursor subscription');
  });
});

describe('Cursor request deadline', () => {
  it('recognizes the timeout exception from AbortSignal.timeout', async () => {
    const fetchMock = vi.fn(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Request timed out');
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a stalled token refresh as a timeout result', async () => {
    const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url')}.signature`;
    process.env.CURSOR_TOKEN = expiredToken;
    process.env.CURSOR_REFRESH_TOKEN = 'refresh-token';
    const fetchMock = vi.fn(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Request timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('Cursor token files (bounded read, #1645)', () => {
  let root = null;
  const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oc-cursor-token-file-'));
    process.env.OPENCHAMBER_DATA_DIR = join(root, 'data');
    delete process.env.CURSOR_TOKEN;
    delete process.env.CURSOR_ACCESS_TOKEN;
    delete process.env.CURSOR_REFRESH_TOKEN;
    delete process.env.CURSOR_REFRESH_TOKEN_FILE;
  });

  afterEach(() => {
    delete process.env.CURSOR_TOKEN_FILE;
    if (originalDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('uses a small token file as before', async () => {
    const tokenPath = join(root, 'token.txt');
    writeFileSync(tokenPath, `${futureToken()}\n`);
    process.env.CURSOR_TOKEN_FILE = tokenPath;
    mockResponses({
      GetCurrentPeriodUsage: ok({
        enabled: true,
        planUsage: { totalPercentUsed: 42, totalSpend: 2300 },
        spendLimitUsage: { individualLimit: 2000, individualRemaining: 1500 }
      }),
      GetPlanInfo: ok({ planInfo: { planName: 'Pro' } }),
      GetCreditGrantsBalance: ok({})
    });

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
  });

  it('answers not configured for an over-cap token file instead of buffering it whole', async () => {
    const tokenPath = join(root, 'big-token.txt');
    writeFileSync(tokenPath, 'x'.repeat(128 * 1024));
    process.env.CURSOR_TOKEN_FILE = tokenPath;

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });

  it.runIf(process.platform !== 'win32')('answers not configured promptly for a FIFO token file instead of blocking', async () => {
    const { execFileSync } = await import('child_process');
    const fifoPath = join(root, 'fifo-token.txt');
    execFileSync('mkfifo', [fifoPath]);
    process.env.CURSOR_TOKEN_FILE = fifoPath;

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
  });
});

describe('Cursor credential import sqlite deadline', () => {
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
  let home = null;

  const setupFakeSqlite = (script) => {
    // cursor.js binds STATE_DB from HOME at module load, so each test needs
    // a fresh module registry after HOME moves to the fake home.
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), 'oc-cursor-import-'));
    const dbDir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'state.vscdb'), '');
    const binDir = join(home, 'bin');
    mkdirSync(binDir);
    const sqlite = join(binDir, 'sqlite3');
    writeFileSync(sqlite, script);
    chmodSync(sqlite, 0o755);
    process.env.HOME = home;
    process.env.PATH = `${binDir}:${originalPath}`;
    // The credential store prefers OPENCHAMBER_DATA_DIR over HOME, so the
    // successful import would write its fixture tokens over a real
    // cursor.json wherever that variable points; isolate it too.
    process.env.OPENCHAMBER_DATA_DIR = join(home, 'data');
  };

  afterEach(() => {
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
    process.env.PATH = originalPath;
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it('reports credentials unavailable within the deadline when sqlite3 hangs', async () => {
    setupFakeSqlite('#!/bin/sh\nwhile :; do :; done\n');
    const { importCursorCredential } = await import('./cursor.js');

    const startedAt = Date.now();
    await expect(importCursorCredential({ timeoutMs: 250 })).rejects.toThrow('Cursor credentials are unavailable');
    const elapsed = Date.now() - startedAt;

    // The first read is bounded by the 250 ms timeout and the import fails
    // fast on it: the import settles in well under the time a single
    // unbounded read could take.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('reports credentials unavailable when only the refresh-token read hangs', async () => {
    const token = futureToken();
    setupFakeSqlite(`#!/bin/sh\ncase "$3" in *refreshToken*) while :; do :; done ;; *) printf '%s' '[{"value":"${token}"}]' ;; esac\n`);
    const { importCursorCredential } = await import('./cursor.js');

    const startedAt = Date.now();
    await expect(importCursorCredential({ timeoutMs: 250 })).rejects.toThrow('Cursor credentials are unavailable');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('imports the stored tokens when sqlite3 answers promptly', async () => {
    const token = futureToken();
    setupFakeSqlite(`#!/bin/sh\nprintf '%s' '[{"value":"${token}"}]'\n`);
    const { importCursorCredential } = await import('./cursor.js');

    const result = await importCursorCredential({ timeoutMs: 5_000 });

    expect(result).toMatchObject({ configured: true, hasRefreshToken: true });
  });
});
