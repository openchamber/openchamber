import { describe, expect, it } from 'bun:test';
import { fetchExeDevUsage, parseExeDevUsage } from './exe-dev.js';

const payload = {
  allowance_spend_usd: 0.11,
  extra_spend_usd: 0,
  group: 'day',
  month: '2026-09',
  monthly_allowance_usd: 20,
  period_end: '2026-10-01T00:00:00Z',
  period_start: '2026-09-01T00:00:00Z',
  total_cost_usd: 0.11,
  total_requests: 17,
};

describe('exe.dev quota provider', () => {
  it('parses monthly credit usage', () => {
    const windows = parseExeDevUsage(payload);
    expect(windows?.monthly.usedPercent).toBeCloseTo(0.55);
    expect(windows?.monthly.valueLabel).toBe('$0.11 / $20.00');
    expect(windows?.monthly.resetAt).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });

  it('sends the scoped billing command without exposing the token elsewhere', async () => {
    const requests = [];
    const windows = await fetchExeDevUsage({ usageToken: 'test-token' }, async (url, init) => {
      requests.push({ url, init });
      return Response.json(payload);
    });
    expect(windows.monthly.valueLabel).toBe('$0.11 / $20.00');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://exe.dev/exec');
    expect(requests[0].init.method).toBe('POST');
    expect(requests[0].init.body).toBe('billing credits usage --group=day --json');
    expect(requests[0].init.headers.Authorization).toBe('Bearer test-token');
  });

  it('rejects malformed successful responses', async () => {
    await expect(fetchExeDevUsage({ usageToken: 'test-token' }, async () => Response.json({})))
      .rejects.toThrow('could not be parsed');
  });

  it('reports authentication failure without including the token', async () => {
    await expect(fetchExeDevUsage({ usageToken: 'test-token' }, async () => new Response('', { status: 401 })))
      .rejects.toThrow('exe.dev authentication failed');
  });
});
