import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  durationToLabel,
  durationToSeconds,
  asNonEmptyString,
  formatMoney,
  asObject
} from '../utils/index.js';

const MOONSHOT_BALANCE_URL = 'https://api.moonshot.ai/v1/users/me/balance';

const fetchMoonshotBalanceWindows = async (apiKey, fetchImpl, refreshSignal) => {
  try {
    const response = await fetchImpl(MOONSHOT_BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.any([refreshSignal, AbortSignal.timeout(5_000)])
    });
    if (!response.ok) return null;
    const balance = asObject(asObject(await response.json())?.data)?.available_balance;
    if (!Number.isFinite(balance)) return null;
    return {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(balance)}`
      })
    };
  } catch {
    return null;
  }
};

export const providerId = 'kimi-for-coding';
export const providerName = 'Kimi for Coding';
const aliases = ['kimi-code-plan-cn', 'kimi-for-coding', 'kimi', 'kimi-code-plan-global'];

const RATIO_WINDOWS = [
  { key: 'limit_5h', label: '5h', windowSeconds: 5 * 60 * 60 },
  { key: 'limit_7d', label: 'weekly', windowSeconds: 7 * 24 * 60 * 60 },
  { key: 'limit_month_total', label: 'monthly', windowSeconds: null }
];

const toRatioPercent = (entry) => {
  const ratio = toNumber(entry?.used_ratio);
  return ratio === null ? null : Math.max(0, Math.min(100, ratio * 100));
};

const ratioWindows = (usages) => {
  const windows = {};
  for (const { key, label, windowSeconds } of RATIO_WINDOWS) {
    const entry = asObject(usages[key]);
    const usedPercent = toRatioPercent(entry);
    if (usedPercent === null) continue;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds,
      resetAt: toTimestamp(entry.reset_time)
    });
  }
  return windows;
};

const computeUsedPercent = (total, used, remaining) => {
  if (!total) return null;
  if (used !== null) {
    return Math.max(0, Math.min(100, (used / total) * 100));
  }
  if (remaining !== null) {
    return Math.max(0, Math.min(100, 100 - (remaining / total) * 100));
  }
  return null;
};

const legacyWindows = (payload) => {
  const windows = {};
  const usage = asObject(payload?.usage);
  if (usage) {
    windows.weekly = toUsageWindow({
      usedPercent: computeUsedPercent(toNumber(usage.limit), toNumber(usage.used), toNumber(usage.remaining)),
      windowSeconds: null,
      resetAt: toTimestamp(usage.resetTime)
    });
  }

  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  for (const limit of limits) {
    const window = limit?.window;
    const detail = limit?.detail;
    const rawLabel = durationToLabel(window?.duration, window?.timeUnit);
    const windowSeconds = durationToSeconds(window?.duration, window?.timeUnit);
    const label = windowSeconds === 5 * 60 * 60 ? `Rate Limit (${rawLabel})` : rawLabel;
    windows[label] = toUsageWindow({
      usedPercent: computeUsedPercent(toNumber(detail?.limit), toNumber(detail?.used), toNumber(detail?.remaining)),
      windowSeconds,
      resetAt: toTimestamp(detail?.resetTime)
    });
  }
  return windows;
};

const collectApiKeys = (auth) => {
  const keys = [];
  const seen = new Set();
  for (const alias of aliases) {
    const entry = normalizeAuthEntry(auth?.[alias] ?? null);
    const apiKey = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
    const endpoint = alias === 'kimi-code-plan-global'
      ? 'https://api.kimi.ai/coding/v1/usages'
      : 'https://api.kimi.com/coding/v1/usages';
    const identity = JSON.stringify([endpoint, apiKey]);
    if (apiKey && !seen.has(identity)) {
      seen.add(identity);
      keys.push({ apiKey, endpoint });
    }
  }
  return keys;
};

export const isConfigured = (auth) => collectApiKeys(auth).length > 0;

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials, fetchImpl = fetch } = {}) => {
  const apiKeys = collectApiKeys(await readAuth());

  if (apiKeys.length === 0) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const refreshSignal = AbortSignal.timeout(25_000);
    let firstError = null;
    for (const { apiKey, endpoint } of apiKeys) {
      refreshSignal.throwIfAborted();
      const response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.any([refreshSignal, AbortSignal.timeout(5_000)])
      });

      if (response.ok) {
        const payload = await response.json();
        const usages = asObject(asObject(payload)?.usages);
        const windows = usages ? ratioWindows(usages) : legacyWindows(payload);

        return buildResult({
          providerId,
          providerName,
          ok: true,
          configured: true,
          usage: { windows }
        });
      }

      if (response.status === 401 || response.status === 403) {
        const balanceWindows = await fetchMoonshotBalanceWindows(apiKey, fetchImpl, refreshSignal);
        if (balanceWindows) {
          return buildResult({
            providerId,
            providerName,
            ok: true,
            configured: true,
            usage: { windows: balanceWindows }
          });
        }
        firstError ??= `API error: ${response.status}`;
        continue;
      }

      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: firstError ?? 'Request failed'
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
