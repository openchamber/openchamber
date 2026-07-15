import { describe, test, expect } from 'bun:test';
import { sanitizeManagedRemoteTunnelPresets, toggleDirectE2ee } from './tunnelSettingsState';

describe('tunnelSettingsState', () => {
  describe('sanitizeManagedRemoteTunnelPresets', () => {
    test('returns no presets for missing or non-array server data', () => {
      expect(sanitizeManagedRemoteTunnelPresets(undefined)).toEqual([]);
      expect(sanitizeManagedRemoteTunnelPresets({ presets: [] })).toEqual([]);
    });

    test('normalizes valid fields and preserves boolean direct E2EE state', () => {
      expect(sanitizeManagedRemoteTunnelPresets([
        { id: ' first ', name: ' First ', hostname: 'HTTPS://One.Example/path', directE2eeEnabled: true },
        { id: 'second', name: 'Second', hostname: 'two.example', directE2eeEnabled: false },
      ])).toEqual([
        { id: 'first', name: 'First', hostname: 'one.example', directE2eeEnabled: true },
        { id: 'second', name: 'Second', hostname: 'two.example', directE2eeEnabled: false },
      ]);
    });

    test('drops malformed and duplicate ID or normalized hostname entries deterministically', () => {
      expect(sanitizeManagedRemoteTunnelPresets([
        null,
        { id: '', name: 'Missing ID', hostname: 'missing-id.example' },
        { id: 'missing-name', name: '', hostname: 'missing-name.example' },
        { id: 'bad-host', name: 'Bad host', hostname: 'not a host' },
        { id: 'first', name: 'First', hostname: 'ONE.example' },
        { id: 'first', name: 'Duplicate ID', hostname: 'two.example' },
        { id: 'third', name: 'Duplicate host', hostname: 'https://one.example/path' },
      ])).toEqual([{ id: 'first', name: 'First', hostname: 'one.example' }]);
    });

    test('uses the existing legacy fallback convention only when no valid preset remains', () => {
      expect(sanitizeManagedRemoteTunnelPresets([], ' Legacy.Example ')).toEqual([{
        id: 'legacy-legacy.example',
        name: 'Legacy.Example',
        hostname: 'legacy.example',
      }]);
      expect(sanitizeManagedRemoteTunnelPresets([
        { id: 'valid', name: 'Valid', hostname: 'valid.example' },
      ], 'legacy.example')).toEqual([{ id: 'valid', name: 'Valid', hostname: 'valid.example' }]);
    });

    test('does not create a fallback for an invalid legacy hostname', () => {
      expect(sanitizeManagedRemoteTunnelPresets([], 'not a host')).toEqual([]);
    });

    test('rejects Object prototype IDs while preserving normal UUID and legacy IDs', () => {
      const reservedIds = [
        'prototype', 'constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty',
        '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable',
        'toString', 'valueOf', '__proto__', 'toLocaleString',
      ];
      for (const id of reservedIds) {
        expect(sanitizeManagedRemoteTunnelPresets([{ id, name: 'Unsafe', hostname: `${id.replaceAll('_', 'x')}.example` }])).toEqual([]);
      }
      expect(sanitizeManagedRemoteTunnelPresets([
        { id: '550e8400-e29b-41d4-a716-446655440000', name: 'UUID', hostname: 'uuid.example' },
      ])).toEqual([{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'UUID', hostname: 'uuid.example' }]);
      expect(sanitizeManagedRemoteTunnelPresets([], 'legacy.example')[0]?.id).toBe('legacy-legacy.example');
    });
  });

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

    test('rejects malformed, coerced, mismatched, and reserved response profiles', async () => {
      const valid = { id: 'p1', name: 'Test', hostname: 'test.com', directE2eeEnabled: false };
      const invalidPayloads = [
        { ok: 1, profile: valid },
        { ok: true, profile: [valid] },
        { ok: true, profile: { ...valid, id: 1 } },
        { ok: true, profile: { ...valid, name: null } },
        { ok: true, profile: { ...valid, hostname: 42 } },
        { ok: true, profile: { ...valid, directE2eeEnabled: 'false' } },
        { ok: true, profile: { ...valid, id: 'other' } },
        { ok: true, profile: { ...valid, hostname: 'not a host' } },
        { ok: true, profile: { ...valid, id: 'constructor' } },
      ];
      for (const payload of invalidPayloads) {
        const result = await toggleDirectE2ee('p1', false, async () => new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
        expect(result).toEqual({ ok: false });
      }
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
