import { describe, it, expect } from 'vitest';
import { toClientModelsMetadata } from './models-metadata.js';

const catalog = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    npm: '@ai-sdk/openai',
    doc: 'https://example.test/docs',
    models: {
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5',
        tool_call: true,
        reasoning: true,
        attachment: true,
        temperature: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
        limit: { context: 400000, output: 128000 },
        knowledge: '2024-09',
        release_date: '2025-08-07',
        last_updated: '2025-08-07',
        open_weights: false,
        provider: { npm: '@ai-sdk/openai' },
      },
    },
  },
};

describe('toClientModelsMetadata', () => {
  it('keeps every field the UI reads and drops the rest', () => {
    const projected = toClientModelsMetadata(catalog);
    expect(projected).toEqual({
      openai: {
        id: 'openai',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            tool_call: true,
            reasoning: true,
            attachment: true,
            temperature: false,
            modalities: { input: ['text', 'image'], output: ['text'] },
            cost: { input: 1.25, output: 10, cache_read: 0.125 },
            limit: { context: 400000, output: 128000 },
            knowledge: '2024-09',
            release_date: '2025-08-07',
            last_updated: '2025-08-07',
          },
        },
      },
    });
  });

  it('skips malformed providers and models instead of failing the route', () => {
    expect(toClientModelsMetadata({ broken: 'x', empty: { id: 'empty' }, odd: { models: { bad: 3 } } })).toEqual({
      odd: { models: {} },
    });
    expect(toClientModelsMetadata(null)).toEqual({});
  });

  it('projects one catalog object once', () => {
    expect(toClientModelsMetadata(catalog)).toBe(toClientModelsMetadata(catalog));
  });
});
