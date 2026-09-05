import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExeDevUsage, parseExeDevUsage } from './exeDevQuota';

const payload = {
  monthly_allowance_usd: 20,
  period_end: '2026-10-01T00:00:00Z',
  total_cost_usd: 0.11,
};

describe('exe.dev quota', () => {
  it('parses monthly credit usage', () => {
    const windows = parseExeDevUsage(payload);
    assert.ok(windows);
    assert.ok(Math.abs((windows.monthly.usedPercent ?? 0) - 0.55) < 0.0001);
    assert.equal(windows.monthly.valueLabel, '$0.11 / $20.00');
  });

  it('executes only the billing usage command', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const windows = await fetchExeDevUsage('test-token', async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(payload);
    });
    assert.equal(windows.monthly.valueLabel, '$0.11 / $20.00');
    assert.equal(requests[0]?.url, 'https://exe.dev/exec');
    assert.equal(requests[0]?.init?.body, 'billing credits usage --group=day --json');
    assert.equal(new Headers(requests[0]?.init?.headers).get('Authorization'), 'Bearer test-token');
  });
});
