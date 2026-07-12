import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

let mockAuth = {};
const mockAuthModule = {
  readAuthFile: () => mockAuth
};

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => mockAuthModule.readAuthFile()
}));

const { fetchQuota } = await import('./deepseek.js');
const { isConfigured } = await import('./deepseek.js');

const BALANCE_RESPONSE = {
  is_available: true,
  balance_infos: [
    {
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00'
    }
  ]
};

describe('deepseek quota provider', () => {
  beforeEach(() => {
    mockAuth = {};
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isConfigured', () => {
    it('returns false when auth.json has no deepseek entry', () => {
      expect(isConfigured()).toBe(false);
    });

    it('returns true when API key is present in auth.json', () => {
      mockAuth.deepseek = { key: 'sk-test' };
      expect(isConfigured()).toBe(true);
    });
  });

  describe('fetchQuota', () => {
    it('returns not configured when no API key is found', async () => {
      const result = await fetchQuota();
      expect(result.configured).toBe(false);
      expect(result.ok).toBe(false);
    });

    it('returns API error on non-200 response', async () => {
      mockAuth.deepseek = { key: 'sk-test' };
      fetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const result = await fetchQuota();
      expect(result.configured).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid API key');
    });

    it('fetches and parses balance on success', async () => {
      mockAuth.deepseek = { key: 'sk-test' };
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => BALANCE_RESPONSE
      });

      const result = await fetchQuota();
      expect(result.ok).toBe(true);
      expect(result.configured).toBe(true);
      expect(result.usage.windows.CNY).toBeDefined();
      expect(result.usage.windows.CNY.valueLabel).toContain('CN\u00a5');
      expect(result.usage.windows.CNY.valueLabel).toContain('110.00');
      expect(result.usage.windows.CNY.usedPercent).toBeNull();
    });

    it('handles multiple currencies', async () => {
      mockAuth.deepseek = { key: 'sk-test' };
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '100', granted_balance: '0', topped_up_balance: '100' },
            { currency: 'USD', total_balance: '50', granted_balance: '0', topped_up_balance: '50' }
          ]
        })
      });

      const result = await fetchQuota();
      expect(result.usage.windows.CNY).toBeDefined();
      expect(result.usage.windows.USD).toBeDefined();
    });

    it('handles empty balance_infos gracefully', async () => {
      mockAuth.deepseek = { key: 'sk-test' };
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ is_available: false, balance_infos: [] })
      });

      const result = await fetchQuota();
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.error).toContain('No balance data');
    });

    it('handles network errors gracefully', async () => {
      mockAuth.deepseek = { key: 'sk-test' };
      fetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchQuota();
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.error).toBe('Network error');
    });
  });
});
