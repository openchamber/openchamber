import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureOpenCodeCredentials } from '../../opencode/auth.js';
import { fetchQuota } from './openai.js';

afterEach(() => {
  vi.unstubAllGlobals();
  configureOpenCodeCredentials(null);
});

const mockUsage = (usedPercent) => {
  const primaryWindow = { limit_window_seconds: 18000 };
  const secondaryWindow = { limit_window_seconds: 604800 };
  if (usedPercent !== undefined) {
    primaryWindow.used_percent = usedPercent;
    secondaryWindow.used_percent = usedPercent;
  }

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      rate_limit: {
        primary_window: primaryWindow,
        secondary_window: secondaryWindow,
      },
    }),
  }));
};

describe('OpenAI quota windows', () => {
  it.each([
    { usedPercent: 150, expected: 100 },
    { usedPercent: -5, expected: 0 },
    { usedPercent: 42, expected: 42 },
    { usedPercent: undefined, expected: null },
    { usedPercent: 'invalid', expected: null },
  ])('normalizes used_percent=$usedPercent for both windows', async ({ usedPercent, expected }) => {
    configureOpenCodeCredentials({
      list: async () => [{
        integrationID: 'openai',
        active: true,
        value: { type: 'oauth', access: 'test-token', refresh: 'test-refresh', expires: 0 },
      }],
    });
    mockUsage(usedPercent);

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    for (const window of [result.usage.windows['5h'], result.usage.windows.weekly]) {
      expect(window.usedPercent).toBe(expected);
      expect(window.remainingPercent).toBe(expected === null ? null : 100 - expected);
    }
  });
});
