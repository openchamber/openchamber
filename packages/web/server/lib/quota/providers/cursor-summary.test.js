import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCursorSummaryWindow } from './cursor-summary.js';

const token = `header.${Buffer.from(JSON.stringify({ sub: 'auth0|user_test' })).toString('base64url')}.signature`;
const summary = (overall) => ({
  billingCycleEnd: '2026-12-01T00:00:00.000Z',
  individualUsage: { overall },
  teamUsage: { pooled: { enabled: true, used: 800000, limit: 1000000 } },
});

afterEach(() => vi.unstubAllGlobals());

describe('Cursor dashboard individual allowance', () => {
  it('uses the dashboard cookie and converts the personal cents meter to dollars', async () => {
    const fetchMock = vi.fn(async () => Response.json(summary({ enabled: true, used: 1234, limit: 15000 })));
    vi.stubGlobal('fetch', fetchMock);

    const window = await fetchCursorSummaryWindow(token);

    expect(window.valueLabel).toBe('$12.34 / $150.00');
    expect(window.usedPercent).toBeCloseTo(8.2266667);
    expect(window.resetAt).toBe(Date.parse('2026-12-01T00:00:00.000Z'));
    expect(fetchMock).toHaveBeenCalledWith('https://cursor.com/api/usage-summary', expect.objectContaining({
      redirect: 'error',
      headers: { Cookie: `WorkosCursorSessionToken=user_test%3A%3A${token}` },
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    { enabled: false, used: 1234, limit: 15000 },
    { enabled: true, used: 1234, limit: null },
    { enabled: true, used: 1234, limit: 0 },
    { enabled: true, used: null, limit: 15000 },
    { enabled: true, used: -1, limit: 15000 },
    undefined,
  ])('omits unusable personal meters without substituting the team pool: %j', async (overall) => {
    vi.stubGlobal('fetch', async () => Response.json(summary(overall)));
    expect(await fetchCursorSummaryWindow(token)).toBeNull();
  });

  it.each([0, 16000])('handles zero and over-limit usage: %s', async (used) => {
    vi.stubGlobal('fetch', async () => Response.json(summary({ enabled: true, used, limit: 15000 })));
    const window = await fetchCursorSummaryWindow(token);
    expect(window.usedPercent).toBe(used === 0 ? 0 : 100);
    expect(window.valueLabel).toBe(used === 0 ? '$0.00 / $150.00' : '$160.00 / $150.00');
  });

  it('returns no meter when the dashboard refuses the credential', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
    expect(await fetchCursorSummaryWindow(token)).toBeNull();
  });

  it('does not send an unusable token to the dashboard', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchCursorSummaryWindow('invalid')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
