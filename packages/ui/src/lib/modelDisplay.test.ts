import { describe, expect, test } from 'bun:test';

import {
  getModelDisplayName,
  getProviderModelDisplayName,
  humanizeModelId,
  sortModelsByDisplayName,
} from './modelDisplay';

describe('modelDisplay', () => {
  test('prefers model name over ids', () => {
    expect(getModelDisplayName({ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' })).toBe('Claude Sonnet 4.5');
  });

  test('falls back to a human-readable model id when name is missing', () => {
    expect(getModelDisplayName({ id: 'claude-sonnet-4-5' })).toBe('Claude Sonnet 4.5');
  });

  test('falls back to a human-readable explicit model id when provider data is unavailable', () => {
    expect(getProviderModelDisplayName(undefined, 'claude-sonnet-4-5')).toBe('Claude Sonnet 4.5');
  });

  test('uses fallback label only when no model id is available', () => {
    expect(getProviderModelDisplayName(undefined, undefined, { fallbackLabel: 'Select model' })).toBe('Select model');
  });

  test('supports provider model records and truncation', () => {
    const provider = {
      models: {
        'very-long-model-id': { id: 'very-long-model-id', name: 'Very Long Model Name' },
      },
    };

    expect(getProviderModelDisplayName(provider, 'very-long-model-id', { maxLength: 9 })).toBe('Very L...');
  });

  test('humanizes provider-prefixed model ids using common model catalog patterns', () => {
    expect(humanizeModelId('anthropic/claude-opus-4-7-fast')).toBe('Claude Opus 4.7 Fast');
    expect(humanizeModelId('google/gemini-3.1-flash-lite-preview')).toBe('Gemini 3.1 Flash Lite Preview');
    expect(humanizeModelId('meta-llama/llama-3.2-3b-instruct:free')).toBe('Llama 3.2 3B Instruct (free)');
    expect(humanizeModelId('openai/gpt-4o-mini-2024-07-18')).toBe('GPT-4o Mini (2024-07-18)');
    expect(humanizeModelId('openai/gpt-5.4-mini-fast')).toBe('GPT-5.4 Mini Fast');
    expect(humanizeModelId('qwen/qwen3-coder:free')).toBe('Qwen3 Coder (free)');
    expect(humanizeModelId('xai/grok-4-1-fast-non-reasoning')).toBe('Grok 4.1 Fast (Non-Reasoning)');
    expect(humanizeModelId('z-ai/glm-4.5-air')).toBe('GLM-4.5 Air');
  });

  test('humanizes alias and custom model ids without provider data', () => {
    expect(humanizeModelId('~openai/gpt-mini-latest')).toBe('GPT Mini Latest');
    expect(humanizeModelId('my-custom_provider/myAwesomeModel-v2-fast')).toBe('My Awesome Model V2 Fast');
  });

  test('sorts models alphabetically by display name without mutating the input', () => {
    const models = [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
    ];
    const sorted = sortModelsByDisplayName(models);

    expect(sorted.map((model) => model.id)).toEqual(['claude-sonnet-4-5', 'gemini-3-pro', 'gpt-4o']);
    expect(models.map((model) => model.id)).toEqual(['gpt-4o', 'claude-sonnet-4-5', 'gemini-3-pro']);
  });

  test('sorts case-insensitively and falls back to the humanized id when name is missing', () => {
    const sorted = sortModelsByDisplayName([
      { id: 'provider/zebra-model' },
      { id: 'provider/beta', name: 'beta' },
      { id: 'provider/alpha', name: 'Alpha' },
    ]);

    expect(sorted.map((model) => model.id)).toEqual([
      'provider/alpha',
      'provider/beta',
      'provider/zebra-model',
    ]);
  });

  test('orders numeric segments naturally and breaks display-name ties by id', () => {
    const sorted = sortModelsByDisplayName([
      { id: 'model-10', name: 'Model 10' },
      { id: 'model-2', name: 'Model 2' },
      { id: 'b-same', name: 'Same' },
      { id: 'a-same', name: 'Same' },
    ]);

    expect(sorted.map((model) => model.id)).toEqual(['model-2', 'model-10', 'a-same', 'b-same']);
  });
});
