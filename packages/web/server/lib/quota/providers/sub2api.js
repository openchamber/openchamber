import { readAuthFile } from '../../opencode/auth.js';
import { readConfig } from '../../opencode/shared.js';
import {
  asNonEmptyString,
  asObject,
  buildResult,
  formatMoney,
  getAuthEntry,
  normalizeAuthEntry,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../utils/index.js';

export const providerId = 'sub2api';
export const providerName = 'Sub2API';
export const aliases = ['sub2api'];

const WINDOW_SECONDS_BY_LABEL = {
  '5h': 5 * 60 * 60,
  '1d': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60
};

const WINDOW_KEY_BY_LABEL = {
  '5h': '5h',
  '1d': 'daily',
  '7d': '7d'
};

const SUBSCRIPTION_PERIODS = [
  { key: 'daily', usageField: 'daily_usage_usd', limitField: 'daily_limit_usd', windowSeconds: 24 * 60 * 60 },
  { key: 'weekly', usageField: 'weekly_usage_usd', limitField: 'weekly_limit_usd', windowSeconds: 7 * 24 * 60 * 60 },
  { key: 'monthly', usageField: 'monthly_usage_usd', limitField: 'monthly_limit_usd', windowSeconds: 30 * 24 * 60 * 60 }
];

const HTTP_PREFIX = /^https?:\/\//i;
const V1_SUFFIX = /\/v1$/i;

const normalizeBaseUrl = (raw) => {
  const trimmed = asNonEmptyString(raw);
  if (!trimmed || !HTTP_PREFIX.test(trimmed)) return null;
  let base = trimmed.replace(/\/+$/, '');
  if (V1_SUFFIX.test(base)) {
    base = base.slice(0, -3);
  }
  return base.replace(/\/+$/, '');
};

export const resolveSub2ApiBaseUrl = () => {
  let merged;
  try {
    merged = readConfig();
  } catch {
    return null;
  }
  if (!merged || typeof merged !== 'object') return null;
  const providerBlock = asObject(merged.provider);
  const provider = providerBlock ? asObject(providerBlock[providerId]) : null;
  const options = provider ? asObject(provider.options) : null;
  return normalizeBaseUrl(options ? options.baseURL : null);
};

const resolveApiKey = () => {
  const entry = normalizeAuthEntry(getAuthEntry(readAuthFile(), aliases));
  return entry?.key ?? entry?.token ?? null;
};

export const isConfigured = () => Boolean(resolveSub2ApiBaseUrl() && resolveApiKey());

const clampPercent = (value) => Math.max(0, Math.min(100, value));

const formatAmount = (value, unit) => {
  const number = toNumber(value);
  if (number === null) return null;
  const formatted = formatMoney(number);
  if (formatted === null) return null;
  const unitName = asNonEmptyString(unit) ?? 'USD';
  return unitName === 'USD' ? `$${formatted}` : `${formatted} ${unitName}`;
};

const parseStatBlock = (block) => ({
  requests: toNumber(block.requests),
  inputTokens: toNumber(block.input_tokens),
  outputTokens: toNumber(block.output_tokens),
  cacheReadTokens: toNumber(block.cache_read_tokens),
  totalTokens: toNumber(block.total_tokens),
  actualCost: toNumber(block.actual_cost)
});

const parseUsageStatistics = (usageBlock, unit) => {
  const usage = asObject(usageBlock);
  if (!usage) return null;
  const today = asObject(usage.today);
  const total = asObject(usage.total);
  const summary = {};
  if (today) summary.today = parseStatBlock(today);
  if (total) summary.total = parseStatBlock(total);
  return Object.keys(summary).length > 0 ? { summary, unit } : null;
};

const parseModelStatistics = (entries, unit) => {
  if (!Array.isArray(entries)) return null;
  const models = {};
  for (const entry of entries) {
    const block = asObject(entry);
    if (!block) continue;
    const name = asNonEmptyString(block.model);
    if (!name) continue;
    models[name] = parseStatBlock(block);
  }
  return Object.keys(models).length > 0 ? models : null;
};

const parseRateLimits = (entries, unit) => {
  const windows = {};
  for (const entry of entries) {
    const block = asObject(entry);
    if (!block) continue;
    const label = asNonEmptyString(block.window);
    const limit = toNumber(block.limit);
    const used = toNumber(block.used);
    if (!label || limit === null || used === null) continue;

    const startAt = toTimestamp(block.window_start);
    const resetAt = toTimestamp(block.reset_at);
    let windowSeconds = null;
    if (startAt !== null && resetAt !== null && resetAt > startAt) {
      windowSeconds = Math.floor((resetAt - startAt) / 1000);
    }
    if (windowSeconds === null) {
      windowSeconds = WINDOW_SECONDS_BY_LABEL[label] ?? null;
    }

    const key = WINDOW_KEY_BY_LABEL[label] ?? label;
    windows[key] = toUsageWindow({
      usedPercent: limit > 0 ? clampPercent((used / limit) * 100) : null,
      windowSeconds,
      resetAt,
      usedLabel: formatAmount(used, unit),
      remainingLabel: formatAmount(toNumber(block.remaining), unit)
    });
  }
  return windows;
};

const parseSubscriptionLimits = (subscription, unit) => {
  const windows = {};
  for (const { key, usageField, limitField, windowSeconds } of SUBSCRIPTION_PERIODS) {
    const used = toNumber(subscription[usageField]);
    const limit = toNumber(subscription[limitField]);
    if (used === null || limit === null) continue;

    let resetAt = null;
    if (key === 'weekly') {
      const windowStart = toTimestamp(subscription.weekly_window_start);
      if (windowStart !== null) {
        resetAt = windowStart + 7 * 24 * 60 * 60 * 1000;
      }
    }

    windows[key] = toUsageWindow({
      usedPercent: limit > 0 ? clampPercent((used / limit) * 100) : null,
      windowSeconds,
      resetAt,
      usedLabel: formatAmount(used, unit),
      remainingLabel: formatAmount(Math.max(0, limit - used), unit)
    });
  }
  return windows;
};

export const parseSub2ApiUsage = (payload) => {
  const unit = asNonEmptyString(payload?.unit) ?? 'USD';
  const mode = asNonEmptyString(payload?.mode);
  const windows = {};

  if (mode === 'quota_limited') {
    const quota = asObject(payload?.quota);
    if (quota) {
      const limit = toNumber(quota.limit);
      const used = toNumber(quota.used);
      const quotaUnit = asNonEmptyString(quota.unit) ?? unit;
      if (limit !== null && used !== null) {
        windows.plan_limit = toUsageWindow({
          usedPercent: limit > 0 ? clampPercent((used / limit) * 100) : null,
          windowSeconds: null,
          resetAt: null,
          usedLabel: formatAmount(used, quotaUnit),
          remainingLabel: formatAmount(toNumber(quota.remaining), quotaUnit)
        });
      }
    }
    if (Array.isArray(payload?.rate_limits)) {
      Object.assign(windows, parseRateLimits(payload.rate_limits, unit));
    }
  } else if (mode === 'unrestricted') {
    const subscription = asObject(payload?.subscription);
    if (subscription) {
      Object.assign(windows, parseSubscriptionLimits(subscription, unit));
      const planName = asNonEmptyString(payload?.planName);
      const remaining = toNumber(payload?.remaining);
      if (remaining !== null) {
        const key = planName ?? 'credits_balance';
        windows[key] = toUsageWindow({
          usedPercent: null,
          windowSeconds: null,
          resetAt: null,
          valueLabel: formatAmount(remaining, unit)
        });
      }
    } else {
      const balance = toNumber(payload?.balance);
      const remaining = toNumber(payload?.remaining);
      const amount = balance ?? remaining;
      if (amount !== null) {
        windows.credits_balance = toUsageWindow({
          usedPercent: null,
          windowSeconds: null,
          resetAt: null,
          valueLabel: formatAmount(amount, unit)
        });
      }
    }
  }

  const statisticsUsage = parseUsageStatistics(payload?.usage, unit);
  const statisticsModels = parseModelStatistics(payload?.model_stats, unit);
  const statistics = statisticsUsage || statisticsModels
    ? {
        ...(statisticsUsage ? { today: statisticsUsage.summary.today, total: statisticsUsage.summary.total } : {}),
        ...(statisticsModels ? { models: statisticsModels } : {}),
        unit
      }
    : null;

  return {
    windows,
    status: asNonEmptyString(payload?.status),
    statistics
  };
};

export const fetchQuota = async () => {
  const baseUrl = resolveSub2ApiBaseUrl();
  const apiKey = resolveApiKey();
  if (!baseUrl || !apiKey) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(`${baseUrl}/v1/usage`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': 'OpenChamber quota provider'
      },
      signal: timeoutSignal
    });

    if (response.status === 401 || response.status === 403) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Sub2API authentication failed'
      });
    }
    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `Sub2API usage API returned HTTP ${response.status}`
      });
    }

    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Invalid response from provider'
      });
    }

    const { windows, status, statistics } = parseSub2ApiUsage(payload);
    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      status,
      statistics
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};
