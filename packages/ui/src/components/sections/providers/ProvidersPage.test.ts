import { describe, expect, test } from 'bun:test';
import { requiresProviderAuth, shouldLoadAvailableProviders } from './providerAvailability';
import {
  getOAuthAuthMethods,
  normalizeAuthType,
  parseAuthPayload,
requiresOpenCodeRestartAfterOAuth,
  providerHasCredentials,
  shouldAutoOpenAuthPanel,
  shouldShowApiKeyAuth,
  shouldShowModelsSection,
} from './providerAuth';

describe('ProvidersPage available provider loading', () => {
  test('loads available providers only in add-provider mode', () => {
    expect(shouldLoadAvailableProviders(false)).toBe(false);
    expect(shouldLoadAvailableProviders(true)).toBe(true);
  });
});

describe('ProvidersPage provider authentication', () => {
  test('does not require credentials for a custom provider defined in config', () => {
    expect(requiresProviderAuth(true, false, true)).toBe(false);
    expect(requiresProviderAuth(true, false, false)).toBe(true);
    expect(requiresProviderAuth(true, true, false)).toBe(false);
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

describe('provider credential state helpers', () => {
  test('providerHasCredentials ignores declared env names and requires key or auth source', () => {
    // Built-in catalog entry with env var names but no actual credential.
    expect(providerHasCredentials({ key: undefined, authSourceExists: false })).toBe(false);
    expect(providerHasCredentials({ key: '', authSourceExists: false })).toBe(false);
    expect(providerHasCredentials({ key: '   ', authSourceExists: false })).toBe(false);

    // OpenCode reports an active credential via provider.key.
    expect(providerHasCredentials({ key: 'sk-...', authSourceExists: false })).toBe(true);
    // Auth.json provenance alone is enough while sources are authoritative.
    expect(providerHasCredentials({ key: undefined, authSourceExists: true })).toBe(true);
  });

  test('env-less OAuth-only provider without credentials opens panel and hides models', () => {
    const hasCredentials = providerHasCredentials({
      key: undefined,
      authSourceExists: false,
    });
    expect(hasCredentials).toBe(false);
    expect(shouldAutoOpenAuthPanel({
      sourcesLoaded: true,
      hasCredentials,
      userDismissed: false,
    })).toBe(true);
    expect(shouldShowModelsSection({
      modelCount: 1,
      sourcesLoaded: true,
      hasCredentials,
    })).toBe(false);
  });

  test('provider with stored auth or key shows Connected and models', () => {
    const fromKey = providerHasCredentials({ key: 'sk-live', authSourceExists: false });
    const fromAuth = providerHasCredentials({ key: undefined, authSourceExists: true });
    expect(fromKey).toBe(true);
    expect(fromAuth).toBe(true);
    expect(shouldAutoOpenAuthPanel({
      sourcesLoaded: true,
      hasCredentials: fromKey,
      userDismissed: false,
    })).toBe(false);
    expect(shouldShowModelsSection({
      modelCount: 3,
      sourcesLoaded: true,
      hasCredentials: fromAuth,
    })).toBe(true);
  });

  test('auth save followed by providers refresh recognizes credentials without stale missing state', () => {
    // Pre-save: sources say no auth, provider has no key yet.
    const before = providerHasCredentials({
      key: undefined,
      authSourceExists: false,
    });
    expect(before).toBe(false);
    expect(shouldShowModelsSection({
      modelCount: 2,
      sourcesLoaded: true,
      hasCredentials: before,
    })).toBe(false);

    // After reloadOpenCodeConfiguration, providers array gets a key even if the
    // sources snapshot has not been refetched yet.
    const afterProvidersRefresh = providerHasCredentials({
      key: 'oauth-token-present',
      authSourceExists: false,
    });
    expect(afterProvidersRefresh).toBe(true);
    expect(shouldAutoOpenAuthPanel({
      sourcesLoaded: true,
      hasCredentials: afterProvidersRefresh,
      userDismissed: false,
    })).toBe(false);
    expect(shouldShowModelsSection({
      modelCount: 2,
      sourcesLoaded: true,
      hasCredentials: afterProvidersRefresh,
    })).toBe(true);

    // After sources refetch completes, auth.exists also becomes true.
    expect(providerHasCredentials({
      key: 'oauth-token-present',
      authSourceExists: true,
    })).toBe(true);
  });

  test('explicit hide keeps the auth panel closed while credentials are still missing', () => {
    expect(shouldAutoOpenAuthPanel({
      sourcesLoaded: true,
      hasCredentials: false,
      userDismissed: true,
    })).toBe(false);
  });

  test('models stay visible while sources are still loading', () => {
    expect(shouldShowModelsSection({
      modelCount: 4,
      sourcesLoaded: false,
      hasCredentials: false,
    })).toBe(true);
  });
});
