import { describe, expect, test } from 'bun:test';

import { findAnsweringModelKey, findSessionModelKey, limitsForAnsweringModel } from './contextWindowLimits';

describe('findAnsweringModelKey', () => {
  test('names the newest assistant message with model ids', () => {
    expect(findAnsweringModelKey([
      { role: 'assistant', providerID: 'zai', modelID: 'glm-4' },
      { role: 'user' },
      { role: 'assistant', providerID: 'openai', modelID: 'gpt' },
      { role: 'user' },
    ])).toBe('openai/gpt');
  });

  test('is null before the first answer or when the answer names no model', () => {
    expect(findAnsweringModelKey([{ role: 'user' }])).toBeNull();
    expect(findAnsweringModelKey([{ role: 'assistant' }])).toBeNull();
  });
});

describe('findSessionModelKey', () => {
  test('names the model the session record runs on, null when it has none', () => {
    expect(findSessionModelKey({ model: { providerID: 'openai', id: 'gpt' } })).toBe('openai/gpt');
    expect(findSessionModelKey({})).toBeNull();
    expect(findSessionModelKey(undefined)).toBeNull();
  });
});

describe('limitsForAnsweringModel', () => {
  test('reads the answering model window from the provider list, zero when it is missing', () => {
    const providers = [{ id: 'zai', models: [{ id: 'glm-4', limit: { context: 1_000_000, output: 128_000 } }] }];
    expect(limitsForAnsweringModel('zai/glm-4', providers)).toEqual({ context: 1_000_000, output: 128_000 });
    expect(limitsForAnsweringModel('zai/other', providers)).toEqual({ context: 0, output: 0 });
    expect(limitsForAnsweringModel('other/model', providers)).toEqual({ context: 0, output: 0 });
    expect(limitsForAnsweringModel(null, providers)).toEqual({ context: 0, output: 0 });
  });
});
