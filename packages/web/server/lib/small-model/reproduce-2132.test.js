/**
 * Reproduction for issue #2132: OpenCode zen/free models not in small models list.
 *
 * The bug has three facets:
 *   1. listAuthenticatedProviders() never includes "opencode" (zen/free models)
 *      because it has no traditional auth entry.
 *   2. The resolver's family-priority scan skips providers without a usable
 *      auth entry, so free models are never resolved as a fallback.
 *   3. The UI picker in DefaultsSettings.tsx filters by authenticatedProviders,
 *      so the user can never select opencode/big-pickle as an override.
 *
 * The settings override path (source: 'settings') in resolveSmallModel DOES
 * accept any provider/model without checking auth. This means if the user
 * COULD select opencode/big-pickle through the picker, the resolver would
 * honor it — but the picker prevents selection.
 */
import { describe, it, expect } from 'bun:test';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry } from './resolve.js';
import { listAuthenticatedProviders } from './index.js';

// Minimal catalog with the providers the opencode / free provider is NOT
// in the catalog — just like in production, the free models (big-pickle etc.)
// are served by the OpenCode server, not by models.dev.
const catalog = {
  google: {
    id: 'google',
    models: {
      'gemini-2.5-flash': { id: 'gemini-2.5-flash', family: 'gemini-flash', release_date: '2025-06-01' },
    },
  },
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-haiku-4-5': { id: 'claude-haiku-4-5', family: 'claude-haiku', release_date: '2025-10-01' },
    },
  },
};

describe('Bug #2132: OpenCode free/zen models not in small model list', () => {
  // -------------------------------------------------------------------------
  // Facet 1: listAuthenticatedProviders() excludes free models
  // -------------------------------------------------------------------------
  it('listAuthenticatedProviders() excludes "opencode" (free/zen provider)', () => {
    // The free/zen provider ("opencode") has no auth entry — it doesn't need
    // a token or API key. listAuthenticatedProviders() only returns providers
    // with a usable auth entry, so "opencode" is never included.
    const authed = listAuthenticatedProviders();
    expect(authed.includes('opencode')).toBe(false);
    // On a vanilla setup without any API keys, it returns an empty array.
    // The "opencode" provider's free models (big-pickle, etc.) are never
    // presented as selectable in the small model picker.
  });

  it('listAuthenticatedProviders() returns only providers in auth.json with usable credentials', () => {
    // This is by design: the function is named "authenticated" and only
    // returns providers the server can call directly. The "opencode" provider
    // works through the OpenCode server, not via direct API calls.
    //
    // But the UI uses this same list to FILTER the model picker, so free
    // models from the "opencode" provider are hidden even though the user
    // might want to select them as a settings override (which the resolver
    // WOULD honor — see facet 3 below).
  });

  // -------------------------------------------------------------------------
  // Facet 2: The family-priority scan skips free providers
  // -------------------------------------------------------------------------
  it('resolveSmallModel with no auth returns null even with opencode preference', () => {
    // A vanilla setup with no API keys, where the only available provider is
    // "opencode" (free built-in models). The resolver returns null because
    // it skips providers without usable auth entries.
    const result = resolveSmallModel({
      auth: {},
      catalog,
      configSmallModel: null,
      preferredProviderID: 'opencode',
      preferredModelID: 'big-pickle',
    });
    expect(result).toBeNull();
    // The test data at resolve.test.js:155-163 confirms this behavior:
    // "resolves nothing on a vanilla setup with no logins at all"
  });

  // -------------------------------------------------------------------------
  // Facet 3: The settings override path DOES accept free models
  // -------------------------------------------------------------------------
  it('resolveSmallModel settings override honors opencode/big-pickle (no auth needed)', () => {
    // The settings override path (source: 'settings') at the TOP of
    // resolveSmallModel does NOT check auth. It just parses the model ref
    // and returns it. This means if the user COULD select opencode/big-pickle
    // through the picker, the resolver WOULD honor it.
    const result = resolveSmallModel({
      auth: {},
      catalog,
      settingsSmallModel: 'opencode/big-pickle',
      configSmallModel: null,
    });
    expect(result).not.toBeNull();
    expect(result).toEqual({
      providerID: 'opencode',
      modelID: 'big-pickle',
      source: 'settings',
    });
  });

  // -------------------------------------------------------------------------
  // The disconnect: picker prevents selection but resolver would honor it
  // -------------------------------------------------------------------------
  it('DEMONSTRATES the bug: UI prevents selection but resolver would honor it', () => {
    // The UI in DefaultsSettings.tsx fetches GET /api/small-model which
    // returns { authenticatedProviders: listAuthenticatedProviders() }.
    // This list excludes "opencode". The ModelSelector is rendered with
    // allowedProviderIds=[...authenticatedProviders], which hides "opencode"
    // and all its models from the picker.
    //
    // However, if the user could somehow set opencode/big-pickle as the
    // smallModelOverride (e.g., by manually editing settings.json), the
    // resolver WOULD accept it:
    const result = resolveSmallModel({
      auth: {},
      catalog,
      settingsSmallModel: 'opencode/big-pickle',
      configSmallModel: null,
    });
    expect(result?.providerID).toBe('opencode');
    expect(result?.modelID).toBe('big-pickle');
    expect(result?.source).toBe('settings');

    // But listAuthenticatedProviders() never includes 'opencode':
    const authed = listAuthenticatedProviders();
    expect(authed.includes('opencode')).toBe(false);

    // So the picker hides it. The user cannot select a free model as the
    // small model override even though the resolver would honor it.
    //
    // Potential fix directions:
    //   (a) Include providers that don't need auth in authenticatedProviders
    //       or a separate "availableProviders" field
    //   (b) Document that the "opencode" provider's models can be selected
    //       as an override but won't be called directly by the small-model path
  });

  // -------------------------------------------------------------------------
  // Illustrates that the resolver's "family-scan" by default (no settings/config)
  // on a vanilla setup returns nothing usable
  // -------------------------------------------------------------------------
  it('on a vanilla setup the family-scan finds nothing and returns null', () => {
    const result = resolveSmallModel({
      auth: {},
      catalog,
      settingsSmallModel: null,
      configSmallModel: null,
    });
    expect(result).toBeNull();
    // This is the explicit test case from resolve.test.js:114-116.
    // The "opencode" provider is never scanned because isUsableAuthEntry
    // returns false for an empty/non-existent auth entry.
  });

  // -------------------------------------------------------------------------
  // Even when other providers are authenticated, free models never appear
  // as candidates in the family scan
  // -------------------------------------------------------------------------
  it('free/zen models are never scanned in family priority — they have no catalog entry', () => {
    // The family-scan iterates over authenticated providers and looks for
    // catalog models with matching families (gemini-flash, gpt-nano, claude-haiku).
    // The "opencode" provider doesn't even have a catalog entry in models.dev,
    // so it has no models with these families. The only way to select a free
    // model is through the settings override path — which the picker prevents.
    const result = resolveSmallModel({
      auth: {
        google: { type: 'api', key: 'g-key' },
      },
      catalog,
      settingsSmallModel: null,
      configSmallModel: null,
    });
    // Resolves to something from google (authenticated, in catalog)
    expect(result).not.toBeNull();
    expect(result?.providerID).toBe('google');
  });
});
