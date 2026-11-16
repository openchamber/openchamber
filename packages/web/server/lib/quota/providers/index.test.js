import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({ readOpenCodeCredentials: async () => ({}) }));

import * as google from './google/index.js';
import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './index.js';

describe('quota provider registry', () => {
  it('exposes google provider configuration helpers through the provider module', () => {
    expect(google.providerId).toBe('google');
    expect(google.providerName).toBe('Google');
    expect(typeof google.isConfigured).toBe('function');
    expect(typeof google.resolveGoogleAuthSources).toBe('function');
  });

  it('can list configured providers without missing provider exports', async () => {
    await expect(listConfiguredQuotaProviders()).resolves.toBeInstanceOf(Array);
  });

  it('lists ZenMux from its managed credential, whatever the OpenCode auth holds', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'quota-list-'));
    vi.stubEnv('OPENCHAMBER_DATA_DIR', dataDir);
    try {
      await expect(listConfiguredQuotaProviders()).resolves.not.toContain('zenmux');
      mkdirSync(join(dataDir, 'quota'), { recursive: true });
      writeFileSync(join(dataDir, 'quota', 'zenmux.json'), JSON.stringify({ platformApiKey: 'key' }));
      await expect(listConfiguredQuotaProviders()).resolves.toContain('zenmux');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('coalesces concurrent refreshes by provider ID', async () => {
    const first = fetchQuotaForProvider('unsupported-test-provider');
    const second = fetchQuotaForProvider('unsupported-test-provider');

    expect(first).toBe(second);
    await first;
    expect(fetchQuotaForProvider('unsupported-test-provider')).not.toBe(first);
  });
});
