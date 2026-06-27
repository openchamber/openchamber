import { describe, expect, test } from 'bun:test';
import { QUOTA_PROVIDERS } from './index';

describe('QUOTA_PROVIDERS metadata coverage', () => {
  test('should have 25 providers', () => {
    expect(QUOTA_PROVIDERS.length).toBe(25);
  });

  test('should have no duplicate IDs', () => {
    const ids = QUOTA_PROVIDERS.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test('should have all providers with headerPinEligible: true', () => {
    for (const provider of QUOTA_PROVIDERS) {
      expect(provider.headerPinEligible).toBe(true);
    }
  });

  test('should have manualCredential providers with schemaKey', () => {
    const manualCredentialProviders = QUOTA_PROVIDERS.filter(
      (p) => p.manualCredential === true
    );

    for (const provider of manualCredentialProviders) {
      expect(provider.schemaKey).toBeTruthy();
      expect(typeof provider.schemaKey).toBe('string');
      expect(provider.schemaKey?.length).toBeGreaterThan(0);
    }
  });

  test('should have correct manualCredential providers', () => {
    const expectedManualProviders = [
      'atlascloud',
      'byteplus',
      'longcat',
      'mistral',
      'poe',
      'qwencloud',
      'stepfun',
      'opencode-go',
      'ollama-cloud',
    ];

    const actualManualProviders = QUOTA_PROVIDERS
      .filter((p) => p.manualCredential === true)
      .map((p) => p.id);

    expect(actualManualProviders.sort()).toEqual(expectedManualProviders.sort());
  });

  test('should have non-manualCredential providers without schemaKey', () => {
    const nonManualProviders = QUOTA_PROVIDERS.filter(
      (p) => p.manualCredential !== true
    );

    for (const provider of nonManualProviders) {
      expect(provider.schemaKey).toBe(undefined);
    }
  });

  test('should not list xai as a manual-credential provider (OAuth-only)', () => {
    const xai = QUOTA_PROVIDERS.find((p) => p.id === 'xai');
    expect(xai).toBeTruthy();
    expect(xai?.manualCredential).not.toBe(true);
    expect(xai?.schemaKey).toBe(undefined);
  });

  test('should have schemaKey matching credential schema keys', () => {
    const schemaProviders = QUOTA_PROVIDERS.filter(
      (p) => p.schemaKey !== undefined
    );

    const expectedSchemaKeys = [
      'atlascloud',
      'byteplus',
      'longcat',
      'mistral',
      'poe',
      'qwencloud',
      'stepfun',
      'opencode-go',
      'ollama-cloud',
    ];

    const actualSchemaKeys = schemaProviders.map((p) => p.schemaKey);
    expect(actualSchemaKeys.sort()).toEqual(expectedSchemaKeys.sort());
  });

  test('should have claude with anthropic alias', () => {
    const claude = QUOTA_PROVIDERS.find((p) => p.id === 'claude');
    expect(claude).toBeTruthy();
    expect(claude?.aliases).toContain('anthropic');
  });

  test('should have all required fields for each provider', () => {
    for (const provider of QUOTA_PROVIDERS) {
      expect(provider.id).toBeTruthy();
      expect(typeof provider.id).toBe('string');
      expect(provider.name).toBeTruthy();
      expect(typeof provider.name).toBe('string');
    }
  });
});
