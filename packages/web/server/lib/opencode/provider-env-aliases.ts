import { isString } from '../shared/object-guards.js';

const isObjectContainer = (value: unknown): value is object => value !== null && typeof value === 'object';
const GOOGLE_API_KEY_ALIASES = [
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
];

export function applyProviderEnvAliases(env: NodeJS.ProcessEnv | null | undefined): NodeJS.ProcessEnv {
  if (!isObjectContainer(env)) {
    return {};
  }

  const next = { ...env };
  const googleValue = GOOGLE_API_KEY_ALIASES
    .map((key) => next[key])
    .find((value) => isString(value) && value.trim().length > 0);

  if (googleValue) {
    for (const key of GOOGLE_API_KEY_ALIASES) {
      if (!isString(next[key]) || next[key].trim().length === 0) {
        next[key] = googleValue;
      }
    }
  }

  return next;
}
