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
});
