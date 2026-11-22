
import { computeCacheHitRate, findLatestContextFill, type ContextFillMessage } from '@/stores/utils/tokenUtils';

type WorkStatusContextUsage =
  | {
    state: 'measured';
    totalTokens: number;
    limit: number;
    percent: number;
  }
  | { state: 'compacted'; limit: number };

export const DEFAULT_CONTEXT_LIMIT = 200_000;

export const computeContextUsage = (
  messages: readonly ContextFillMessage[],
  contextLimit: number,
): WorkStatusContextUsage | null => {
  const fill = findLatestContextFill(messages);
  if (!fill) return null;

  const limit = contextLimit > 0 ? contextLimit : DEFAULT_CONTEXT_LIMIT;
  if (fill.state === 'compacted') return { state: 'compacted', limit };

  return { state: 'measured', totalTokens: fill.totalTokens, limit, percent: (fill.totalTokens / limit) * 100 };
};

export const computeLastReplyCacheHit = (messages: readonly ContextFillMessage[]): number | null => {
  const fill = findLatestContextFill(messages);
  if (fill?.state !== 'measured') return null;
  const hitRate = computeCacheHitRate(messages[fill.index]?.tokens);
  return hitRate.hasInput ? hitRate.percent : null;
};

type SessionTokenRecord = {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
};

type SessionTokenTotals = {
  prompt: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent: number | null;
};

export const computeSessionTokenTotals = (session: SessionTokenRecord | null | undefined): SessionTokenTotals | null => {
  const tokens = session?.tokens;
  if (!tokens) return null;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  const totals = {
    prompt: (tokens.input ?? 0) + cacheRead + cacheWrite,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead,
    cacheWrite,
  };
  if (totals.prompt + totals.output + totals.reasoning <= 0) return null;
  const hitRate = computeCacheHitRate(tokens);
  return { ...totals, cacheHitPercent: hitRate.hasInput ? hitRate.percent : null };
};
