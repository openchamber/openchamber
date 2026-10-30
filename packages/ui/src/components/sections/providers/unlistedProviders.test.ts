import { describe, expect, test } from 'bun:test';
import type { ConnectionInfo, IntegrationInfo } from '@opencode/client';
import { listUnlistedConnectedProviders, toProviderWithModels } from './unlistedProviders';

const integration = (id: string, name: string, overrides: Partial<IntegrationInfo> = {}): IntegrationInfo => ({
  id,
  name,
  methods: [],
  connections: [],
  ...overrides,
});

const credential: ConnectionInfo = { type: 'credential', id: 'cred_1', label: 'GitHub', method: 'oauth' };
const catalog = (integrations: IntegrationInfo[], webSearchIds: ReadonlySet<string> | null = null) => ({ integrations, webSearchIds });
const ids = (providers: ReturnType<typeof listUnlistedConnectedProviders>) => providers.map((provider) => provider.id);

describe('listUnlistedConnectedProviders', () => {
  test('keeps a connected integration OpenCode reports no provider for', () => {
    // What a Copilot Free login leaves behind: the credential is stored, the
    // provider serves no chat model, so OpenCode lists no provider at all.
    const result = listUnlistedConnectedProviders(
      catalog([integration('github-copilot', 'GitHub Copilot', { connections: [credential] })]),
      new Set(),
    );
    expect(result).toEqual([{ id: 'github-copilot', name: 'GitHub Copilot', integrationID: undefined }]);
  });

  test('leaves out unconnected integrations, MCP sign-ins and search keys', () => {
    const result = listUnlistedConnectedProviders(catalog([
      integration('openrouter', 'OpenRouter'),
      integration('mcp_abc', 'Linear', { connections: [credential] }),
      integration('exa', 'Exa', { connections: [credential] }),
      integration('brave', 'Brave Search', { connections: [credential], metadata: { websearch: true } }),
      integration('anthropic', 'Anthropic', { connections: [credential] }),
    ], new Set(['exa'])), new Set());
    expect(ids(result)).toEqual(['anthropic']);
  });

  test('leaves out a provider OpenCode already lists', () => {
    const list = [integration('anthropic', 'Anthropic', { connections: [credential] })];
    expect(listUnlistedConnectedProviders(catalog(list), new Set(['anthropic']))).toEqual([]);
  });

  test('a Console login surfaces as OpenCode Go, on the integration that holds it', () => {
    // Go signs in through the Console, so the credential sits on `opencode`
    // while the provider it belongs to is `opencode-go`.
    const result = listUnlistedConnectedProviders(
      catalog([integration('opencode', 'OpenCode Console', { connections: [credential] })]),
      new Set(),
    );
    expect(result).toEqual([{ id: 'opencode-go', name: 'OpenCode Console', integrationID: 'opencode' }]);
  });

  test('a listed Console provider keeps its own card', () => {
    const list = [integration('opencode', 'OpenCode Console', { connections: [credential] })];
    expect(listUnlistedConnectedProviders(catalog(list), new Set(['opencode']))).toEqual([]);
  });

  test('shows one card when both of a provider’s integrations hold a connection', () => {
    const result = listUnlistedConnectedProviders(catalog([
      integration('opencode-go', 'OpenCode Go', { connections: [credential] }),
      integration('opencode', 'OpenCode Console', { connections: [credential] }),
    ]), new Set());
    expect(ids(result)).toEqual(['opencode-go']);
    // The card is the provider's own integration; the Console login is listed
    // with it as a second account.
    expect(result[0]?.integrationID).toBe(undefined);
  });

  test('sorts by name', () => {
    const result = listUnlistedConnectedProviders(catalog([
      integration('zai', 'Z.AI', { connections: [credential] }),
      integration('302ai', '302.AI', { connections: [credential] }),
    ]), new Set());
    expect(ids(result)).toEqual(['302ai', 'zai']);
  });

  test('falls back to the id when an integration has no name', () => {
    const result = listUnlistedConnectedProviders(catalog([integration('local', '', { connections: [credential] })]), new Set());
    expect(result).toEqual([{ id: 'local', name: 'local', integrationID: undefined }]);
  });
});

describe('toProviderWithModels', () => {
  test('is a provider the page can open, with no models to show', () => {
    expect(toProviderWithModels({ id: 'github-copilot', name: 'GitHub Copilot' })).toEqual({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      activation: 'auto',
      package: '',
      integrationID: undefined,
      models: [],
    });
  });
});
