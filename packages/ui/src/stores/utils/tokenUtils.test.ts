import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
  computeCacheHitRate,
  computeSessionMessageCounts,
  computeSessionTokenRate,
  contextTokensFromBreakdown,
  extractTokensFromMessage,
  sumTokenBreakdown,
} from './tokenUtils';

const assistantMessage = (tokens: unknown): { info: Message; parts: Part[] } => ({
  info: { tokens } as unknown as Message,
  parts: [],
});

describe('sumTokenBreakdown', () => {
  test('sums every token bucket', () => {
    expect(sumTokenBreakdown({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } })).toBe(15);
  });

  test('returns zero for absent data', () => {
    expect(sumTokenBreakdown(null)).toBe(0);
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

  test('uses the reported total from the message info breakdown', () => {
    const message = assistantMessage({ total: 232_872, input: 0, output: 14_523, reasoning: 0, cache: { read: 3_291_956, write: 0 } });
    expect(extractTokensFromMessage(message)).toBe(232_872);
  });

  test('sums the info breakdown when no total is reported', () => {
    expect(extractTokensFromMessage(assistantMessage({ input: 100, output: 50, reasoning: 20, cache: { read: 80, write: 20 } }))).toBe(270);
  });

  test('returns plain numeric tokens as-is', () => {
    expect(extractTokensFromMessage(assistantMessage(1234))).toBe(1234);
  });

  test('prefers the reported total when tokens live on a part', () => {
    const message: { info: Message; parts: Part[] } = {
      info: {} as Message,
      parts: [{ tokens: { total: 500, input: 2_000 } } as unknown as Part],
    };
    expect(extractTokensFromMessage(message)).toBe(500);
  });

  test('returns 0 when neither info nor parts carry tokens', () => {
    expect(extractTokensFromMessage({ info: {} as Message, parts: [] })).toBe(0);
  });
});

describe('computeCacheHitRate', () => {
  test('uses inclusive input tokens', () => {
    expect(computeCacheHitRate({ input: 100, cache: { read: 300, write: 100 } })).toEqual({ percent: 60, hasInput: true });
  });

  test('marks absent input as unavailable', () => {
    expect(computeCacheHitRate({ input: 0, cache: { read: 0, write: 0 } })).toEqual({ percent: 0, hasInput: false });
  });

  test('returns zero and hasInput=false for null input', () => {
    expect(computeCacheHitRate(null)).toEqual({ percent: 0, hasInput: false });
  });

  test('returns zero and hasInput=false for undefined input', () => {
    expect(computeCacheHitRate(undefined)).toEqual({ percent: 0, hasInput: false });
  });

  test('returns zero and hasInput=false when input is negative', () => {
    expect(computeCacheHitRate({ input: -5, cache: { read: 0, write: 0 } })).toEqual({ percent: 0, hasInput: false });
  });

  test('returns zero percent when no cache read tokens', () => {
    expect(computeCacheHitRate({ input: 1000, cache: { read: 0, write: 200 } })).toEqual({ percent: 0, hasInput: true });
  });

  test('computes correct percentage: 31.25% with cache read + cache write', () => {
    const result = computeCacheHitRate({ input: 1000, cache: { read: 500, write: 100 } });
    expect(Math.abs(result.percent - 31.25) < 1e-2).toBe(true);
    expect(result.hasInput).toBe(true);
  });

  test('computes correct percentage: 50% when cache read equals non-cached input (no cache write)', () => {
    expect(computeCacheHitRate({ input: 1000, cache: { read: 1000, write: 0 } })).toEqual({ percent: 50, hasInput: true });
  });

  test('handles missing cache object', () => {
    expect(computeCacheHitRate({ input: 500 })).toEqual({ percent: 0, hasInput: true });
  });

  test('handles missing cache.read', () => {
    expect(computeCacheHitRate({ input: 500, cache: { write: 100 } })).toEqual({ percent: 0, hasInput: true });
  });

  test('computes below 100% when cache.read is larger than non-cached input', () => {
    const result = computeCacheHitRate({ input: 100, cache: { read: 200, write: 0 } });
    expect(Math.abs(result.percent - 66.67) < 1e-2).toBe(true);
    expect(result.hasInput).toBe(true);
  });

  test('clamps to 0% when cache.read is negative (defensive against bad data)', () => {
    expect(computeCacheHitRate({ input: 100, cache: { read: -50, write: 0 } })).toEqual({ percent: 0, hasInput: true });
  });

  test('handles real-world Anthropic example: 850 cached + 100 write + 1000 non-cached', () => {
    const result = computeCacheHitRate({ input: 1000, cache: { read: 850, write: 100 } });
    expect(Math.abs(result.percent - 43.59) < 1e-1).toBe(true);
    expect(result.hasInput).toBe(true);
  });

  test('handles real-world Anthropic example: zero cache on first turn', () => {
    expect(computeCacheHitRate({ input: 2000, cache: { read: 0, write: 2000 } })).toEqual({ percent: 0, hasInput: true });
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

describe('contextTokensFromBreakdown', () => {
  test('prefers the server-reported total over the summed fields', () => {
    const breakdown = { total: 500, input: 100, output: 50, reasoning: 20, cache: { read: 800, write: 20 } };
    expect(contextTokensFromBreakdown(breakdown)).toBe(500);
  });

  test('real multi-step turn: summing overstates a 1M window 14x, the total matches it', () => {
    // Captured from opencode 1.18.18 (/session/:id/message) after a turn with
    // ~14 tool-call round-trips. Every round-trip re-reads the whole cached
    // prompt, so cache.read accumulates to 3.29M while the window really held
    // 232,872. Summing rendered the context meter at 330.6% of a 1M window.
    const breakdown = { total: 232_872, input: 0, output: 14_523, reasoning: 0, cache: { read: 3_291_956, write: 0 } };
    expect(contextTokensFromBreakdown(breakdown)).toBe(232_872);
    expect(sumTokenBreakdown(breakdown)).toBe(3_306_479);
  });

  test('single-step turn: the total and the summed fields agree', () => {
    // Captured from the same server: one round-trip, nothing accumulates.
    const breakdown = { total: 117_714, input: 1_116, output: 87, reasoning: 543, cache: { read: 115_968, write: 0 } };
    expect(contextTokensFromBreakdown(breakdown)).toBe(sumTokenBreakdown(breakdown));
  });

  test('falls back to summing when the server sends no total (older servers)', () => {
    expect(contextTokensFromBreakdown({ input: 100, output: 50, reasoning: 20, cache: { read: 80, write: 20 } })).toBe(270);
  });

  test('falls back to summing when the total is zero or not a finite number', () => {
    expect(contextTokensFromBreakdown({ total: 0, input: 40 })).toBe(40);
    expect(contextTokensFromBreakdown({ total: Number.NaN, input: 40 })).toBe(40);
  });

  test('handles null and undefined', () => {
    expect(contextTokensFromBreakdown(null)).toBe(0);
    expect(contextTokensFromBreakdown(undefined)).toBe(0);
  });
});
