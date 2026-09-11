import { describe, expect, test } from 'bun:test';

import { applyProviderEnvAliases } from './provider-env-aliases.js';

describe('applyProviderEnvAliases', () => {
  test('mirrors GEMINI_API_KEY onto Google Generative AI env names', () => {
    expect(applyProviderEnvAliases({
      GEMINI_API_KEY: 'AIza-demo',
      PATH: '/usr/bin',
    })).toEqual({
      GEMINI_API_KEY: 'AIza-demo',
      GOOGLE_API_KEY: 'AIza-demo',
      GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-demo',
      PATH: '/usr/bin',
    });
  });

  test('does not overwrite an already-set preferred Google key', () => {
    expect(applyProviderEnvAliases({
      GEMINI_API_KEY: 'from-gemini',
      GOOGLE_GENERATIVE_AI_API_KEY: 'from-google',
    })).toEqual({
      GEMINI_API_KEY: 'from-gemini',
      GOOGLE_API_KEY: 'from-google',
      GOOGLE_GENERATIVE_AI_API_KEY: 'from-google',
    });
  });

  test('returns empty object for invalid input', () => {
    expect(applyProviderEnvAliases(null)).toEqual({});
    expect(applyProviderEnvAliases(undefined)).toEqual({});
  });
});
