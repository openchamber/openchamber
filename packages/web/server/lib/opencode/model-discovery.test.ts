import { describe, expect, it } from 'vitest';

import { modelDiscoveryInternals } from './model-discovery.js';

const normalize = modelDiscoveryInternals.normalizeProviderResponse as (payload: unknown) => Array<{ id: string; limit?: { context?: number; output?: number } }>;

describe('provider model discovery: gateway limit fields', () => {
  it('reads OpenAI-compatible context_length and max_completion_tokens', () => {
    const models = normalize({
      data: [{
        id: 'Ollasurf-vision',
        context_length: 1_000_000,
        max_completion_tokens: 131_072,
      }],
    });

    expect(models[0].limit?.context).toBe(1_000_000);
    expect(models[0].limit?.output).toBe(131_072);
  });

  it('keeps existing field names working', () => {
    const models = normalize({ data: [{ id: 'm', limit: { context: 200_000, output: 32_000 } }] });
    expect(models[0].limit).toEqual({ context: 200_000, output: 32_000 });
  });
});
