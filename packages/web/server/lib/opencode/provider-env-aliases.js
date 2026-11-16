
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
