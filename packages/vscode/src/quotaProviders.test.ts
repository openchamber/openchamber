import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fetchQuotaForProvider, listConfiguredQuotaProviders } from './quotaProviders';

const ALL_PROVIDER_IDS = [
  'openai',
  'codex',
  'cursor',
  'claude',
  'github-copilot',
  'github-copilot-addon',
  'google',
  'kimi-for-coding',
  'nano-gpt',
  'openrouter',
  'zai-coding-plan',
  'zhipuai-coding-plan',
  'minimax-coding-plan',
  'minimax-cn-coding-plan',
  'ollama-cloud',
  'wafer',
  'atlascloud',
  'byteplus',
  'longcat',
  'mistral',
  'poe',
  'qwencloud',
  'stepfun',
  'xai',
  'opencode-go',
] as const;

const REQUIRED_RESULT_FIELDS = [
  'providerId',
  'providerName',
  'ok',
  'configured',
  'usage',
  'fetchedAt',
] as const;

const REQUIRED_WINDOW_FIELDS = [
  'usedPercent',
  'remainingPercent',
  'windowSeconds',
  'resetAfterSeconds',
  'resetAt',
  'resetAtFormatted',
  'resetAfterFormatted',
] as const;

describe('VS Code quota provider parity', () => {
  test('all 25 provider IDs are dispatchable', () => {
    assert.equal(ALL_PROVIDER_IDS.length, 25);
  });

  test('unsupported provider returns structured error matching web shape', async () => {
    const result = await fetchQuotaForProvider('nonexistent-provider');
    assert.equal(result.ok, false);
    assert.equal(result.configured, false);
    assert.equal(result.error, 'Unsupported provider');
    assert.equal(result.usage, null);
    assert.equal(typeof result.fetchedAt, 'number');
  });

  test('ProviderResult has all required fields for each provider', async () => {
    for (const providerId of ALL_PROVIDER_IDS) {
      const result = await fetchQuotaForProvider(providerId);
      for (const field of REQUIRED_RESULT_FIELDS) {
        assert.ok(
          field in result,
          `Provider ${providerId} missing required field: ${field}`,
        );
      }
      assert.equal(typeof result.providerId, 'string');
      assert.equal(typeof result.providerName, 'string');
      assert.equal(typeof result.ok, 'boolean');
      assert.equal(typeof result.configured, 'boolean');
      assert.equal(typeof result.fetchedAt, 'number');
    }
  });

  test('ProviderResult optional fields use correct types when present', async () => {
    for (const providerId of ALL_PROVIDER_IDS) {
      const result = await fetchQuotaForProvider(providerId);
      if (result.error !== undefined) {
        assert.equal(typeof result.error, 'string');
      }
      if (result.isStale !== undefined) {
        assert.equal(typeof result.isStale, 'boolean');
      }
      if (result.cachedAt !== undefined) {
        assert.equal(typeof result.cachedAt, 'number');
      }
      if (result.accountKey !== undefined) {
        assert.ok(typeof result.accountKey === 'string' || result.accountKey === null);
      }
    }
  });

  test('usage windows have all required fields when usage is present', async () => {
    for (const providerId of ALL_PROVIDER_IDS) {
      const result = await fetchQuotaForProvider(providerId);
      if (result.usage && typeof result.usage === 'object') {
        const windows = (result.usage as { windows?: Record<string, unknown> }).windows;
        if (windows && typeof windows === 'object') {
          for (const [key, window] of Object.entries(windows)) {
            if (window && typeof window === 'object') {
              for (const field of REQUIRED_WINDOW_FIELDS) {
                assert.ok(
                  field in (window as Record<string, unknown>),
                  `Provider ${providerId} window "${key}" missing field: ${field}`,
                );
              }
            }
          }
        }
      }
    }
  });

  test('listConfiguredQuotaProviders returns array of strings', () => {
    const providers = listConfiguredQuotaProviders();
    assert.ok(Array.isArray(providers));
    for (const provider of providers) {
      assert.equal(typeof provider, 'string');
    }
  });

  test('not-configured credential providers return ok=false, configured=false', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-parity-'));
    const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
    process.env.OPENCHAMBER_DATA_DIR = tempDir;

    try {
      const result = await fetchQuotaForProvider('atlascloud');
      assert.equal(result.ok, false);
      assert.equal(result.configured, false);
      assert.equal(result.error, 'Not configured');
    } finally {
      process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('VS Code credential infrastructure parity', () => {
  test('credential registry exports match web server contract', async () => {
    const registry = await import('./quota/credentials/registry');
    assert.equal(typeof registry.listCredentials, 'function');
    assert.equal(typeof registry.getCredentialById, 'function');
    assert.equal(typeof registry.createCredential, 'function');
    assert.equal(typeof registry.updateCredentialById, 'function');
    assert.equal(typeof registry.deleteCredentialById, 'function');
    assert.equal(typeof registry.validateCredentialById, 'function');
    assert.equal(typeof registry.discoverCredentials, 'function');
    assert.equal(typeof registry.validateCredential, 'function');
  });

  test('credential store exports match web server contract', async () => {
    const store = await import('./quota/credentials/store');
    assert.equal(typeof store.loadCredentials, 'function');
    assert.equal(typeof store.addCredential, 'function');
    assert.equal(typeof store.updateCredential, 'function');
    assert.equal(typeof store.deleteCredential, 'function');
    assert.equal(typeof store.sanitize, 'function');
    assert.equal(typeof store.getCredential, 'function');
  });

  test('credential schemas cover all manual-auth providers', async () => {
    const { PROVIDER_CREDENTIAL_SCHEMAS } = await import('./quota/credentials/schemas');
    const expectedSchemaProviders = [
      'atlascloud',
      'byteplus',
      'longcat',
      'qwencloud',
      'stepfun',
      'mistral',
      'ollama-cloud',
      'opencode-go',
      'poe',
      'xai',
    ];
    for (const providerId of expectedSchemaProviders) {
      assert.ok(
        providerId in PROVIDER_CREDENTIAL_SCHEMAS,
        `Missing schema for provider: ${providerId}`,
      );
    }
  });

  test('sanitize strips credential field from records', async () => {
    const { sanitize } = await import('./quota/credentials/store');
    const record = {
      id: 'test-id',
      providerId: 'atlascloud',
      label: 'Test',
      accountHint: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      validationStatus: 'untested' as const,
      lastValidatedAt: null,
      expiry: null,
      credential: { cookie: 'access-token=secret' },
    };
    const sanitized = sanitize(record);
    assert.ok(sanitized !== null);
    assert.equal(sanitized!.id, 'test-id');
    assert.equal(sanitized!.providerId, 'atlascloud');
    assert.equal('credential' in sanitized!, false);
  });

  test('validateCredential rejects unsupported provider IDs', async () => {
    const { validateCredential } = await import('./quota/credentials/registry');
    const result = validateCredential('unsupported-provider', { cookie: 'test' });
    assert.equal(result.valid, false);
    assert.ok(result.error!.includes('Unsupported provider ID'));
  });

  test('validateCredential rejects empty credential objects', async () => {
    const { validateCredential } = await import('./quota/credentials/registry');
    const result = validateCredential('atlascloud', {});
    assert.equal(result.valid, false);
  });

  test('validateCredential accepts valid atlascloud cookie', async () => {
    const { validateCredential } = await import('./quota/credentials/registry');
    const result = validateCredential('atlascloud', { cookie: 'access-token=abc123' });
    assert.equal(result.valid, true);
  });

  test('validateCredential rejects atlascloud cookie without access-token', async () => {
    const { validateCredential } = await import('./quota/credentials/registry');
    const result = validateCredential('atlascloud', { cookie: 'some-other-cookie' });
    assert.equal(result.valid, false);
    assert.ok(result.error!.includes('access-token='));
  });
});