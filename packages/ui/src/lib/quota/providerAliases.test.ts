import { describe, expect, test } from 'bun:test';
import { collectConnectedQuotaProviderIds, resolveQuotaProviderId } from './providerAliases';

describe('resolveQuotaProviderId', () => {
  test('maps OpenCode provider aliases onto quota IDs', () => {
    expect(resolveQuotaProviderId('google')).toBe('google');
    expect(resolveQuotaProviderId('gemini')).toBe('google');
    expect(resolveQuotaProviderId('github-copilot')).toBe('github-copilot');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
  });

  test('returns null for OpenCode Zen (no quota provider)', () => {
    expect(resolveQuotaProviderId('opencode')).toBeNull();
  });
});

describe('collectConnectedQuotaProviderIds', () => {
  test('collects unique mapped quota IDs from OpenCode provider list', () => {
    expect(collectConnectedQuotaProviderIds(['google', 'github-copilot', 'opencode', 'google']))
      .toEqual(new Set(['google', 'github-copilot', 'github-copilot-addon']));
  });

  test('maps gemini plugin id onto google quota provider', () => {
    expect(collectConnectedQuotaProviderIds(['gemini']))
      .toEqual(new Set(['google']));
  });
});
