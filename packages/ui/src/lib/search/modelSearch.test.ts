import { describe, expect, test } from 'bun:test';

import { matchesModelSearch, normalizeModelSearchValue } from './modelSearch';

describe('normalizeModelSearchValue', () => {
  test('builds lower, compact, and token forms', () => {
    expect(normalizeModelSearchValue('GLM-5.2')).toEqual({
      lower: 'glm-5.2',
      compact: 'glm52',
      tokens: ['glm', '5', '2'],
    });
  });
});

describe('matchesModelSearch', () => {
  test('matches when separators differ between query and model name', () => {
    expect(matchesModelSearch('GLM-5.2', 'GLM 5.2')).toBe(true);
    expect(matchesModelSearch('GLM-5.2', 'glm5.2')).toBe(true);
    expect(matchesModelSearch('GLM-5.2', 'glm-52')).toBe(true);
    expect(matchesModelSearch('DeepSeek V4 Pro', 'deepseek-v4')).toBe(true);
    expect(matchesModelSearch('Claude Sonnet 4.5', 'claude-sonnet-4.5')).toBe(true);
  });

  test('still matches plain substrings and empty query', () => {
    expect(matchesModelSearch('GPT-5.5', 'gpt-5')).toBe(true);
    expect(matchesModelSearch('Gemini 3.5 Flash', '')).toBe(true);
    expect(matchesModelSearch('Gemini 3.5 Flash', '   ')).toBe(true);
  });

  test('does not match unrelated models', () => {
    expect(matchesModelSearch('GLM-5.2', 'gpt 5.5')).toBe(false);
    expect(matchesModelSearch('Kimi K2.7 Code', 'deepseek')).toBe(false);
  });
});
