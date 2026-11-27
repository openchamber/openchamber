import { describe, expect, test } from 'bun:test';

import {
  findAnsweringModelKey,
  findSessionModelKey,
  limitsForAnsweringModel,
  resolveContextLimits,
} from './contextWindowLimits';

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

  test('keys on the context fill message when present', () => {
    expect(findAnsweringModelKey([
      {
        role: 'assistant',
        providerID: 'github-copilot',
        modelID: 'claude-3-5-sonnet',
        tokens: { total: 146_000 },
      },
      { role: 'user' },
      { role: 'assistant', providerID: 'github-copilot', modelID: 'gpt-4o' },
    ])).toBe('github-copilot/claude-3-5-sonnet');
  });

  test('falls back to newest assistant message when fill message names no model', () => {
    expect(findAnsweringModelKey([
      {
        role: 'assistant',
        tokens: { total: 100 },
      },
      { role: 'assistant', providerID: 'openai', modelID: 'gpt-4o' },
    ])).toBe('openai/gpt-4o');
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

describe('resolveContextLimits', () => {
  const providers = [
    {
      id: 'github-copilot',
      models: [
        { id: 'auto', limit: { context: 128_000, output: 4_096 } },
        { id: 'claude-3-5-sonnet', limit: { context: 1_000_000, output: 8_192 } },
      ],
    },
  ];

  test('prefers answering model limits over session routing alias', () => {
    const limits = resolveContextLimits({
      answeringModelKey: 'github-copilot/claude-3-5-sonnet',
      sessionModelKey: 'github-copilot/auto',
      fallbackLimit: { context: 200_000, output: 4_000 },
      providers,
    });
    expect(limits).toEqual({ context: 1_000_000, output: 8_192 });
  });

  test('falls back to session model limits when answering model is absent or has no limit', () => {
    const limits = resolveContextLimits({
      answeringModelKey: null,
      sessionModelKey: 'github-copilot/auto',
      fallbackLimit: { context: 200_000, output: 4_000 },
      providers,
    });
    expect(limits).toEqual({ context: 128_000, output: 4_096 });
  });

  test('falls back to fallbackLimit when neither answering nor session model has a limit', () => {
    const limits = resolveContextLimits({
      answeringModelKey: null,
      sessionModelKey: 'unknown/model',
      fallbackLimit: { context: 200_000, output: 4_000 },
      providers,
    });
    expect(limits).toEqual({ context: 200_000, output: 4_000 });
  });

  test('returns zero limits when no limits are found', () => {
    const limits = resolveContextLimits({
      answeringModelKey: null,
      sessionModelKey: null,
      providers: [],
    });
    expect(limits).toEqual({ context: 0, output: 0 });
  });
});
