import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, TextPart, UserMessage } from '@opencode-ai/sdk/v2';
import { formatTelemetryDuration, formatTelemetryTokens, formatThroughputRate, getLatestCompletedTurnStats, mergeTimeIntervals, sumIntervalsDuration } from './telemetry';

const user: UserMessage = { id: 'u1', sessionID: 'session-1', role: 'user', time: { created: 0 }, agent: 'build', model: { providerID: 'test', modelID: 'test' } };
const assistant = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'a1', sessionID: 'session-1', role: 'assistant', parentID: user.id,
  agent: 'build', mode: 'build', providerID: 'test', modelID: 'test', path: { cwd: '/repo', root: '/repo' },
  time: { created: 1000, completed: 5000 }, cost: 0,
  tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
  ...overrides,
});
const tool = (start: number, end: number): Part => ({
  id: `tool-${start}`, sessionID: user.sessionID, messageID: 'a1', type: 'tool', tool: 'bash', callID: 'call',
  state: { status: 'completed', input: {}, output: '', title: 'test', metadata: {}, time: { start, end } },
});
const text = (start: number): TextPart => ({ id: `text-${start}`, sessionID: user.sessionID, messageID: 'a1', type: 'text', text: '', time: { start } });
const turn = (info = assistant(), parts: Part[] = []) => [{ info: user, parts: [] }, { info, parts }];

describe('turn telemetry', () => {
  test('merges unsorted parallel, nested, adjoining and invalid tool intervals', () => {
    expect(mergeTimeIntervals([])).toEqual([]);
    const merged = mergeTimeIntervals([[3000, 4000], [1000, 3000], [1500, 2500], [6000, 7000], [NaN, 1], [9, 8]]);
    expect(merged).toEqual([[1000, 4000], [6000, 7000]]);
    expect(sumIntervalsDuration(merged)).toBe(4000);
  });

  test('formats durations, counts and approximate throughput', () => {
    expect(formatTelemetryDuration(0)).toBe('0.0s');
    expect(formatTelemetryDuration(1234)).toBe('1.2s');
    expect(formatTelemetryDuration(84000)).toBe('1m24s');
    expect(formatTelemetryTokens(0)).toBe('0');
    expect(formatTelemetryTokens(500)).toBe('500');
    expect(formatTelemetryTokens(1234)).toBe('1.2K');
    expect(formatTelemetryTokens(1500000)).toBe('1.5M');
    expect(formatThroughputRate(52.3)).toBe('~52 tok/s');
  });

  test('aggregates a multi-step turn, subtracting the tool union and including reasoning tokens', () => {
    const records = turn(assistant({
      time: { created: 10000, completed: 20000 }, cost: 0.01,
      tokens: { input: 1000, output: 200, reasoning: 300, cache: { read: 2000, write: 0 } },
    }), [text(11500), tool(13000, 15000), tool(14000, 16000)]);
    records.push({ info: assistant({ id: 'a2', time: { created: 21000, completed: 24000 }, cost: 0.005,
      tokens: { input: 1500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    }), parts: [text(21500)] });
    const stats = getLatestCompletedTurnStats(records);
    expect(stats).toEqual({ stepsCount: 2, lastAssistantMessageId: 'a2', totalToolDurationMs: 3000,
      totalLlmDurationMs: 10000, outputTokens: 300, reasoningTokens: 300, totalGeneratedTokens: 600,
      inputTokens: 2500, cost: 0.015, tokensPerSecond: 60, responseTokensPerSecond: null, avgTtftMs: 1000, cacheHitPercent: 44 });
  });

  test('uses only the latest user-bounded turn', () => {
    const records = [...turn(), ...turn(assistant({ id: 'new' }))];
    expect(getLatestCompletedTurnStats(records)?.stepsCount).toBe(1);
    expect(getLatestCompletedTurnStats(records)?.lastAssistantMessageId).toBe('new');
  });

  test('does not publish unfinished or truncated turns, or substitute older results', () => {
    expect(getLatestCompletedTurnStats(null)).toBeNull();
    expect(getLatestCompletedTurnStats([])).toBeNull();
    expect(getLatestCompletedTurnStats([{ info: assistant(), parts: [] }])).toBeNull();
    expect(getLatestCompletedTurnStats([...turn(), { info: user, parts: [] }])).toBeNull();
    expect(getLatestCompletedTurnStats([...turn(), ...turn(assistant({ time: { created: 1000 } }))])).toBeNull();
    expect(getLatestCompletedTurnStats([
      ...turn(assistant({ time: { created: 1000 } })), { info: assistant({ id: 'a2' }), parts: [] },
    ])).toBeNull();
  });

  test('recomputes after history materializes and after same-ID message or part corrections', () => {
    const info = assistant();
    expect(getLatestCompletedTurnStats([{ info, parts: [] }])).toBeNull();
    expect(getLatestCompletedTurnStats(turn(info))?.tokensPerSecond).toBe(25);
    expect(getLatestCompletedTurnStats(turn({ ...info, tokens: { ...info.tokens, output: 200 } }))?.tokensPerSecond).toBe(50);
    expect(getLatestCompletedTurnStats(turn(info, [tool(2000, 4000)]))?.tokensPerSecond).toBe(50);
    // A second directory/runtime may reuse IDs but must never reuse the result.
    expect(getLatestCompletedTurnStats(turn(info))?.tokensPerSecond).toBe(25);
  });

  test('missing usage in one step invalidates whole-turn usage, not valid durations', () => {
    const missing = assistant({ id: 'a2', time: { created: 5000, completed: 6000 } });
    Reflect.deleteProperty(missing, 'tokens');
    Reflect.deleteProperty(missing, 'cost');
    const stats = getLatestCompletedTurnStats([...turn(), { info: missing, parts: [] }]);
    expect(stats?.stepsCount).toBe(2);
    expect(stats?.totalLlmDurationMs).toBe(5000);
    expect(stats?.tokensPerSecond).toBeNull();
    expect(stats?.inputTokens).toBeNull();
    expect(stats?.cost).toBeNull();
  });

  test('missing reasoning is not treated as zero and invalid token counts are not summed', () => {
    const info = assistant();
    Reflect.deleteProperty(info.tokens, 'reasoning');
    expect(getLatestCompletedTurnStats(turn(info))?.tokensPerSecond).toBeNull();
    for (const output of [-1, NaN, Infinity]) {
      expect(getLatestCompletedTurnStats(turn(assistant({ tokens: { ...assistant().tokens, output } })))?.totalGeneratedTokens).toBeNull();
    }
  });

  test('preserves genuine zero usage, cache hits and cost', () => {
    const stats = getLatestCompletedTurnStats(turn(assistant({ tokens: { ...assistant().tokens, output: 0 } })));
    expect(stats?.tokensPerSecond).toBe(0);
    expect(stats?.cost).toBe(0);
    expect(stats?.cacheHitPercent).toBe(0);
  });

  test('includes failed tools and chooses the earliest text or reasoning timestamp', () => {
    const failed: Part = { id: 'failed', sessionID: user.sessionID, messageID: 'a1', type: 'tool', tool: 'bash', callID: 'failed',
      state: { status: 'error', input: {}, error: 'failed', time: { start: 2500, end: 4000 } } };
    const reasoning: Part = { id: 'reasoning', sessionID: user.sessionID, messageID: 'a1', type: 'reasoning', text: '', time: { start: 1200 } };
    const stats = getLatestCompletedTurnStats(turn(assistant(), [text(1600), reasoning, tool(2000, 3000), failed]));
    expect(stats?.totalToolDurationMs).toBe(2000);
    expect(stats?.totalLlmDurationMs).toBe(2000);
    expect(stats?.avgTtftMs).toBe(200);
  });

  for (const [start, end] of [[0, 2000], [2000, 6000], [3000, 2000], [NaN, 3000]]) {
    test(`invalid tool interval ${start}..${end} omits duration-dependent metrics`, () => {
    const stats = getLatestCompletedTurnStats(turn(assistant(), [tool(start, end)]));
    expect(stats?.totalToolDurationMs).toBeNull();
    expect(stats?.totalLlmDurationMs).toBeNull();
    expect(stats?.tokensPerSecond).toBeNull();
    expect(stats?.outputTokens).toBe(100);
    });
  }

  test('unfinished tools and missing tool timing cannot produce a rate', () => {
    const unfinished: Part = { id: 'pending', sessionID: user.sessionID, messageID: 'a1', type: 'tool', tool: 'bash', callID: 'pending',
      state: { status: 'pending', input: {}, raw: '' } };
    const missing = tool(2000, 3000);
    if (missing.type !== 'tool') throw new Error('Expected tool fixture');
    Reflect.deleteProperty(missing.state, 'time');
    expect(getLatestCompletedTurnStats(turn(assistant(), [unfinished]))?.tokensPerSecond).toBeNull();
    expect(getLatestCompletedTurnStats(turn(assistant(), [missing]))?.tokensPerSecond).toBeNull();
  });

  test('invalid step time does not silently remove that step from totals', () => {
    const stats = getLatestCompletedTurnStats([...turn(), { info: assistant({ id: 'a2', time: { created: 6000, completed: 5000 } }), parts: [] }]);
    expect(stats?.stepsCount).toBe(2);
    expect(stats?.totalGeneratedTokens).toBe(200);
    expect(stats?.totalLlmDurationMs).toBeNull();
    expect(stats?.tokensPerSecond).toBeNull();
  });

  test('separates final text delivery from whole-turn throughput on the measured tool-heavy shape', () => {
    const records = turn(assistant({
      time: { created: 1000, completed: 38438 },
      tokens: { ...assistant().tokens, output: 223 },
    }), [tool(19950, 38438)]);
    records.push({ info: assistant({ id: 'final', time: { created: 40000, completed: 45598 },
      tokens: { ...assistant().tokens, output: 338 },
    }), parts: [{ ...text(42661), text: 'Final answer', time: { start: 42661, end: 45442 } }] });
    const stats = getLatestCompletedTurnStats(records);
    expect(Math.round(stats?.tokensPerSecond ?? 0)).toBe(23);
    expect(Math.round(stats?.responseTokensPerSecond ?? 0)).toBe(122);
  });

  test('measures the final text only, excluding reasoning tokens and their time', () => {
    const stats = getLatestCompletedTurnStats(turn(assistant({ tokens: { ...assistant().tokens, output: 260, reasoning: 100 } }), [
      { id: 'reasoning', sessionID: user.sessionID, messageID: 'a1', type: 'reasoning', text: 'Thinking', time: { start: 1200, end: 2000 } },
      { ...text(2500), text: 'Final answer', time: { start: 2500, end: 4500 } },
    ]));
    expect(stats?.responseTokensPerSecond).toBe(130);
    expect(stats?.tokensPerSecond).toBe(90);
  });

  test('unions overlapping text intervals without mutating the authoritative parts', () => {
    const parts = [
      { ...text(2000), text: 'First', time: { start: 2000, end: 3500 } },
      { ...text(3000), text: 'Second', time: { start: 3000, end: 4000 } },
    ];
    const stats = getLatestCompletedTurnStats(turn(assistant(), parts));
    expect(stats?.responseTokensPerSecond).toBe(50);
    expect(parts[0].time.end).toBe(3500);
  });

  test('missing, partial or invalid response timing never falls back to whole-turn speed', () => {
    const invalidParts: Part[][] = [
      [], [{ ...text(2000), text: 'No end' }],
      [{ ...text(2000), text: 'Bad end', time: { start: 2000, end: 1000 } }],
      [{ ...text(2000), text: 'Late end', time: { start: 2000, end: 6000 } }],
      [{ ...text(2000), text: 'Zero span', time: { start: 2000, end: 2000 } }],
      [{ ...text(2000), text: 'Bad time', time: { start: NaN, end: 4000 } }],
      [{ ...text(2000), text: 'Synthetic', synthetic: true, time: { start: 2000, end: 4000 } }],
      [{ ...text(2000), text: 'Tool preface', time: { start: 2000, end: 3000 } }, tool(3000, 4000)],
      [{ ...text(2000), text: 'Timed', time: { start: 2000, end: 3000 } }, { ...text(3000), text: 'Untimed' }],
    ];
    for (const parts of invalidParts) {
      const stats = getLatestCompletedTurnStats(turn(assistant(), parts));
      expect(stats?.responseTokensPerSecond).toBeNull();
      expect(stats?.tokensPerSecond !== null).toBe(true);
    }
  });

  test('response speed needs valid output usage and a successful final reply', () => {
    const parts = [{ ...text(2000), text: 'Final reply', time: { start: 2000, end: 4000 } }];
    const missingUsage = assistant();
    Reflect.deleteProperty(missingUsage.tokens, 'output');
    expect(getLatestCompletedTurnStats(turn(missingUsage, parts))?.responseTokensPerSecond).toBeNull();
    expect(getLatestCompletedTurnStats(turn(assistant({ error: { name: 'MessageAbortedError', data: { message: 'Stopped' } } }), parts))?.responseTokensPerSecond).toBeNull();
    expect(getLatestCompletedTurnStats(turn(assistant({ time: { created: NaN, completed: 5000 } }), parts))?.responseTokensPerSecond).toBeNull();
  });
});
