import { describe, expect, test } from 'bun:test';

import { blockedAttemptsOf, isDomainName, providerAccessOf, spaceAccessNoticeOf } from './space-access';
import type { SpaceEntry, SpaceJournalRecord } from './spaces-api';

const anthropic = { kind: 'model' as const, id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', source: { kind: 'typed' as const }, url: 'http://gatekeeper:8080/model/anthropic' };
const openai = { ...anthropic, id: 'openai', provider: 'openai', source: { kind: 'env' as const, name: 'OPENAI_API_KEY' } };
const registry = { kind: 'domain' as const, id: 'open-0123456789ab', upstream: 'https://registry.example.com/', url: 'http://gatekeeper:8080/model/open-0123456789ab' };

const entry = (change: Partial<SpaceEntry> = {}): SpaceEntry => ({
  id: 'a1b2c3d4e5f6',
  name: 'Fix login',
  projectDirectory: '/home/me/app',
  directory: '/spaces/a1b2c3d4e5f6/app',
  state: 'running',
  step: null,
  failure: null,
  network: { mode: 'allowlist', domains: [] },
  grants: [anthropic, openai],
  access: 'granted',
  needsAccess: [],
  ...change,
});

describe('providerAccessOf', () => {
  test('a key held, a key lost at a restart, and none', () => {
    const space = entry({ access: 'needs_access', needsAccess: ['anthropic'] });
    expect(providerAccessOf(space, 'openai')).toBe('granted');
    expect(providerAccessOf(space, 'anthropic')).toBe('needs_again');
    expect(providerAccessOf(space, 'google')).toBe('none');
  });
});

describe('spaceAccessNoticeOf', () => {
  test('warns about keys lost at a restart, by provider', () => {
    expect(spaceAccessNoticeOf(entry({ access: 'needs_access', needsAccess: ['anthropic', registry.id], grants: [anthropic, openai, registry] }))).toEqual({ kind: 'needs_again', providers: ['anthropic'] });
  });

  test('warns about a running space with no model key, an opened domain not counting', () => {
    expect(spaceAccessNoticeOf(entry({ grants: [registry] }))).toEqual({ kind: 'no_model' });
    expect(spaceAccessNoticeOf(entry({ grants: [], access: null }))).toEqual({ kind: 'no_model' });
  });

  test('says it could not check rather than "granted" when the gatekeeper did not answer', () => {
    expect(spaceAccessNoticeOf(entry({ access: 'unknown' }))).toEqual({ kind: 'unknown' });
  });

  test('nothing for a space with its access, or one that is not running', () => {
    expect(spaceAccessNoticeOf(entry())).toBeNull();
    expect(spaceAccessNoticeOf(entry({ state: 'exited', grants: [] }))).toBeNull();
    expect(spaceAccessNoticeOf(entry({ state: 'preparing', grants: [] }))).toBeNull();
    expect(spaceAccessNoticeOf(undefined)).toBeNull();
  });
});

describe('blockedAttemptsOf', () => {
  const record = (host: string, decision: string, at: string, port = 443, listener = 'corridor'): SpaceJournalRecord => ({ at, listener, host, port, decision });

  test('one line per destination and reason, counted, the latest first, without what was allowed', () => {
    const attempts = blockedAttemptsOf([
      record('registry.npmjs.org', 'deny:not-on-allowlist', '2026-09-27T10:00:00.000Z'),
      record('api.anthropic.com', 'allow', '2026-09-27T10:00:01.000Z'),
      record('registry.npmjs.org', 'deny:not-on-allowlist', '2026-09-27T10:05:00.000Z'),
      record('down.example.com', 'failed:ECONNREFUSED', '2026-09-27T10:06:00.000Z'),
      record('internal.corp.example', 'deny:blocked-address', '2026-09-27T10:02:00.000Z'),
      record('ssh.example.com', 'deny:port', '2026-09-27T10:03:00.000Z', 22),
      record('ssh.example.com', 'deny:port', '2026-09-27T10:04:00.000Z', 2222),
    ]);
    expect(attempts).toEqual([
      { host: 'registry.npmjs.org', port: 443, reason: 'not_on_list', count: 2, last: '2026-09-27T10:05:00.000Z' },
      { host: 'ssh.example.com', port: 2222, reason: 'port', count: 1, last: '2026-09-27T10:04:00.000Z' },
      { host: 'ssh.example.com', port: 22, reason: 'port', count: 1, last: '2026-09-27T10:03:00.000Z' },
      { host: 'internal.corp.example', port: 443, reason: 'private_address', count: 1, last: '2026-09-27T10:02:00.000Z' },
    ]);
  });

  test('names every refusal the gatekeeper writes', () => {
    const reasons = blockedAttemptsOf([
      'deny:unresolved:ENOTFOUND', 'deny:not-a-name', 'deny:always-refused', 'deny:too-many-tunnels', 'deny:too-many-connections',
      'deny:malformed', 'deny:unreadable-request', 'deny:not-connect', 'deny:no-grant', 'deny:path-walks-out', 'deny:own-listener',
    ].map((decision, index) => record(`h${index}.example.com`, decision, `2026-09-27T10:00:${String(index).padStart(2, '0')}.000Z`))).map((attempt) => [attempt.host, attempt.reason]);
    expect(Object.fromEntries(reasons)).toEqual({
      'h0.example.com': 'unresolved', 'h1.example.com': 'address_not_name', 'h2.example.com': 'always_refused', 'h3.example.com': 'too_many', 'h4.example.com': 'too_many',
      'h5.example.com': 'other', 'h6.example.com': 'other', 'h7.example.com': 'other', 'h8.example.com': 'other', 'h9.example.com': 'other', 'h10.example.com': 'other',
    });
  });
});

describe('isDomainName', () => {
  test('the allowlist rule: names only', () => {
    expect(isDomainName('registry.npmjs.org')).toBe(true);
    for (const value of ['localhost', '10.0.0.1', '1746020849', 'a_b.example.com', 'example.com/x', 'https://example.com', 'Example.com', '']) {
      expect(isDomainName(value)).toBe(false);
    }
  });
});
