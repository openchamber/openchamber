/**
 * Normalize provider credential env aliases for managed OpenCode.
 *
 * OpenCode may mark a provider as connected when any listed env key is present
 * (e.g. GEMINI_API_KEY), while the upstream AI SDK only reads a different name
 * (GOOGLE_GENERATIVE_AI_API_KEY). Mirror known aliases so chat works without
 * forcing the user to paste the same key again in Settings.
 */

const GOOGLE_API_KEY_ALIASES = [
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
];

export function applyProviderEnvAliases(env) {
  if (!env || typeof env !== 'object') {
    return {};
  }

  const next = { ...env };
  const googleValue = GOOGLE_API_KEY_ALIASES
    .map((key) => next[key])
    .find((value) => typeof value === 'string' && value.trim().length > 0);

  if (googleValue) {
    for (const key of GOOGLE_API_KEY_ALIASES) {
      if (typeof next[key] !== 'string' || next[key].trim().length === 0) {
        next[key] = googleValue;
      }
    }
  }

  return next;
}
