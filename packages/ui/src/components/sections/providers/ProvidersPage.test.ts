import { describe, expect, test } from 'bun:test';
import type { ConnectionInfo, IntegrationInfo } from '@opencode/client';
import { requiresProviderAuth, shouldLoadAvailableProviders } from './providerAvailability';
import {
  findIntegrationForProvider,
  getCredentialConnections,
  getKeyMethod,
  getOAuthMethods,
  getProviderConnections,
  getSignInIntegrationId,
  providerHasCredentials,
  shouldAutoOpenAuthPanel,
  shouldShowApiKeyAuth,
  shouldShowModelsSection,
} from './providerAuth';

const integration = (overrides: Partial<IntegrationInfo> = {}): IntegrationInfo => ({
  id: 'anthropic',
  name: 'Anthropic',
  methods: [],
  connections: [],
  ...overrides,
});

const credential: ConnectionInfo = { type: 'credential', id: 'cred_1', label: 'API key', method: 'key' };
const envConnection: ConnectionInfo = { type: 'env', name: 'ANTHROPIC_API_KEY' };

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

describe('integration method helpers', () => {
  test('findIntegrationForProvider matches a provider to the integration of the same id', () => {
    const list = [integration(), integration({ id: 'openai', name: 'OpenAI' })];
    expect(findIntegrationForProvider(list, 'openai')?.name).toBe('OpenAI');
    expect(findIntegrationForProvider(list, 'unknown')).toBe(undefined);
  });

  test('shouldShowApiKeyAuth hides the API key form for oauth-only integrations', () => {
    expect(shouldShowApiKeyAuth(integration({ methods: [{ type: 'oauth', id: 'login', label: 'Cursor OAuth' }] }))).toBe(false);
    expect(shouldShowApiKeyAuth(integration({
      methods: [{ type: 'key', label: 'API Key' }, { type: 'oauth', id: 'chatgpt', label: 'ChatGPT' }],
    }))).toBe(true);
    expect(shouldShowApiKeyAuth(integration({ methods: [{ type: 'key' }] }))).toBe(true);
    // A provider OpenCode has no integration for (a custom one from
    // opencode.json) is still keyed by an API key.
    expect(shouldShowApiKeyAuth(undefined)).toBe(true);
  });

  test('getOAuthMethods keeps only oauth methods, in declared order', () => {
    const methods: IntegrationInfo['methods'] = [
      { type: 'key', label: 'API Key' },
      { type: 'oauth', id: 'browser', label: 'OAuth' },
      { type: 'env', names: ['OPENAI_API_KEY'] },
      { type: 'oauth', id: 'device', label: 'Device' },
    ];
    expect(getOAuthMethods(integration({ methods })).map((method) => method.id)).toEqual(['browser', 'device']);
    expect(getOAuthMethods(undefined)).toEqual([]);
  });

  test('getKeyMethod returns the key method when the integration accepts one', () => {
    expect(getKeyMethod(integration({ methods: [{ type: 'key', label: 'API Key' }] }))?.label).toBe('API Key');
    expect(getKeyMethod(integration({ methods: [{ type: 'oauth', id: 'a', label: 'A' }] }))).toBe(undefined);
  });

  test('getCredentialConnections keeps only removable stored credentials', () => {
    expect(getCredentialConnections(integration({ connections: [credential, envConnection] })))
      .toEqual([credential]);
    expect(getCredentialConnections(integration({ connections: [envConnection] }))).toEqual([]);
  });
});

describe('Console sign-in for OpenCode Go', () => {
  test('OpenCode Go signs in through the Console integration; others use their own', () => {
    expect(getSignInIntegrationId('opencode-go')).toBe('opencode');
    expect(getSignInIntegrationId('anthropic')).toBe('anthropic');
  });

  test('a Console sign-in counts as OpenCode Go credentials', () => {
    const list = [
      integration({ id: 'opencode-go', name: 'OpenCode Go' }),
      integration({ id: 'opencode', name: 'OpenCode Console', connections: [credential] }),
    ];
    expect(getProviderConnections(list, 'opencode-go')).toEqual([credential]);
    expect(getProviderConnections(list, 'anthropic')).toBe(undefined);
    expect(getProviderConnections([integration({ connections: [envConnection] })], 'anthropic')).toEqual([envConnection]);
  });
});

describe('provider credential state helpers', () => {
  test('providerHasCredentials requires a connection or an inline options.apiKey', () => {
    // Built-in catalog entry with no credential signal at all.
    expect(providerHasCredentials({ connections: [] })).toBe(false);
    expect(providerHasCredentials({})).toBe(false);

    // A stored credential is the ordinary "logged in" signal.
    expect(providerHasCredentials({ connections: [credential] })).toBe(true);
  });

  test('providerHasCredentials counts an env connection', () => {
    // Bedrock/Azure/Vertex resolve credentials from environment variables;
    // OpenCode reports those as env connections on the integration.
    expect(providerHasCredentials({ connections: [envConnection] })).toBe(true);
  });

  test('providerHasCredentials treats options.apiKey as a usable credential', () => {
    // Config-defined providers write the key straight into opencode.json, so
    // they never get an integration connection.
    expect(providerHasCredentials({ connections: [], optionsApiKey: 'sk-config' })).toBe(true);
    expect(providerHasCredentials({ connections: [], optionsApiKey: '' })).toBe(false);
    expect(providerHasCredentials({ connections: [], optionsApiKey: '   ' })).toBe(false);
    expect(providerHasCredentials({ connections: [], optionsApiKey: null })).toBe(false);
  });

  test('OAuth-only provider without credentials opens the panel and hides models', () => {
    const hasCredentials = providerHasCredentials({ connections: [] });
    expect(hasCredentials).toBe(false);
    expect(shouldAutoOpenAuthPanel({
      integrationsLoaded: true,
      hasCredentials,
      userDismissed: false,
    })).toBe(true);
    expect(shouldShowModelsSection({
      modelCount: 1,
      integrationsLoaded: true,
      hasCredentials,
    })).toBe(false);
  });

  test('provider with a stored credential shows Connected and models', () => {
    const hasCredentials = providerHasCredentials({ connections: [credential] });
    expect(hasCredentials).toBe(true);
    expect(shouldAutoOpenAuthPanel({
      integrationsLoaded: true,
      hasCredentials,
      userDismissed: false,
    })).toBe(false);
    expect(shouldShowModelsSection({
      modelCount: 3,
      integrationsLoaded: true,
      hasCredentials,
    })).toBe(true);
  });

  test('editable custom provider keeps models visible even with no credentials signal', () => {
    // Config-defined custom providers (e.g. local LM Studio/Ollama style)
    // are user-editable in place; a stale 'Credentials missing' must not
    // hide their models section.
    const hasCredentials = providerHasCredentials({ connections: [], optionsApiKey: null });
    expect(hasCredentials).toBe(false);
    expect(shouldShowModelsSection({
      modelCount: 1,
      integrationsLoaded: true,
      hasCredentials: false,
      isEditableCustomProvider: true,
    })).toBe(true);
    expect(shouldShowModelsSection({
      modelCount: 1,
      integrationsLoaded: true,
      hasCredentials: false,
      isEditableCustomProvider: false,
    })).toBe(false);
  });

  test('a credential write flips the page out of the missing-credentials state', () => {
    // Pre-save: the integration reports no connection.
    const before = providerHasCredentials({ connections: [] });
    expect(before).toBe(false);
    expect(shouldShowModelsSection({
      modelCount: 2,
      integrationsLoaded: true,
      hasCredentials: before,
    })).toBe(false);

    // After the integration refetch, the stored credential shows up.
    const after = providerHasCredentials({ connections: [credential] });
    expect(after).toBe(true);
    expect(shouldAutoOpenAuthPanel({
      integrationsLoaded: true,
      hasCredentials: after,
      userDismissed: false,
    })).toBe(false);
    expect(shouldShowModelsSection({
      modelCount: 2,
      integrationsLoaded: true,
      hasCredentials: after,
    })).toBe(true);
  });

  test('explicit hide keeps the auth panel closed while credentials are still missing', () => {
    expect(shouldAutoOpenAuthPanel({
      integrationsLoaded: true,
      hasCredentials: false,
      userDismissed: true,
    })).toBe(false);
  });

  test('models stay visible while integrations are still loading', () => {
    expect(shouldShowModelsSection({
      modelCount: 4,
      integrationsLoaded: false,
      hasCredentials: false,
    })).toBe(true);
  });
});
