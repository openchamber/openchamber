import { describe, it, expect } from 'bun:test';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry } from './resolve.js';

const catalog = {
  google: {
    id: 'google',
    models: {
      'gemini-2.5-flash': { id: 'gemini-2.5-flash', family: 'gemini-flash', release_date: '2025-06-01' },
      'gemini-2.0-flash': { id: 'gemini-2.0-flash', family: 'gemini-flash', release_date: '2024-12-01' },
      'gemini-2.5-pro': { id: 'gemini-2.5-pro', family: 'gemini-pro', release_date: '2025-06-01' },
    },
  },
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-haiku-4-5': { id: 'claude-haiku-4-5', family: 'claude-haiku', release_date: '2025-10-01' },
      'claude-sonnet-4-5': { id: 'claude-sonnet-4-5', family: 'claude-sonnet', release_date: '2025-09-01' },
    },
  },
};

describe('parseModelRef', () => {
  it('splits provider/model on the first slash', () => {
    expect(parseModelRef('anthropic/claude-haiku-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    });
  });

  it('keeps slashes inside the model id', () => {
    expect(parseModelRef('openrouter/google/gemini-2.5-flash')).toEqual({
      providerID: 'openrouter',
      modelID: 'google/gemini-2.5-flash',
    });
  });

  it('rejects values without a provider or model part', () => {
    expect(parseModelRef('anthropic/')).toBeNull();
    expect(parseModelRef('/model')).toBeNull();
    expect(parseModelRef('plain')).toBeNull();
    expect(parseModelRef(undefined)).toBeNull();
  });
});

describe('isUsableAuthEntry', () => {
  it('accepts api keys, oauth tokens, and wellknown tokens', () => {
    expect(isUsableAuthEntry({ type: 'api', key: 'sk-x' })).toBe(true);
    expect(isUsableAuthEntry({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 })).toBe(true);
    expect(isUsableAuthEntry({ type: 'wellknown', key: 'k', token: 't' })).toBe(true);
  });

  it('rejects empty or malformed entries', () => {
    expect(isUsableAuthEntry({ type: 'api', key: '' })).toBe(false);
    expect(isUsableAuthEntry({ type: 'oauth' })).toBe(false);
    expect(isUsableAuthEntry(null)).toBe(false);
  });
});

describe('resolveSmallModel', () => {
  it('gives the OpenChamber settings override top priority', () => {
    const result = resolveSmallModel({
      auth: { anthropic: { type: 'api', key: 'sk-x' } },
      catalog,
      settingsSmallModel: 'anthropic/claude-haiku-4-5',
      configSmallModel: 'openai/gpt-4o-mini',
      preferredProviderID: 'anthropic',
    });
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'settings' });
  });

  it('prefers the configured small_model', () => {
    const result = resolveSmallModel({
      auth: { anthropic: { type: 'api', key: 'sk-x' } },
      catalog,
      configSmallModel: 'openai/gpt-4o-mini',
    });
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o-mini', source: 'config' });
  });

  it('scans authenticated providers by family priority, newest first', () => {
    const result = resolveSmallModel({
      auth: {
        google: { type: 'api', key: 'g-key' },
        anthropic: { type: 'api', key: 'sk-x' },
      },
      catalog,
      configSmallModel: null,
    });
    expect(result).toEqual({ providerID: 'google', modelID: 'gemini-2.5-flash', source: 'family-scan' });
  });

  it('skips providers without a usable credential', () => {
    const result = resolveSmallModel({
      auth: {
        google: { type: 'api', key: '' },
        anthropic: { type: 'api', key: 'sk-x' },
      },
      catalog,
      configSmallModel: null,
    });
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'family-scan' });
  });

  it('falls back to Copilot utility models when only Copilot is logged in', () => {
    const result = resolveSmallModel({
      auth: { 'github-copilot': { type: 'oauth', access: 't', refresh: 't', expires: 0 } },
      catalog,
      configSmallModel: null,
    });
    expect(result?.providerID).toBe('github-copilot');
    expect(result?.source).toBe('copilot-utility');
  });

  it('returns null when nothing is authenticated', () => {
    expect(resolveSmallModel({ auth: {}, catalog, configSmallModel: null })).toBeNull();
  });

  it('prefers the session provider over other authenticated providers', () => {
    const result = resolveSmallModel({
      auth: {
        google: { type: 'api', key: 'g-key' },
        anthropic: { type: 'api', key: 'sk-x' },
      },
      catalog,
      configSmallModel: null,
      preferredProviderID: 'anthropic',
    });
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'family-scan' });
  });

  it('ignores a preferred provider without a usable login', () => {
    const result = resolveSmallModel({
      auth: { google: { type: 'api', key: 'g-key' } },
      catalog,
      configSmallModel: null,
      preferredProviderID: 'anthropic',
    });
    expect(result).toEqual({ providerID: 'google', modelID: 'gemini-2.5-flash', source: 'family-scan' });
  });

  it('never uses a session provider without a login (opencode free models)', () => {
    // Vanilla setups default the picker to opencode/big-pickle with no
    // opencode token — those free models only work through OpenCode itself
    // and must never be called directly, so the session context is ignored.
    const result = resolveSmallModel({
      auth: { openai: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60_000 } },
      catalog,
      configSmallModel: null,
      preferredProviderID: 'opencode',
      preferredModelID: 'big-pickle',
    });
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5.4-mini', source: 'codex-small' });
  });

  it('resolves nothing on a vanilla setup with no logins at all', () => {
    const result = resolveSmallModel({
      auth: {},
      catalog,
      configSmallModel: null,
      preferredProviderID: 'opencode',
      preferredModelID: 'big-pickle',
    });
    expect(result).toBeNull();
  });

  it('falls back to the session model instead of scanning other providers', () => {
    const result = resolveSmallModel({
      auth: {
        'opencode-go': { type: 'api', key: 'oc-key' },
        openai: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 60_000 },
      },
      catalog: {
        'opencode-go': {
          id: 'opencode-go',
          models: {
            'deepseek-v4-flash': { id: 'deepseek-v4-flash', family: 'deepseek-flash', release_date: '2026-01-01' },
          },
        },
      },
      configSmallModel: null,
      preferredProviderID: 'opencode-go',
      preferredModelID: 'deepseek-v4-flash',
    });
    expect(result).toEqual({ providerID: 'opencode-go', modelID: 'deepseek-v4-flash', source: 'session-model' });
  });

  it('falls back to the session model itself when nothing resolves', () => {
    const result = resolveSmallModel({
      auth: { mistral: { type: 'api', key: 'm-key' } },
      catalog,
      configSmallModel: null,
      preferredProviderID: 'mistral',
      preferredModelID: 'mistral-large-latest',
    });
    expect(result).toEqual({ providerID: 'mistral', modelID: 'mistral-large-latest', source: 'session-model' });
  });

  // Config-only providers (#2269): no auth.json entry, still callable.
  it('treats a session provider with a config-supplied credential as usable', () => {
    const result = resolveSmallModel({
      auth: {},
      catalog,
      configSmallModel: null,
      preferredProviderID: 'my-custom',
      preferredModelID: 'audit-model',
      configCredentialProviders: ['my-custom'],
    });
    expect(result).toEqual({ providerID: 'my-custom', modelID: 'audit-model', source: 'session-model' });
  });

  it('family-scans a preferred catalog provider whose credential comes from config', () => {
    const result = resolveSmallModel({
      auth: {},
      catalog,
      configSmallModel: null,
      preferredProviderID: 'anthropic',
      configCredentialProviders: ['anthropic'],
    });
    expect(result).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'family-scan' });
  });

  it('includes config-credential providers in the global scan', () => {
    const result = resolveSmallModel({
      auth: {},
      catalog,
      configSmallModel: null,
      configCredentialProviders: ['google'],
    });
    expect(result).toEqual({ providerID: 'google', modelID: 'gemini-2.5-flash', source: 'family-scan' });
  });

  it('still ignores a preferred provider with neither a login nor a config credential', () => {
    const result = resolveSmallModel({
      auth: {},
      catalog,
      configSmallModel: null,
      preferredProviderID: 'my-custom',
      preferredModelID: 'audit-model',
      configCredentialProviders: [],
    });
    expect(result).toBeNull();
  });
});
