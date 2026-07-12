import { describe, test, expect } from 'bun:test';
import { toggleDirectE2ee } from './tunnelSettingsState';

describe('tunnelSettingsState', () => {
  describe('toggleDirectE2ee', () => {
    test('sends PATCH request and returns profile on success, sanitizing token', async () => {
      let calledUrl: RequestInfo | URL = '';
      let calledOptions: RequestInit | undefined = undefined;

      const mockFetch = async (url: RequestInfo | URL, options?: RequestInit) => {
        calledUrl = url;
        calledOptions = options;
        const payload = {
          ok: true,
          profile: { id: 'p1', name: 'Test', hostname: 'test.com', directE2eeEnabled: true, token: 'secret' }
        };
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const result = await toggleDirectE2ee('p1', true, mockFetch);

      expect(calledUrl).toBe('/api/openchamber/tunnel/managed-remote-profile/p1');
      expect(calledOptions).toBeDefined();
      if (calledOptions) {
        expect((calledOptions as RequestInit).method).toBe('PATCH');
        expect((calledOptions as RequestInit).body).toBe(JSON.stringify({ directE2eeEnabled: true }));
      }
      
      expect(result.ok).toBe(true);
      expect(result.profile?.directE2eeEnabled).toBe(true);
      if (result.profile) {
        expect('token' in result.profile).toBe(false);
      }
    });

    test('returns error on non-ok HTTP response', async () => {
      const mockFetch = async () => {
        return new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      };

      const result = await toggleDirectE2ee('p1', true, mockFetch);

      expect(result.ok).toBe(false);
    });

    test('returns error on {ok:false} response', async () => {
      const mockFetch = async () => {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid profile' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const result = await toggleDirectE2ee('p1', true, mockFetch);

      expect(result.ok).toBe(false);
    });

    test('returns error on network failure', async () => {
      const mockFetch = async () => {
        throw new Error('Network error');
      };

      const result = await toggleDirectE2ee('p1', true, mockFetch);

      expect(result.ok).toBe(false);
    });
  });
});
