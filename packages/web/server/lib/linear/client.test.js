import { describe, expect, it } from 'vitest';

import {
  createLinearClient,
  parseIssueReference,
  resolveLinearAuthorizationHeader,
  LinearApiError,
} from './client.js';

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

describe('resolveLinearAuthorizationHeader', () => {
  it('sends personal API keys raw (no Bearer prefix)', () => {
    expect(resolveLinearAuthorizationHeader('lin_api_abc')).toBe('lin_api_abc');
  });

  it('sends OAuth tokens with a Bearer prefix', () => {
    expect(resolveLinearAuthorizationHeader('lin_oauth_abc')).toBe('Bearer lin_oauth_abc');
  });

  it('returns null for empty input', () => {
    expect(resolveLinearAuthorizationHeader('')).toBeNull();
    expect(resolveLinearAuthorizationHeader(null)).toBeNull();
  });
});

describe('parseIssueReference', () => {
  it('accepts identifiers and normalizes casing', () => {
    expect(parseIssueReference('eng-123')).toBe('ENG-123');
  });

  it('extracts the identifier from an issue URL', () => {
    expect(parseIssueReference('https://linear.app/acme/issue/ENG-42/fix-the-thing')).toBe('ENG-42');
  });

  it('accepts UUIDs verbatim', () => {
    const uuid = '9cfb482a-81e3-4154-b5b9-2c805e70a02d';
    expect(parseIssueReference(uuid)).toBe(uuid);
  });

  it('rejects unrecognized input', () => {
    expect(parseIssueReference('not an issue')).toBeNull();
    expect(parseIssueReference('')).toBeNull();
  });
});

describe('createLinearClient', () => {
  it('sends the GraphQL query with the personal key auth header', async () => {
    const calls = [];
    const client = createLinearClient({
      getApiKey: () => 'lin_api_secret',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({ data: { viewer: { id: 'u1', name: 'Ada' }, organization: null } });
      },
    });
    const result = await client.fetchViewer();
    expect(result.viewer.id).toBe('u1');
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.Authorization).toBe('lin_api_secret');
    expect(JSON.parse(calls[0].init.body).query).toContain('viewer');
  });

  it('maps 401 to an auth failure', async () => {
    const client = createLinearClient({
      getApiKey: () => 'lin_api_bad',
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 401 }),
    });
    await expect(client.listTeams()).rejects.toMatchObject({
      name: 'LinearApiError',
      authFailed: true,
    });
  });

  it('surfaces GraphQL errors as failures, not empty data', async () => {
    const client = createLinearClient({
      getApiKey: () => 'lin_api_ok',
      fetchImpl: async () =>
        jsonResponse({ data: null, errors: [{ message: 'Entity not found' }] }),
    });
    await expect(client.fetchIssue('ENG-1')).rejects.toThrow('Entity not found');
  });

  it('fails when no key is configured instead of sending an unauthenticated request', async () => {
    const client = createLinearClient({
      getApiKey: () => null,
      fetchImpl: async () => {
        throw new Error('must not be called');
      },
    });
    await expect(client.listTeams()).rejects.toBeInstanceOf(LinearApiError);
  });

  it('rejects failed mutations that report success: false', async () => {
    const client = createLinearClient({
      getApiKey: () => 'lin_api_ok',
      fetchImpl: async () => jsonResponse({ data: { commentCreate: { success: false } } }),
    });
    await expect(client.createComment({ issueId: 'i1', body: 'x' })).rejects.toThrow(
      'comment creation failed',
    );
  });
});
