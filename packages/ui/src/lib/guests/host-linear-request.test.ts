import { describe, expect, test } from 'bun:test';

import { isHostLinearIssueGet } from './host-linear-request.ts';

describe('isHostLinearIssueGet', () => {
  test('only a host Linear guest may call the first-party get route', () => {
    expect(isHostLinearIssueGet('host', { method: 'GET', path: '/api/linear/issues/get' })).toBe(true);
    expect(isHostLinearIssueGet('oauth', { method: 'GET', path: '/api/linear/issues/get' })).toBe(false);
    expect(isHostLinearIssueGet('token', { method: 'GET', path: '/api/linear/issues/get' })).toBe(false);
    expect(isHostLinearIssueGet('host', { method: 'POST', path: '/api/linear/issues/get' })).toBe(false);
    expect(isHostLinearIssueGet('host', { method: 'GET', path: '/graphql' })).toBe(false);
  });
});
