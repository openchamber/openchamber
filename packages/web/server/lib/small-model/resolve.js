import { getCatalogProvider } from './catalog.js';

// Mirrors OpenCode's getSmallModel fallback chain:
// 1. `small_model` from the merged config layers ("provider/model").
// 2. GitHub Copilot's hidden utility models when Copilot is logged in.
// 3. Family-priority scan of the authenticated providers' catalog models.
const FAMILY_PRIORITY = ['gemini-flash', 'gpt-nano', 'claude-haiku'];
const COPILOT_UTILITY_MODELS = ['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
// The ChatGPT-plan codex backend only accepts a small allowlist of models
// (nano/API-key models are rejected with 400) — this is its cheapest one.
const OPENAI_OAUTH_SMALL_MODEL = 'gpt-5.4-mini';

const AUTH_PROVIDER_ALIASES = {
  'github-copilot': ['github-copilot', 'copilot'],
};

export function getAuthEntryForProvider(auth, providerID) {
  const aliases = AUTH_PROVIDER_ALIASES[providerID] || [providerID];
  for (const alias of aliases) {
    const entry = auth?.[alias];
    if (entry && typeof entry === 'object') {
      return entry;
    }
  }
  return null;
}

export function isUsableAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'api') return typeof entry.key === 'string' && entry.key.length > 0;
  if (entry.type === 'oauth') {
    return (typeof entry.access === 'string' && entry.access.length > 0)
      || (typeof entry.refresh === 'string' && entry.refresh.length > 0);
  }
  if (entry.type === 'wellknown') return typeof entry.token === 'string' && entry.token.length > 0;
  return false;
}

export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

const pickByFamily = (models, family) => {
  const matches = Object.values(models)
    .filter((model) => model && typeof model === 'object' && model.family === family);
  if (matches.length === 0) return null;
  matches.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
  return matches[0];
};

// Small-model candidates within ONE provider, by family priority. Copilot and
// ChatGPT-plan OpenAI have fixed small models that never appear in the
// catalog; everyone else is scanned through the catalog families.
const pickWithinProvider = (providerID, auth, catalog, family) => {
  if (providerID === 'openai' && auth.openai?.type === 'oauth') {
    return family === 'gpt-nano'
      ? { providerID, modelID: OPENAI_OAUTH_SMALL_MODEL, source: 'codex-small' }
      : null;
  }
  if (providerID === 'github-copilot') {
    return family === 'gpt-nano'
      ? { providerID, modelID: COPILOT_UTILITY_MODELS[0], source: 'copilot-utility' }
      : null;
  }
  const provider = getCatalogProvider(catalog, providerID);
  if (!provider || !provider.models || typeof provider.models !== 'object') return null;
  const model = pickByFamily(provider.models, family);
  return model?.id ? { providerID, modelID: model.id, source: 'family-scan' } : null;
};

export function resolveSmallModel({ auth, catalog, settingsSmallModel, configSmallModel, preferredProviderID, preferredModelID, configCredentialProviders }) {
  // Providers with a resolvable config `options.apiKey` are callable without
  // an auth.json login, so they count as authenticated here.
  const configProviders = Array.isArray(configCredentialProviders) ? configCredentialProviders : [];
  const hasUsableCredential = (providerID) =>
    isUsableAuthEntry(getAuthEntryForProvider(auth, providerID)) || configProviders.includes(providerID);

  // OpenChamber's own setting (Settings → Sessions → Small Model override)
  // outranks everything, including the OpenCode config.
  const fromSettings = parseModelRef(settingsSmallModel);
  if (fromSettings) {
    return { ...fromSettings, source: 'settings' };
  }

  const explicit = parseModelRef(configSmallModel);
  if (explicit) {
    return { ...explicit, source: 'config' };
  }

  // Like OpenCode: when the caller has a session context, the utility call
  // stays on the session's provider. Scan its families for a small model,
  // otherwise run on the session's own model — never silently switch to a
  // different provider's subscription.
  const preferred = typeof preferredProviderID === 'string' && preferredProviderID
    ? preferredProviderID
    : null;
  if (preferred && hasUsableCredential(preferred)) {
    for (const family of FAMILY_PRIORITY) {
      const match = pickWithinProvider(preferred, auth, catalog, family);
      if (match) return match;
    }
    if (typeof preferredModelID === 'string' && preferredModelID) {
      return { providerID: preferred, modelID: preferredModelID, source: 'session-model' };
    }
  }

  // No session context (or its provider has no usable credential): scan all
  // authenticated providers by family priority.
  const authedProviders = [...new Set([
    ...Object.keys(auth || {}).filter((providerID) => isUsableAuthEntry(auth[providerID])),
    ...configProviders,
  ])].filter((providerID) => providerID !== preferred);

  for (const family of FAMILY_PRIORITY) {
    for (const providerID of authedProviders) {
      const match = pickWithinProvider(providerID, auth, catalog, family);
      if (match) return match;
    }
  }

  // Copilot's utility fallback for legacy auth aliases the loop above missed.
  const copilotEntry = getAuthEntryForProvider(auth, 'github-copilot');
  if (isUsableAuthEntry(copilotEntry)) {
    return {
      providerID: 'github-copilot',
      modelID: COPILOT_UTILITY_MODELS[0],
      source: 'copilot-utility',
    };
  }

  return null;
}
