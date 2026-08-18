import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';
import {
  computeCacheHitRate,
  computeSessionMessageCounts,
  computeSessionTokenRate,
  extractTokensFromMessage,
  sumTokenBreakdown,
} from './tokenUtils';

describe('sumTokenBreakdown', () => {
  test('sums every token bucket', () => {
    expect(sumTokenBreakdown({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })).toBe(15);
  });

  test('returns zero for absent data', () => {
    expect(sumTokenBreakdown(undefined)).toBe(0);
  });
});

describe('computeSessionMessageCounts', () => {
  test('counts user and assistant messages without deriving cost', () => {
    const messages = [
      { role: 'user', cost: 100 },
      { role: 'assistant', cost: 0.5 },
      { role: 'assistant', cost: 0.3 },
    ] as Message[];

    expect(computeSessionMessageCounts(messages)).toEqual({ userCount: 1, assistantCount: 2 });
  });

  test('recognizes client-side user message markers', () => {
    const messages = [
      { role: 'system', clientRole: 'user' },
      { role: 'system', userMessageMarker: true },
      { role: 'system', clientRole: 'assistant' },
    ] as unknown as Message[];

    expect(computeSessionMessageCounts(messages)).toEqual({ userCount: 2, assistantCount: 1 });
  });
});

describe('extractTokensFromMessage', () => {
  test('uses message tokens before part tokens', () => {
    expect(extractTokensFromMessage({
      info: { tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } } as Message,
      parts: [{ tokens: 100 }] as never[],
    })).toBe(15);
  });

  test('falls back to a part token value', () => {
    expect(extractTokensFromMessage({
      info: {} as Message,
      parts: [{ tokens: 42 }] as never[],
    })).toBe(42);
  });
});

describe('computeCacheHitRate', () => {
  test('uses inclusive input tokens', () => {
    expect(computeCacheHitRate({ input: 100, cache: { read: 300, write: 100 } })).toEqual({ percent: 60, hasInput: true });
  });

  test('marks absent input as unavailable', () => {
    expect(computeCacheHitRate({ input: 0, cache: { read: 0, write: 0 } })).toEqual({ percent: 0, hasInput: false });
  });
});

describe('computeSessionTokenRate', () => {
  test('calculates generated tokens per second', () => {
    const result = computeSessionTokenRate([
      { role: 'assistant', id: 'a', tokens: { output: 20, reasoning: 10 }, time: { created: 0, completed: 2000 } },
    ] as Message[]);

    expect(result).toEqual({ avgTokensPerSecond: 15, lastTokensPerSecond: 15 });
  });

  test('aggregates completed assistant turns and reports the last rate', () => {
    const result = computeSessionTokenRate([
      { role: 'assistant', id: 'first', tokens: { output: 20 }, time: { created: 0, completed: 2000 } },
      { role: 'user', id: 'user', tokens: { output: 100 }, time: { created: 2000, completed: 3000 } },
      { role: 'assistant', id: 'last', tokens: { output: 60 }, time: { created: 3000, completed: 6000 } },
    ] as Message[]);

    expect(result).toEqual({ avgTokensPerSecond: 16, lastTokensPerSecond: 20 });
  });

  test('subtracts only the merged tool time within a message', () => {
    const result = computeSessionTokenRate(
      [{ role: 'assistant', id: 'assistant', tokens: { output: 30 }, time: { created: 0, completed: 10000 } }] as Message[],
      () => [
        { type: 'tool', state: { time: { start: -2000, end: 3000 } } },
        { type: 'tool', state: { time: { start: 2000, end: 5000 } } },
        { type: 'tool', state: { time: { start: 8000, end: 12000 } } },
      ],
    );

    expect(result).toEqual({ avgTokensPerSecond: 10, lastTokensPerSecond: 10 });
  });

  test('ignores assistant messages without a valid completed generation', () => {
    const result = computeSessionTokenRate([
      { role: 'assistant', id: 'missing-time', tokens: { output: 20 } },
      { role: 'assistant', id: 'unfinished', tokens: { output: 20 }, time: { created: 0, completed: 0 } },
      { role: 'assistant', id: 'no-output', tokens: { output: 0 }, time: { created: 0, completed: 1000 } },
    ] as Message[]);

    expect(result).toEqual({ avgTokensPerSecond: 0, lastTokensPerSecond: 0 });
  });
});
