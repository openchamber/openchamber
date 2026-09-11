// Allowed-model whitelist and per-user concurrency configuration
// (plan sections 11.1 and 11.2): env parsing, fail-closed empty state,
// malformed-entry rejection, concurrency limit resolution.

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_MODELS_ENV,
  DEFAULT_MODEL_MAX_CONCURRENT_PER_USER,
  isModelAllowed,
  resolveAllowedModels,
  resolveModelConcurrencyLimit,
} from './runtime-config.js';

describe('resolveAllowedModels', () => {
  it('returns no allowed models when the env var is unset (fail-closed)', () => {
    expect(resolveAllowedModels({})).toEqual([]);
  });

  it('returns no allowed models for an empty value', () => {
    expect(resolveAllowedModels({ [ALLOWED_MODELS_ENV]: '' })).toEqual([]);
    expect(resolveAllowedModels({ [ALLOWED_MODELS_ENV]: '   ' })).toEqual([]);
  });

  it('parses id:providerID entries', () => {
    const models = resolveAllowedModels({
      [ALLOWED_MODELS_ENV]: 'gpt-4o:openai, claude-sonnet:anthropic',
    });
    expect(models).toEqual([
      { id: 'gpt-4o', provider: 'openai' },
      { id: 'claude-sonnet', provider: 'anthropic' },
    ]);
  });

  it('skips blank entries between commas', () => {
    const models = resolveAllowedModels({ [ALLOWED_MODELS_ENV]: 'm1:p1,, ,m2:p2' });
    expect(models.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('rejects malformed entries instead of silently narrowing or widening', () => {
    expect(() => resolveAllowedModels({ [ALLOWED_MODELS_ENV]: 'no-provider' }))
      .toThrow(/invalid OPENCHAMBER_PLATFORM_ALLOWED_MODELS entry/);
    expect(() => resolveAllowedModels({ [ALLOWED_MODELS_ENV]: ':openai' }))
      .toThrow(/invalid OPENCHAMBER_PLATFORM_ALLOWED_MODELS entry/);
    expect(() => resolveAllowedModels({ [ALLOWED_MODELS_ENV]: 'gpt-4o:' }))
      .toThrow(/invalid OPENCHAMBER_PLATFORM_ALLOWED_MODELS entry/);
  });

  it('rejects duplicate model ids', () => {
    expect(() => resolveAllowedModels({ [ALLOWED_MODELS_ENV]: 'm:p1,m:p2' }))
      .toThrow(/duplicate model id/);
  });

  it('freezes the result so callers cannot widen the whitelist at runtime', () => {
    const models = resolveAllowedModels({ [ALLOWED_MODELS_ENV]: 'm:p' });
    expect(Object.isFrozen(models)).toBe(true);
    expect(Object.isFrozen(models[0])).toBe(true);
  });
});

describe('isModelAllowed', () => {
  const models = resolveAllowedModels({ [ALLOWED_MODELS_ENV]: 'gpt-4o:openai' });

  it('matches exact model ids only', () => {
    expect(isModelAllowed(models, 'gpt-4o')).toBe(true);
    expect(isModelAllowed(models, 'GPT-4O')).toBe(false);
    expect(isModelAllowed(models, 'gpt-4o-mini')).toBe(false);
  });

  it('allows nothing on an empty whitelist', () => {
    expect(isModelAllowed([], 'gpt-4o')).toBe(false);
  });

  it('rejects empty and non-string model ids', () => {
    expect(isModelAllowed(models, '')).toBe(false);
    expect(isModelAllowed(models, undefined)).toBe(false);
  });
});

describe('resolveModelConcurrencyLimit', () => {
  it('defaults to 2 (plan section 11.2 example)', () => {
    expect(resolveModelConcurrencyLimit({})).toBe(DEFAULT_MODEL_MAX_CONCURRENT_PER_USER);
    expect(DEFAULT_MODEL_MAX_CONCURRENT_PER_USER).toBe(2);
  });

  it('honours a valid override', () => {
    expect(resolveModelConcurrencyLimit({ OPENCHAMBER_PLATFORM_MODEL_MAX_CONCURRENT_PER_USER: '5' })).toBe(5);
  });

  it('rejects invalid values', () => {
    for (const bad of ['0', '-1', '2.5', 'abc']) {
      expect(
        () => resolveModelConcurrencyLimit({ OPENCHAMBER_PLATFORM_MODEL_MAX_CONCURRENT_PER_USER: bad }),
      ).toThrow(/must be a positive integer/);
    }
  });

  it('treats an empty value as unset', () => {
    expect(resolveModelConcurrencyLimit({ OPENCHAMBER_PLATFORM_MODEL_MAX_CONCURRENT_PER_USER: '' })).toBe(2);
  });
});
