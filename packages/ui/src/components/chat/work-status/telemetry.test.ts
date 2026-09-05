import { describe, expect, test, beforeEach } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
  clearTurnStatsCacheForTests,
  formatTelemetryDuration,
  formatTelemetryTokens,
  formatThroughputRate,
  getLatestCompletedTurnStats,
  mergeTimeIntervals,
  sumIntervalsDuration,
  type SessionMessageRecord,
} from './telemetry';

// SAFETY: Mock factory helper for unit testing telemetry calculations with partial message payload shapes
const createMessage = (id: string, role: 'user' | 'assistant', time: { created?: number; completed?: number }, tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }, cost?: number): Message => {
  // SAFETY: Typed mock message for test assertions
  return {
    id,
    role,
    sessionID: 'session-1',
    time,
    tokens,
    cost,
  } as Message;
};

// SAFETY: Mock factory helper for unit testing telemetry calculations with partial part payload shapes
const createTextPart = (id: string, startTime?: number): Part => {
  // SAFETY: Typed mock text part for test assertions
  return {
    id,
    sessionID: 'session-1',
    messageID: 'm-1',
    type: 'text',
    text: 'hello',
    time: startTime !== undefined && Number.isFinite(startTime) ? { start: startTime } : undefined,
  } as Part;
};

// SAFETY: Mock factory helper for unit testing telemetry calculations with partial tool part payload shapes
const createToolPart = (id: string, start: number, end: number): Part => {
  // SAFETY: Typed mock tool part for test assertions
  return {
    id,
    sessionID: 'session-1',
    messageID: 'm-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state: {
      status: 'completed',
      time: { start, end },
    },
  } as Part;
};

describe('telemetry', () => {
  beforeEach(() => {
    clearTurnStatsCacheForTests();
  });

  describe('mergeTimeIntervals', () => {
    test('returns empty array for empty input', () => {
      expect(mergeTimeIntervals([])).toEqual([]);
    });

    test('preserves single valid interval', () => {
      expect(mergeTimeIntervals([[1000, 2000]])).toEqual([[1000, 2000]]);
    });

    test('preserves disjoint non-overlapping intervals in order', () => {
      const input: Array<[number, number]> = [[3000, 4000], [1000, 2000]];
      expect(mergeTimeIntervals(input)).toEqual([[1000, 2000], [3000, 4000]]);
    });

    test('merges overlapping intervals', () => {
      const input: Array<[number, number]> = [[1000, 2500], [2000, 3500]];
      expect(mergeTimeIntervals(input)).toEqual([[1000, 3500]]);
    });

    test('merges contained intervals', () => {
      const input: Array<[number, number]> = [[1000, 5000], [2000, 3000], [2500, 4500]];
      expect(mergeTimeIntervals(input)).toEqual([[1000, 5000]]);
    });

    test('merges multiple parallel overlapping tool executions without double counting', () => {
      // 3 parallel tool calls running at the same time:
      // Tool 1: 1000 -> 3000 (2000ms)
      // Tool 2: 1500 -> 2500 (1000ms)
      // Tool 3: 2000 -> 4000 (2000ms)
      // Total wall-clock span is 1000 -> 4000 = 3000ms (NOT 5000ms!)
      const intervals: Array<[number, number]> = [[1000, 3000], [1500, 2500], [2000, 4000]];
      const merged = mergeTimeIntervals(intervals);
      expect(merged).toEqual([[1000, 4000]]);
      expect(sumIntervalsDuration(merged)).toBe(3000);
    });

    test('filters out invalid or inverted intervals', () => {
      const input: Array<[number, number]> = [[2000, 1000], [1000, 2000]];
      expect(mergeTimeIntervals(input)).toEqual([[1000, 2000]]);
    });
  });

  describe('formatters', () => {
    test('formats duration under a minute with one decimal', () => {
      expect(formatTelemetryDuration(0)).toBe('0.0s');
      expect(formatTelemetryDuration(1234)).toBe('1.2s');
      expect(formatTelemetryDuration(45678)).toBe('45.7s');
    });

    test('formats duration 60s or more with minutes and seconds', () => {
      expect(formatTelemetryDuration(60000)).toBe('1m0s');
      expect(formatTelemetryDuration(84000)).toBe('1m24s');
    });

    test('formats token counts with K and M suffixes', () => {
      expect(formatTelemetryTokens(0)).toBe('0');
      expect(formatTelemetryTokens(500)).toBe('500');
      expect(formatTelemetryTokens(1234)).toBe('1.2K');
      expect(formatTelemetryTokens(1500000)).toBe('1.5M');
    });

    test('formats throughput with tilde prefix', () => {
      expect(formatThroughputRate(52.3)).toBe('~52 tok/s');
      expect(formatThroughputRate(60)).toBe('~60 tok/s');
    });
  });

  describe('getLatestCompletedTurnStats', () => {
    test('returns null for empty records or no completed assistant messages', () => {
      expect(getLatestCompletedTurnStats([])).toBeNull();
      expect(getLatestCompletedTurnStats(null)).toBeNull();

      const incomplete: SessionMessageRecord[] = [
        {
          info: createMessage('u1', 'user', { created: 1000 }),
          parts: [],
        },
        {
          info: createMessage('a1', 'assistant', { created: 2000 }), // streaming, no time.completed
          parts: [],
        },
      ];
      expect(getLatestCompletedTurnStats(incomplete)).toBeNull();
    });

    test('calculates completed multi-step turn with parallel tools, TTFT, and throughput', () => {
      const records: SessionMessageRecord[] = [
        // Previous completed turn
        {
          info: createMessage('u1', 'user', { created: 1000 }),
          parts: [],
        },
        {
          info: createMessage('a1', 'assistant', { created: 2000, completed: 4000 }, { input: 100, output: 50 }),
          parts: [],
        },
        // Latest turn (starts at u2)
        {
          info: createMessage('u2', 'user', { created: 5000 }),
          parts: [],
        },
        // Step 1: 10s total, parallel tools take union 3s (13000->16000), pure LLM = 7s
        {
          info: createMessage(
            'a2_step1',
            'assistant',
            { created: 10000, completed: 20000 },
            {
              input: 1000,
              output: 200,
              reasoning: 300,
              cache: { read: 2000, write: 0 },
            },
            0.01,
          ),
          parts: [
            createTextPart('p1_text', 11500), // TTFT = 1500ms
            createToolPart('p2_tool1', 13000, 15000), // 2000ms
            createToolPart('p3_tool2', 14000, 16000), // overlaps, union is 13000->16000 = 3000ms
          ],
        },
        // Step 2: 3s total, no tools, pure LLM = 3s
        {
          info: createMessage(
            'a2_step2',
            'assistant',
            { created: 21000, completed: 24000 },
            {
              input: 1500,
              output: 100,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            0.005,
          ),
          parts: [
            createTextPart('p4_text', 21500), // TTFT = 500ms
          ],
        },
      ];

      const stats = getLatestCompletedTurnStats(records);
      expect(stats).not.toBeNull();

      // Steps in this turn = 2 (step1 + step2)
      expect(stats?.stepsCount).toBe(2);
      expect(stats?.lastAssistantMessageId).toBe('a2_step2');

      // Tool duration: Step 1 union = 3000ms, Step 2 = 0ms => 3000ms
      expect(stats?.totalToolDurationMs).toBe(3000);

      // LLM duration: Step 1 = 10s - 3s = 7000ms; Step 2 = 3000ms => 10000ms (10.0s)
      expect(stats?.totalLlmDurationMs).toBe(10000);

      // Generated tokens: Step 1 (200 out + 300 reasoning) + Step 2 (100 out) = 600
      expect(stats?.outputTokens).toBe(300);
      expect(stats?.reasoningTokens).toBe(300);
      expect(stats?.totalGeneratedTokens).toBe(600);

      // Throughput: 600 tokens / 10s = 60 tok/s
      expect(stats?.tokensPerSecond).toBe(60);

      // TTFT: avg(1500, 500) = 1000ms
      expect(stats?.avgTtftMs).toBe(1000);

      // Cache hit: total input 2500, cache read 2000 -> 2000 / (2500 + 2000) = 44%
      expect(stats?.cacheHitPercent).toBe(44);

      // Cost: 0.01 + 0.005 = 0.015
      expect(Math.round((stats?.cost ?? 0) * 1000)).toBe(15);
    });

    test('ignores in-flight streaming message and evaluates latest completed turn', () => {
      const records: SessionMessageRecord[] = [
        {
          info: createMessage('u1', 'user', { created: 1000 }),
          parts: [],
        },
        {
          info: createMessage('a1', 'assistant', { created: 2000, completed: 4000 }, { input: 100, output: 80 }),
          parts: [],
        },
        // Turn 2 is actively streaming
        {
          info: createMessage('u2', 'user', { created: 5000 }),
          parts: [],
        },
        {
          info: createMessage('a2_streaming', 'assistant', { created: 6000 }), // no completed timestamp!
          parts: [],
        },
      ];

      const stats = getLatestCompletedTurnStats(records);
      expect(stats?.lastAssistantMessageId).toBe('a1');
      expect(stats?.outputTokens).toBe(80);
      expect(stats?.totalLlmDurationMs).toBe(2000);
    });

    test('omits tokensPerSecond when provider does not report output tokens', () => {
      const records: SessionMessageRecord[] = [
        {
          info: createMessage('u1', 'user', { created: 1000 }),
          parts: [],
        },
        {
          info: createMessage('a1', 'assistant', { created: 2000, completed: 5000 }), // 3s, no tokens reported
          parts: [],
        },
      ];

      const stats = getLatestCompletedTurnStats(records);
      expect(stats?.totalLlmDurationMs).toBe(3000);
      expect(stats?.totalGeneratedTokens).toBe(0);
      expect(stats?.tokensPerSecond).toBeNull();
    });

    test('returns cached result for the same final assistant message ID', () => {
      const records: SessionMessageRecord[] = [
        {
          info: createMessage('u1', 'user', { created: 1000 }),
          parts: [],
        },
        {
          info: createMessage('a1', 'assistant', { created: 2000, completed: 4000 }, { input: 100, output: 100 }),
          parts: [],
        },
      ];

      const first = getLatestCompletedTurnStats(records);
      const second = getLatestCompletedTurnStats(records);
      expect(first).toBe(second); // exact same object reference from cache
    });
  });
});
