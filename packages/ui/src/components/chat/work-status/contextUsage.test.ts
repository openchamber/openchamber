import { describe, expect, test } from 'bun:test';
import {
  computeContextUsage,
  DEFAULT_CONTEXT_LIMIT,
  resolveSessionContextSnapshot,
} from './contextUsage';
import type { ModelMetadata } from '@/types';

type TestTokens = {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

const assistant = (tokens: TestTokens, id = 'msg') => ({ id, role: 'assistant', tokens });

describe('computeContextUsage', () => {
  test('sums every token bucket of the newest reporting assistant message', () => {
    const usage = computeContextUsage(
      [assistant({ input: 100, output: 20, reasoning: 5, cache: { read: 800, write: 75 } })],
      2000,
    );
    expect(usage?.totalTokens).toBe(1000);
    expect(usage?.percent).toBe(50);
  });

  test('reports the latest turn rather than a sum across turns', () => {
    // A turn's tokens describe that turn's window, so adding turns up would
    // report several times the real fill.
    const usage = computeContextUsage(
      [
        assistant({ input: 400, output: 0, reasoning: 0 }, 'old'),
        assistant({ input: 900, output: 0, reasoning: 0 }, 'new'),
      ],
      1000,
    );
    expect(usage?.totalTokens).toBe(900);
  });

  test('skips user messages and assistant turns that reported nothing', () => {
    const usage = computeContextUsage(
      [
        assistant({ input: 300, output: 0, reasoning: 0 }, 'real'),
        assistant({ input: 0, output: 0, reasoning: 0 }, 'zeroed'),
        { id: 'user', role: 'user' },
      ],
      1000,
    );
    expect(usage?.totalTokens).toBe(300);
  });

  test('leaves the percentage unrounded', () => {
    // Rounding here is what made the panel print "34.0%" against the header's
    // "33.6%".
    const usage = computeContextUsage([assistant({ input: 336, output: 0, reasoning: 0 })], 1000);
    expect(usage?.percent.toFixed(1)).toBe('33.6');
  });

  test('falls back to the default limit when the model exposes none', () => {
    const usage = computeContextUsage([assistant({ input: 20_000, output: 0, reasoning: 0 })], 0);
    expect(usage?.limit).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(usage?.percent).toBe(10);
  });

  test('returns null when no message carries usable tokens', () => {
    expect(computeContextUsage([], 1000)).toBeNull();
    expect(computeContextUsage([{ id: 'u', role: 'user' }], 1000)).toBeNull();
    expect(computeContextUsage([assistant({ input: 0, output: 0, reasoning: 0 })], 1000)).toBeNull();
  });

  test('tolerates partial token payloads', () => {
    const usage = computeContextUsage([assistant({ input: 10 })], 100);
    expect(usage?.totalTokens).toBe(10);
  });

  test('prefers the server-reported total over summing round-trip fields', () => {
    // Real payload from opencode 1.18.18: ~14 tool-call round-trips accumulated
    // cache.read to 3.29M while the 1M window really held 232,872. Summing
    // rendered 330.6%; the reported total renders the real 23.3%.
    const usage = computeContextUsage(
      [assistant({ total: 232_872, input: 0, output: 14_523, reasoning: 0, cache: { read: 3_291_956, write: 0 } })],
      1_000_000,
    );
    expect(usage?.totalTokens).toBe(232_872);
    expect(usage?.percent.toFixed(4)).toBe('23.2872');
  });

  test('selects a message whose only signal is the reported total', () => {
    const usage = computeContextUsage(
      [assistant({ total: 5_000, input: 0, output: 0, reasoning: 0 })],
      100_000,
    );
    expect(usage?.totalTokens).toBe(5_000);
  });
});

describe('resolveSessionContextSnapshot', () => {
  const providers = [
    { id: 'provider-a', models: [{ id: 'model-a', limit: { context: 100_000, output: 4_000 } }] },
    { id: 'provider-b', models: [{ id: 'model-b', limit: { context: 200_000, output: 8_000 } }] },
  ];
  const noMetadata = new Map<string, ModelMetadata>();

  test('keeps usage and limits on the same reporting message during a model change', () => {
    const snapshot = resolveSessionContextSnapshot([
      { id: 'a', role: 'assistant', providerID: 'provider-a', modelID: 'model-a', tokens: { total: 20_000 } },
      { id: 'b-pending', role: 'assistant', providerID: 'provider-b', modelID: 'model-b' },
    ], providers, noMetadata);

    expect(snapshot).toEqual({
      messageID: 'a',
      providerID: 'provider-a',
      modelID: 'model-a',
      totalTokens: 20_000,
      contextLimit: 100_000,
      outputLimit: 4_000,
      percent: 20,
    });
  });

  test('uses metadata until the live provider list is available', () => {
    const metadata = new Map<string, ModelMetadata>([[
      'provider-a/model-a',
      { id: 'model-a', providerId: 'provider-a', limit: { context: 160_000, output: 12_000 } },
    ]]);

    expect(resolveSessionContextSnapshot([
      { role: 'assistant', providerID: 'PROVIDER-A', modelID: 'model-a', tokens: { total: 40_000 } },
    ], [], metadata)).toEqual({
      providerID: 'PROVIDER-A',
      modelID: 'model-a',
      totalTokens: 40_000,
      contextLimit: 160_000,
      outputLimit: 12_000,
      percent: 25,
    });
  });

  test('waits for model data instead of guessing a context limit', () => {
    expect(resolveSessionContextSnapshot([
      { role: 'assistant', providerID: 'provider-a', modelID: 'model-a', tokens: { total: 40_000 } },
    ], [], noMetadata)).toBeNull();
  });

  test('prefers live limits and falls back only for a resolved model without limits', () => {
    const metadata = new Map<string, ModelMetadata>([[
      'provider-a/model-a',
      { id: 'model-a', providerId: 'provider-a', limit: { context: 160_000, output: 12_000 } },
    ]]);
    const messages = [
      { role: 'assistant', providerID: 'provider-a', modelID: 'model-a', tokens: { total: 20_000 } },
    ];

    expect(resolveSessionContextSnapshot(messages, providers, metadata)?.contextLimit).toBe(100_000);
    expect(resolveSessionContextSnapshot(
      messages,
      [{ id: 'provider-a', models: [{ id: 'model-a' }] }],
      noMetadata,
    )?.contextLimit).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});
