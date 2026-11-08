import { describe, expect, it } from 'vitest';

import { fetchQuota } from './minimax-coding-plan.js';

const readAuth = () => ({ 'minimax-coding-plan': { key: 'test-key' } });

const mockResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

// Answers each request with the next body, and records the requested URLs.
const fetchSequence = (...bodies) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return mockResponse(bodies[Math.min(urls.length, bodies.length) - 1]);
  };
  return { fetchImpl, urls };
};

describe('MiniMax Coding Plan quota provider', () => {
  it('says MiniMax does not share limits when both endpoints answer 1004', async () => {
    // The body MiniMax returns for a valid Subscription Key (#5839).
    const { fetchImpl, urls } = fetchSequence({
      base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' },
    });

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(urls).toHaveLength(2);
    expect(result).toMatchObject({
      ok: false,
      configured: true,
      error: "MiniMax doesn't share limits for this key",
    });
  });

  it("shows MiniMax's own message for another business failure", async () => {
    const { fetchImpl } = fetchSequence({
      base_resp: { status_code: 2049, status_msg: 'invalid api key' },
    });

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result).toMatchObject({ ok: false, configured: true, error: 'invalid api key' });
  });

  it('keeps the generic error when neither endpoint can be reached', async () => {
    const fetchImpl = async () => {
      throw new Error('network down');
    };

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result).toMatchObject({ ok: false, configured: true, error: 'API returned no usable quota data' });
  });

  it('reads the legacy endpoint when the token plan endpoint reports a business failure', async () => {
    const { fetchImpl } = fetchSequence(
      { base_resp: { status_code: 1004, status_msg: 'cookie is missing, log in again' } },
      {
        base_resp: { status_code: 0, status_msg: 'success' },
        model_remains: [{ model_name: 'MiniMax-M2', current_interval_total_count: 100, current_interval_usage_count: 25 }],
      },
    );

    const result = await fetchQuota({ readAuth, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(25);
  });
});
