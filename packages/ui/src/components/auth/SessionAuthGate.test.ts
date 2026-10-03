import { describe, expect, test } from 'bun:test';

import { runtimeIdentityMatches } from './sessionAuthGateState';

describe('runtimeIdentityMatches', () => {
  test('rejects async auth results after switching hosts', () => {
    expect(runtimeIdentityMatches(
      { apiBaseUrl: 'https://host-a.example', runtimeKey: 'host:a' },
      { apiBaseUrl: 'https://host-b.example', runtimeKey: 'host:b' },
    )).toBe(false);
  });

  test('accepts a credential refresh for the same host', () => {
    expect(runtimeIdentityMatches(
      { apiBaseUrl: 'https://host-a.example', runtimeKey: 'host:a' },
      { apiBaseUrl: 'https://host-a.example', runtimeKey: 'host:a' },
    )).toBe(true);
  });
});
