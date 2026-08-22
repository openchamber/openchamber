/**
 * Shapes Anthropic's OAuth usage payload into quota windows.
 *
 * The payload carries the same limit twice: a legacy set of named fields
 * (`five_hour`, `seven_day`, ...) and a newer `limits` array. Only the array
 * reports model-scoped limits, and Anthropic ships new limit kinds there under
 * rotating internal code names, so limits are read from the array by `kind` and
 * fall back to the legacy fields when the array is missing.
 *
 * @module quota/providers/claude/transforms
 */

import { asObject, asNonEmptyString, toNumber, toTimestamp, toUsageWindow, formatMoney } from '../../utils/index.js';

const SESSION_WINDOW = '5h';
const WEEKLY_WINDOW = '7d';
const EXTRA_USAGE_WINDOW = 'extra_usage';

// Consumers rank limits by how soon they run out, so each window carries its
// duration. Extra usage is a monthly spend cap, not a rolling window.
const SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const asArray = (value) => (Array.isArray(value) ? value : []);

/** Money in Anthropic's minor-unit form, e.g. `{ amount_minor: 10000, exponent: 2 }`. */
const toAmount = (value) => {
  const money = asObject(value);
  const minor = toNumber(money?.amount_minor);
  if (minor === null) return null;
  const exponent = toNumber(money?.exponent) ?? 2;
  return minor / 10 ** exponent;
};

const formatSpendLabel = (used, limit, currency) => {
  const usedLabel = formatMoney(used);
  if (usedLabel === null) return null;
  const prefix = currency === 'USD' || !currency ? '$' : `${currency} `;
  const limitLabel = formatMoney(limit);
  return limitLabel === null ? `${prefix}${usedLabel}` : `${prefix}${usedLabel} / ${prefix}${limitLabel}`;
};

const addWindow = (target, key, { percent, resetAt, valueLabel, windowSeconds = null }) => {
  if (percent === null && !valueLabel) return;
  target[key] = toUsageWindow({ usedPercent: percent, windowSeconds, resetAt, valueLabel });
};

const applyLimitsArray = (limits, windows, models) => {
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
      const modelWindows = {};
      addWindow(modelWindows, WEEKLY_WINDOW, { percent, resetAt, windowSeconds: WEEKLY_WINDOW_SECONDS });
      if (Object.keys(modelWindows).length > 0) models[modelName] = { windows: modelWindows };
    }
  }
};

const applyLegacyFields = (payload, windows) => {
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

/**
 * Extra usage is the paid overflow beyond plan limits. It is only meaningful
 * once the account has it enabled; a disabled block would render as a permanent
 * empty bar.
 */
const applyExtraUsage = (payload, windows) => {
  const spend = asObject(payload.spend);
  if (!spend || spend.enabled !== true) return;
  const used = toAmount(spend.used);
  const limit = toAmount(spend.limit);
  addWindow(windows, EXTRA_USAGE_WINDOW, {
    percent: toNumber(spend.percent),
    resetAt: null,
    valueLabel: formatSpendLabel(used, limit, asNonEmptyString(asObject(spend.used)?.currency))
  });
};

/**
 * @param {unknown} rawPayload Parsed JSON body of the OAuth usage endpoint.
 * @returns {{ windows: Record<string, object>, models: Record<string, object> }}
 */
export const toClaudeUsage = (rawPayload) => {
  const payload = asObject(rawPayload) ?? {};
  const windows = {};
  const models = {};

  const limits = asArray(payload.limits);
  if (limits.length > 0) {
    applyLimitsArray(limits, windows, models);
  } else {
    applyLegacyFields(payload, windows);
  }

  applyExtraUsage(payload, windows);

  return { windows, models };
};
