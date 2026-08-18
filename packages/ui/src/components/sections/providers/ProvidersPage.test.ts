import { describe, expect, test } from 'bun:test';
import { shouldLoadAvailableProviders } from './providerAvailability';
import {
  getOAuthAuthMethods,
  normalizeAuthType,
  parseAuthPayload,
  requiresOpenCodeRestartAfterOAuth,
  shouldShowApiKeyAuth,
} from './providerAuth';

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });
});

describe('provider auth method helpers', () => {
  test('normalizeAuthType recognizes oauth and api labels', () => {
    expect(normalizeAuthType({ type: 'oauth', label: 'Login with Cursor' })).toBe('oauth');
    expect(normalizeAuthType({ type: 'api', label: 'API Key' })).toBe('api');
    expect(normalizeAuthType({ label: 'OAuth browser login' })).toBe('oauth');
    expect(normalizeAuthType({ name: 'API key' })).toBe('api');
  });

  test('parseAuthPayload keeps only object auth method entries', () => {
    expect(parseAuthPayload({
      cursor: [{ type: 'oauth', label: 'Cursor' }, 'skip'],
      openai: null,
    })).toEqual({
      cursor: [{ type: 'oauth', label: 'Cursor' }],
    });
    expect(parseAuthPayload(null)).toEqual({});
  });

  test('shouldShowApiKeyAuth hides API key for oauth-only providers', () => {
    expect(shouldShowApiKeyAuth([{ type: 'oauth', label: 'Cursor OAuth' }])).toBe(false);
    expect(shouldShowApiKeyAuth([
      { type: 'api', label: 'API Key' },
      { type: 'oauth', label: 'ChatGPT' },
    ])).toBe(true);
    expect(shouldShowApiKeyAuth([{ type: 'api', label: 'API Key' }])).toBe(true);
    // Unknown / unloaded methods keep the legacy API key fallback.
    expect(shouldShowApiKeyAuth([])).toBe(true);
  });

  test('getOAuthAuthMethods preserves original method indexes', () => {
    const methods = [
      { type: 'api', label: 'API Key' },
      { type: 'oauth', label: 'OAuth' },
      { type: 'oauth', label: 'Device' },
    ];
    expect(getOAuthAuthMethods(methods)).toEqual([
      { method: methods[1], methodIndex: 1 },
      { method: methods[2], methodIndex: 2 },
    ]);
    expect(getOAuthAuthMethods([{ type: 'oauth', label: 'Cursor' }])).toEqual([
      { method: { type: 'oauth', label: 'Cursor' }, methodIndex: 0 },
    ]);
  });

  test('Claude CLI OAuth does not require an OpenCode restart', () => {
    expect(requiresOpenCodeRestartAfterOAuth('claude-code')).toBe(false);
    expect(requiresOpenCodeRestartAfterOAuth('github-copilot')).toBe(true);
  });
});
