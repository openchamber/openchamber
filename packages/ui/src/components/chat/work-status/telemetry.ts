import type { Message, Part } from '@opencode-ai/sdk/v2';
import { computeCacheHitRate } from '@/stores/utils/tokenUtils';

type SessionMessageRecord = {
  info: Message;
  parts: Part[];
};

type CompletedStepStats = {
  toolDurationMs: number | null;
  adjustedLlmDurationMs: number | null;
  ttftMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: number | null;
};

export type CompletedTurnStats = {
  lastAssistantMessageId: string;
  stepsCount: number;
  totalLlmDurationMs: number | null;
  totalToolDurationMs: number | null;
  avgTtftMs: number | null;
  tokensPerSecond: number | null;
  responseTokensPerSecond: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalGeneratedTokens: number | null;
  cacheHitPercent: number | null;
  cost: number | null;
};

/**
 * Merge an array of [start, end] time intervals into a disjoint union of intervals.
 * Correctly accounts for parallel / overlapping tool executions without double-counting.
 */
export function mergeTimeIntervals(intervals: readonly (readonly [number, number])[]): Array<[number, number]> {
  if (intervals.length === 0) return [];

  const valid: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      valid.push([start, end]);
    }
  }

  valid.sort((a, b) => a[0] - b[0]);
  if (valid.length === 0) return [];

  const merged: Array<[number, number]> = [valid[0]];

  for (let i = 1; i < valid.length; i += 1) {
    const current = valid[i];
    const last = merged[merged.length - 1];

    if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Sum the total duration spanned by an array of disjoint intervals.
 */
export function sumIntervalsDuration(intervals: readonly (readonly [number, number])[]): number {
  return intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
}

export const formatTelemetryDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0.0s';
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
};

export const formatTelemetryTokens = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '0';
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(tokens));
};

export const formatThroughputRate = (tps: number): string => {
  return `~${Math.round(tps)} tok/s`;
};

const nonnegative = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;

const add = (left: number | null, right: number | null): number | null =>
  left === null || right === null ? null : nonnegative(left + right);

/** Text delivery rate for the final reply, not throughput of the agent loop. */
function calculateResponseTokenRate(record: SessionMessageRecord): number | null {
  const { info, parts } = record;
  if (info.role !== 'assistant' || info.error || parts.some((part) => part.type === 'tool')) return null;
  const output = nonnegative(info.tokens?.output);
  const { created, completed } = info.time;
  if (output === null || completed === undefined || nonnegative(created) === null || nonnegative(completed) === null) return null;

  const intervals: Array<[number, number]> = [];
  for (const part of parts) {
    if (part.type !== 'text') continue;
    // Synthetic/ignored text cannot be matched to the provider's output count.
    if (part.synthetic || part.ignored) return null;
    if (!part.text) continue;
    const start = part.time?.start;
    const end = part.time?.end;
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)
      || start < created || end > completed || end <= start) return null;
    intervals.push([start, end]);
  }
  const duration = sumIntervalsDuration(mergeTimeIntervals(intervals));
  return duration > 0 ? nonnegative(output / (duration / 1000)) : null;
}

/**
 * Calculate stats for a single completed assistant step.
 */
function calculateCompletedStepStats(record: SessionMessageRecord): CompletedStepStats | null {
  const { info, parts } = record;
  if (info.role !== 'assistant') return null;

  const { created } = info.time;
  const completed = info.time.completed;

  if (completed === undefined) return null;

  const validWindow = nonnegative(created) !== null && nonnegative(completed) !== null && completed >= created;
  const totalDurationMs = validWindow ? nonnegative(completed - created) : null;

  // An unfinished or invalid tool makes duration-dependent metrics unknown.
  const rawToolIntervals: Array<[number, number]> = [];
  let validTools = validWindow;
  for (const part of parts) {
    if (part.type !== 'tool') continue;
    if (part.state.status !== 'completed' && part.state.status !== 'error') {
      validTools = false;
      continue;
    }
    const start = part.state.time?.start;
    const end = part.state.time?.end;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < created || end > completed || end < start) {
      validTools = false;
      continue;
    }
    rawToolIntervals.push([start, end]);
  }

  const toolDurationMs = validTools ? nonnegative(sumIntervalsDuration(mergeTimeIntervals(rawToolIntervals))) : null;
  const adjustedLlmDurationMs = totalDurationMs !== null && toolDurationMs !== null
    ? nonnegative(totalDurationMs - toolDurationMs)
    : null;

  // Measure TTFT from first text or reasoning part start timestamp
  let ttftMs: number | null = null;
  for (const part of parts) {
    if (part.type === 'text' || part.type === 'reasoning') {
      const partStart = part.time?.start;
      if (validWindow && partStart !== undefined && Number.isFinite(partStart) && partStart >= created && partStart <= completed) {
        const delta = partStart - created;
        ttftMs = ttftMs === null ? delta : Math.min(ttftMs, delta);
      }
    }
  }

  const inputTokens = nonnegative(info.tokens?.input);
  const outputTokens = nonnegative(info.tokens?.output);
  const reasoningTokens = nonnegative(info.tokens?.reasoning);
  const cacheReadTokens = nonnegative(info.tokens?.cache?.read);
  const cacheWriteTokens = nonnegative(info.tokens?.cache?.write);
  const cost = nonnegative(info.cost);

  return {
    toolDurationMs,
    adjustedLlmDurationMs,
    ttftMs,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
  };
}

/**
 * Calculates telemetry metrics for the latest completed turn in the session.
 * A turn encompasses all assistant steps since the preceding user message up to the final completed assistant step.
 */
export function getLatestCompletedTurnStats(
  records: readonly SessionMessageRecord[] | null | undefined,
): CompletedTurnStats | null {
  if (!records || records.length === 0) return null;

  // Only the newest user-bounded turn qualifies. A partial newer turn must not
  // be published as complete or silently replaced with an older turn's stats.
  const lastCompletedAssistantIdx = records.length - 1;
  if (records[lastCompletedAssistantIdx].info.role !== 'assistant') return null;
  let turnStartIdx = -1;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.info.role === 'user') {
      turnStartIdx = i + 1;
      break;
    }
  }

  if (turnStartIdx === -1) return null;

  const stepStatsList: CompletedStepStats[] = [];
  for (let i = turnStartIdx; i <= lastCompletedAssistantIdx; i += 1) {
    const record = records[i];
    if (record.info.role === 'assistant') {
      const stepStats = calculateCompletedStepStats(record);
      if (!stepStats) return null;
      stepStatsList.push(stepStats);
    }
  }

  if (stepStatsList.length === 0) return null;

  let totalLlmDurationMs: number | null = 0;
  let totalToolDurationMs: number | null = 0;
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let totalReasoningTokens: number | null = 0;
  let totalCacheReadTokens: number | null = 0;
  let totalCacheWriteTokens: number | null = 0;
  let totalCost: number | null = 0;
  let totalTtft: number | null = 0;

  for (const step of stepStatsList) {
    totalLlmDurationMs = add(totalLlmDurationMs, step.adjustedLlmDurationMs);
    totalToolDurationMs = add(totalToolDurationMs, step.toolDurationMs);
    totalInputTokens = add(totalInputTokens, step.inputTokens);
    totalOutputTokens = add(totalOutputTokens, step.outputTokens);
    totalReasoningTokens = add(totalReasoningTokens, step.reasoningTokens);
    totalCacheReadTokens = add(totalCacheReadTokens, step.cacheReadTokens);
    totalCacheWriteTokens = add(totalCacheWriteTokens, step.cacheWriteTokens);
    totalCost = add(totalCost, step.cost);
    totalTtft = add(totalTtft, step.ttftMs);
  }

  const avgTtftMs = totalTtft === null ? null : totalTtft / stepStatsList.length;

  const totalGeneratedTokens = add(totalOutputTokens, totalReasoningTokens);
  const tokensPerSecond = totalGeneratedTokens !== null && totalLlmDurationMs !== null && totalLlmDurationMs > 0
    ? nonnegative(totalGeneratedTokens / (totalLlmDurationMs / 1000))
    : null;

  const cacheHit = totalInputTokens !== null && totalCacheReadTokens !== null && totalCacheWriteTokens !== null ? computeCacheHitRate({
    input: totalInputTokens,
    cache: { read: totalCacheReadTokens, write: totalCacheWriteTokens },
  }) : null;

  return {
    lastAssistantMessageId: records[lastCompletedAssistantIdx].info.id,
    stepsCount: stepStatsList.length,
    totalLlmDurationMs,
    totalToolDurationMs,
    avgTtftMs,
    tokensPerSecond,
    responseTokensPerSecond: calculateResponseTokenRate(records[lastCompletedAssistantIdx]),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    reasoningTokens: totalReasoningTokens,
    totalGeneratedTokens,
    cacheHitPercent: cacheHit?.hasInput ? Math.round(cacheHit.percent) : null,
    cost: totalCost,
  };
}
