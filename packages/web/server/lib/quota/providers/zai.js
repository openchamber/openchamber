import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  resolveWindowSeconds,
  resolveWindowLabel,
  normalizeTimestamp
} from '../utils/index.js';

export const providerId = 'zai-coding-plan';
export const providerName = 'z.ai';
const aliases = ['zai-coding-plan', 'zai', 'z.ai'];

// CREDIT_LIMIT entries carry `usage` (total credits), `currentValue` (consumed),
// and `remaining`; TOKENS_LIMIT entries only carry a percentage.
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

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

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
    const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
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
    const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];
    const windows = {};
    // The API renamed TOKENS_LIMIT to CREDIT_LIMIT; field semantics stayed the same,
    // so both limit types map to the same windows.
    for (const limit of limits.filter((entry) => entry?.type === 'TOKENS_LIMIT' || entry?.type === 'CREDIT_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(limit);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = limit?.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null;
      const usedPercent = typeof limit?.percentage === 'number' ? limit.percentage : null;
      const creditValueLabel = formatCreditValueLabel(limit);

      windows[windowLabel] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt,
        valueLabel: creditValueLabel
      });
    }

    const mcpToolsTimeLimit = limits.find((limit) => limit?.type === 'TIME_LIMIT');
    if (mcpToolsTimeLimit) {
      windows['MCP Tools'] = toUsageWindow({
        usedPercent: typeof mcpToolsTimeLimit.percentage === 'number' ? mcpToolsTimeLimit.percentage : null,
        windowSeconds: 30 * 24 * 60 * 60,
        resetAt: mcpToolsTimeLimit.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
      planLabel: typeof payload?.data?.level === 'string' && payload.data.level ? payload.data.level : null
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
