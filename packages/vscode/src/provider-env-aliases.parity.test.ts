import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyProviderEnvAliases as fromVscode } from './provider-env-aliases';
import { applyProviderEnvAliases as fromWeb } from '../../web/server/lib/opencode/provider-env-aliases.js';

describe('provider env alias parity (vscode ↔ web)', () => {
  test('mirrors GEMINI_API_KEY onto Google Generative AI env names', () => {
    const input = {
      GEMINI_API_KEY: 'AIza-demo',
      PATH: '/usr/bin',
    };
    assert.deepEqual(fromVscode(input), fromWeb(input));
    assert.deepEqual(fromVscode(input), {
      GEMINI_API_KEY: 'AIza-demo',
      GOOGLE_API_KEY: 'AIza-demo',
      GOOGLE_GENERATIVE_AI_API_KEY: 'AIza-demo',
      PATH: '/usr/bin',
    });
  });

  test('does not overwrite an already-set preferred Google key', () => {
    const input = {
      GEMINI_API_KEY: 'from-gemini',
      GOOGLE_GENERATIVE_AI_API_KEY: 'from-google',
    };
    assert.deepEqual(fromVscode(input), fromWeb(input));
  });

  test('returns empty object for invalid input', () => {
    assert.deepEqual(fromVscode(null as unknown as NodeJS.ProcessEnv), fromWeb(null));
    assert.deepEqual(fromVscode(undefined as unknown as NodeJS.ProcessEnv), fromWeb(undefined));
  });
});
