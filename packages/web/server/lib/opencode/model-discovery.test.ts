import { describe, expect, it } from 'vitest';

import { modelDiscoveryInternals } from './model-discovery.js';

const { normalizeProviderResponse } = modelDiscoveryInternals;

describe('provider model discovery: gateway limit fields', () => {
  it('reads OpenAI-compatible context_length and max_completion_tokens', () => {
    const [model] = normalizeProviderResponse({
      data: [{
        id: 'Ollasurf-vision',
        context_length: 1_000_000,
        max_completion_tokens: 131_072,
      }],
    });

    expect(model?.limit?.context).toBe(1_000_000);
    expect(model?.limit?.output).toBe(131_072);
  });

  it('keeps existing field names working', () => {
    const [model] = normalizeProviderResponse({ data: [{ id: 'm', limit: { context: 200_000, output: 32_000 } }] });
    expect(model?.limit).toEqual({ context: 200_000, output: 32_000 });
  });
});
