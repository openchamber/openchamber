import { describe, expect, test } from 'bun:test';
import type { IntegrationInfo } from '@opencode/client';
import { listConnectableProviders, splitConnectableProviders } from './connectableProviders';

const integration = (id: string, name: string, overrides: Partial<IntegrationInfo> = {}): IntegrationInfo => ({
  id,
  name,
  methods: [],
  connections: [],
  ...overrides,
});

const catalog = (integrations: IntegrationInfo[], webSearchIds: ReadonlySet<string> | null = null) => ({ integrations, webSearchIds });

describe('listConnectableProviders', () => {
  test('keeps unconnected integrations, sorted by name', () => {
    const result = listConnectableProviders(catalog([
      integration('zai', 'Z.AI'),
      integration('302ai', '302.AI'),
      integration('openrouter', 'OpenRouter'),
    ]), new Set());
    expect(result.map((provider) => provider.id)).toEqual(['302ai', 'openrouter', 'zai']);
  });

  test('leaves out connected integrations, MCP sign-ins, web search providers and listed providers', () => {
    const result = listConnectableProviders(catalog([
      integration('anthropic', 'Anthropic', { connections: [{ type: 'credential', id: 'cred_1', label: 'Key', method: 'key' }] }),
      integration('openai', 'OpenAI', { connections: [{ type: 'env', name: 'OPENAI_API_KEY' }] }),
      integration('mcp_abc', 'Linear'),
      integration('exa', 'Exa'),
      integration('opencode', 'OpenCode Zen'),
      integration('openrouter', 'OpenRouter'),
    ], new Set(['exa'])), new Set(['opencode']));
    expect(result.map((provider) => provider.id)).toEqual(['openrouter']);
  });

  test('keeps web search providers when that list could not be read', () => {
    const result = listConnectableProviders(catalog([integration('exa', 'Exa')], null), new Set());
    expect(result.map((provider) => provider.id)).toEqual(['exa']);
  });

  test('falls back to the id when an integration has no name', () => {
    expect(listConnectableProviders(catalog([integration('local', '')]), new Set())).toEqual([{ id: 'local', name: 'local' }]);
  });
});

describe('splitConnectableProviders', () => {
  test('puts popular providers first in their fixed order, recommended ones leading', () => {
    const { popular, others } = splitConnectableProviders([
      { id: '302ai', name: '302.AI' },
      { id: 'google', name: 'Google' },
      { id: 'openrouter', name: 'OpenRouter' },
      { id: 'openai', name: 'OpenAI' },
    ]);
    expect(popular.map((provider) => [provider.id, provider.recommended])).toEqual([
      ['openai', true],
      ['openrouter', true],
      ['google', false],
    ]);
    expect(others.map((provider) => provider.id)).toEqual(['302ai']);
  });

  test('a popular provider that cannot be connected anymore drops out', () => {
    expect(splitConnectableProviders([{ id: 'zai', name: 'Z.AI' }]).popular).toEqual([]);
  });
});
