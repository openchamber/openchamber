import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import * as google from './google/index.js';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './index.js';

describe('quota provider registry', () => {
  it('exposes google provider configuration helpers through the provider module', () => {
    expect(google.providerId).toBe('google');
    expect(google.providerName).toBe('Google');
    expect(typeof google.isConfigured).toBe('function');
    expect(typeof google.resolveGoogleAuthSources).toBe('function');
  });

  it('can list configured providers without missing provider exports', () => {
    expect(() => listConfiguredQuotaProviders()).not.toThrow();
  });

  it('coalesces concurrent refreshes by provider ID', async () => {
    const first = fetchQuotaForProvider('unsupported-test-provider');
    const second = fetchQuotaForProvider('unsupported-test-provider');

    expect(first).toBe(second);
    await first;
    expect(fetchQuotaForProvider('unsupported-test-provider')).not.toBe(first);
  });
});

describe('malformed usage-providers.json isolation', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
  });

  it('a broken config file does not remove unrelated configured providers', async () => {
    vi.doMock('node:fs', () => ({
      default: {
        readFileSync: () => {
          throw new Error('broken json');
        },
      },
      readFileSync: () => {
        throw new Error('broken json');
      },
    }));
    const registry = await import('./index.js');
    expect(() => registry.listConfiguredQuotaProviders()).not.toThrow();
    const result = await registry.fetchQuotaForProvider('codex');
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toContain('usage-providers.json');
  });
});
