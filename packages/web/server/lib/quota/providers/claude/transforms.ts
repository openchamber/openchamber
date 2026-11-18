
import { z } from 'zod';
import { asNonEmptyString, toNumber, toTimestamp, toUsageWindow, formatMoney } from '../../utils/index.js';
import type { ProviderUsage, UsageWindow } from '../../utils/contracts.js';

interface ClaudeUsageFields {
  amount_minor?: unknown;
  exponent?: unknown;
  currency?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: unknown;
  model?: unknown;
  display_name?: unknown;
  kind?: unknown;
  five_hour?: unknown;
  seven_day?: unknown;
  utilization?: unknown;
  spend?: unknown;
  enabled?: unknown;
  used?: unknown;
  limit?: unknown;
  limits?: unknown;
}

export interface ClaudeUsage {
  windows: Record<string, UsageWindow>;
  models: Record<string, ProviderUsage>;
}

interface WindowInput {
  percent: number | null;
  resetAt: number | null;
  valueLabel?: string | null;
  windowSeconds?: number | null;
}

const isUsageFields = (value: unknown): value is ClaudeUsageFields =>
  value !== null && typeof value === 'object';
const asObject = z.custom<ClaudeUsageFields | null>(isUsageFields).catch(null).parse;

const isLimitsArray = (value: unknown): value is unknown[] => Array.isArray(value);

const SESSION_WINDOW = '5h';
const WEEKLY_WINDOW = '7d';
const EXTRA_USAGE_WINDOW = 'extra_usage';

const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const asArray = z.custom<unknown[]>(isLimitsArray).catch(() => []).parse;

const toAmount = (money: ClaudeUsageFields | null) => {
  const minor = toNumber(money?.amount_minor);
  if (minor === null) return null;
  const exponent = toNumber(money?.exponent) ?? 2;
  return minor / 10 ** exponent;
};

const formatSpendLabel = (used: number | null, limit: number | null, currency: string | null) => {
  const usedLabel = formatMoney(used);
  if (usedLabel === null) return null;
  const prefix = currency === 'USD' || !currency ? '$' : `${currency} `;
  const limitLabel = formatMoney(limit);
  return limitLabel === null ? `${prefix}${usedLabel}` : `${prefix}${usedLabel} / ${prefix}${limitLabel}`;
};

const addWindow = (target: ClaudeUsage['windows'], key: string, { percent, resetAt, valueLabel, windowSeconds = null }: WindowInput) => {
  if (percent === null && !valueLabel) return;
  target[key] = toUsageWindow({ usedPercent: percent, windowSeconds, resetAt, valueLabel });
};

const applyLimitsArray = (limits: unknown[], windows: ClaudeUsage['windows'], models: ClaudeUsage['models']) => {
  for (const entry of limits) {
    const limit = asObject(entry);
    if (!limit) continue;
    const percent = toNumber(limit.percent);
    const resetAt = toTimestamp(limit.resets_at);
    const modelName = asNonEmptyString(asObject(asObject(limit.scope)?.model)?.display_name);

    if (limit.kind === 'session') {
      addWindow(windows, SESSION_WINDOW, { percent, resetAt, windowSeconds: SESSION_WINDOW_SECONDS });
      continue;
    }
    if (limit.kind === 'weekly_all') {
      addWindow(windows, WEEKLY_WINDOW, { percent, resetAt, windowSeconds: WEEKLY_WINDOW_SECONDS });
      continue;
    }
    if (limit.kind === 'weekly_scoped' && modelName) {
      const modelWindows: ClaudeUsage['windows'] = {};
      addWindow(modelWindows, WEEKLY_WINDOW, { percent, resetAt, windowSeconds: WEEKLY_WINDOW_SECONDS });
      if (Object.keys(modelWindows).length > 0) models[modelName] = { windows: modelWindows };
    }
  }
};

const applyLegacyFields = (payload: ClaudeUsageFields, windows: ClaudeUsage['windows']) => {
  const fiveHour = asObject(payload.five_hour);
  const sevenDay = asObject(payload.seven_day);
  if (fiveHour) {
    addWindow(windows, SESSION_WINDOW, {
      percent: toNumber(fiveHour.utilization),
      resetAt: toTimestamp(fiveHour.resets_at),
      windowSeconds: SESSION_WINDOW_SECONDS
    });
  }
  if (sevenDay) {
    addWindow(windows, WEEKLY_WINDOW, {
      percent: toNumber(sevenDay.utilization),
      resetAt: toTimestamp(sevenDay.resets_at),
      windowSeconds: WEEKLY_WINDOW_SECONDS
    });
  }
};

const applyExtraUsage = (payload: ClaudeUsageFields, windows: ClaudeUsage['windows']) => {
  const spend = asObject(payload.spend);
  if (!spend || spend.enabled !== true) return;
  const used = toAmount(asObject(spend.used));
  const limit = toAmount(asObject(spend.limit));
  addWindow(windows, EXTRA_USAGE_WINDOW, {
    percent: toNumber(spend.percent),
    resetAt: null,
    valueLabel: formatSpendLabel(used, limit, asNonEmptyString(asObject(spend.used)?.currency))
  });
};

export const toClaudeUsage = z.unknown().transform((rawPayload): ClaudeUsage => {
  const payload = asObject(rawPayload) ?? {};
  const windows: ClaudeUsage['windows'] = {};
  const models: ClaudeUsage['models'] = {};

  const limits = asArray(payload.limits);
  if (limits.length > 0) {
    applyLimitsArray(limits, windows, models);
  } else {
    applyLegacyFields(payload, windows);
  }

  applyExtraUsage(payload, windows);

  return { windows, models };
}).parse;
