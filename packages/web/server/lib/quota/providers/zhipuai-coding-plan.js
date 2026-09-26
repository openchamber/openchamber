/**
 * Zhipu AI Coding Plan quota fetch
 *
 * API: https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *
 * bigmodel.cn reports business failures inside HTTP 200 bodies
 * (`{code, msg, success: false}`), so the envelope must be validated before
 * `data.limits` is parsed. A missing envelope is treated as legacy success.
 *
 * Response limits:
 * - TOKENS_LIMIT / CREDIT_LIMIT: token/credit usage windows (5-hour and weekly).
 *   The API renamed TOKENS_LIMIT to CREDIT_LIMIT; CREDIT_LIMIT entries
 *   additionally carry `usage` (total), `currentValue` (consumed), `remaining`,
 *   and `percentage` (used percent, derived from currentValue/usage when absent).
 * - TIME_LIMIT: MCP tools usage (monthly window)
 *
 * `data.level` is the plan tier (for example "lite") and becomes `planLabel`.
 */
import { readAuthFile } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  asNonEmptyString,
  resolveWindowSeconds,
  resolveWindowLabel,
  normalizeTimestamp
} from '../utils/index.js';

export const providerId = 'zhipuai-coding-plan';
export const providerName = 'Zhipu AI Coding Plan';
const aliases = ['zhipuai-coding-plan', 'zhipuai', 'zhipu'];

// Mirrors the Z.ai credit label (same monitor API family): `usage` is the
// total, `currentValue` the consumed amount.
const formatCreditAmount = (value) => {
  if (value < 1000) return value.toLocaleString('en-US');
  return `${Math.round(value / 100) / 10}k`;
};

const formatCreditValueLabel = (limit) => {
  const used = toNumber(limit?.currentValue);
  const total = toNumber(limit?.usage);
  if (used === null || total === null) return null;
  return `${formatCreditAmount(used)} / ${formatCreditAmount(total)} credits`;
};

// `percentage` is the used percent; when the API omits it, derive it from
// currentValue/usage (observed percentages are integers).
const resolveUsedPercent = (limit) => {
  const percentage = toNumber(limit?.percentage);
  if (percentage !== null) {
    return percentage;
  }
  const used = toNumber(limit?.currentValue);
  const total = toNumber(limit?.usage);
  if (used === null || total === null || total <= 0) return null;
  return Math.round((used / total) * 100);
};

const envelopeError = (payload) => {
  const code = payload?.code;
  if (payload?.success !== false && !(code !== undefined && code !== null && code !== 200)) {
    return null;
  }
  const msg = asNonEmptyString(payload?.msg);
  return msg ?? `API error: ${code ?? 'unknown'}`;
};

function getApiKey() {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKeyFromAuth = entry?.key ?? entry?.token;

  if (apiKeyFromAuth) {
    return apiKeyFromAuth;
  }

  try {
    const { mergedConfig } = readConfigLayers();

    for (const alias of aliases) {
      const providerConfig = mergedConfig?.provider?.[alias];
      if (providerConfig?.options?.apiKey) {
        return providerConfig.options.apiKey;
      }
    }
  } catch {
    // Ignore config read errors; the provider will be treated as not configured.
  }

  return null;
}

export const isConfigured = () => {
  return Boolean(getApiKey());
};

export const fetchQuota = async () => {
  const apiKey = getApiKey();

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();

    const failure = envelopeError(payload);
    if (failure) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: failure
      });
    }

    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];

    const windows = {};

    // The API renamed TOKENS_LIMIT to CREDIT_LIMIT; field semantics stayed the
    // same, so both limit types map to the same windows. Unit 3 marks hourly
    // blocks (5h), unit 6 weekly.
    for (const limit of limits.filter((entry) => entry?.type === 'TOKENS_LIMIT' || entry?.type === 'CREDIT_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(limit);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = limit?.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null;

      windows[windowLabel] = toUsageWindow({
        usedPercent: resolveUsedPercent(limit),
        windowSeconds,
        resetAt,
        valueLabel: formatCreditValueLabel(limit)
      });
    }

    // Handle TIME_LIMIT (MCP tools monthly window)
    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
      // TIME_LIMIT unit=5 means 1 month (30 days)
      const monthSeconds = 30 * 24 * 60 * 60;
      const resetAt = mcpToolsTimeLimit?.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null;
      const usedPercent = typeof mcpToolsTimeLimit?.percentage === 'number' ? mcpToolsTimeLimit.percentage : null;

      windows['MCP Tools'] = toUsageWindow({
        usedPercent,
        windowSeconds: monthSeconds,
        resetAt
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      planLabel: asNonEmptyString(payload?.data?.level)
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
