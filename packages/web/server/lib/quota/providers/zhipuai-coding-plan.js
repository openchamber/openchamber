import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/shared.js';
import {
  resolveConfigApiKey,
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

export const envelopeError = (payload) => {
  const code = payload?.code;
  if (payload?.success !== false && !(code !== undefined && code !== null && code !== 200)) {
    return null;
  }
  const msg = asNonEmptyString(payload?.msg);
  return msg ?? `API error: ${code ?? 'unknown'}`;
};

function getApiKey(auth) {
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
        return resolveConfigApiKey(providerConfig.options.apiKey);
      }
    }
  } catch {
    // Ignore config read errors; the provider will be treated as not configured.
  }

  return null;
}

export const isConfigured = (auth) => {
  return Boolean(getApiKey(auth));
};

export const fetchQuota = async () => {
  const apiKey = getApiKey(await readOpenCodeCredentials());

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

    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
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
