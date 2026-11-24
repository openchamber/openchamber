import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import { readConfigLayers } from '../../opencode/config-files.js';
import type { TokenWindowLimit, UsageWindow } from '../utils/contracts.js';
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
const aliases = ['zhipuai-coding-plan', 'zhipuai', 'zhipu'] as const;

export interface EnvelopeFields {
  code?: unknown;
  success?: unknown;
  msg?: unknown;
}

interface CodingPlanLimitFields extends TokenWindowLimit {
  type?: unknown;
  currentValue?: unknown;
  remaining?: unknown;
  usage?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
}

export const hasPayloadFields = (value: unknown): value is EnvelopeFields & { data?: unknown } => value != null;
export const hasDataFields = (value: unknown): value is { limits?: unknown; level?: unknown } => value != null;
const hasLimitFields = (value: unknown): value is CodingPlanLimitFields => value != null;
export const isLimitArray = (value: unknown): value is unknown[] => Array.isArray(value);
export const isNumber = (value: unknown): value is number => typeof value === 'number';
export const isCreditLimit = (value: unknown): value is CodingPlanLimitFields =>
  hasLimitFields(value) && (value.type === 'TOKENS_LIMIT' || value.type === 'CREDIT_LIMIT');
export const isTimeLimit = (value: unknown): value is CodingPlanLimitFields =>
  hasLimitFields(value) && value.type === 'TIME_LIMIT';
const hasAuthFields = (value: unknown): value is { key?: unknown; token?: unknown } => value != null;
const hasProviderAliases = (value: unknown): value is Partial<Record<typeof aliases[number], unknown>> => value != null;
const hasProviderOptions = (value: unknown): value is { options?: unknown } => value != null;
const hasApiKey = (value: unknown): value is { apiKey?: unknown } => value != null;

const formatCreditAmount = (value: number) => {
  if (value < 1000) return value.toLocaleString('en-US');
  return `${Math.round(value / 100) / 10}k`;
};

export const formatCreditValueLabel = (limit: CodingPlanLimitFields) => {
  const used = toNumber(limit?.currentValue);
  const total = toNumber(limit?.usage);
  if (used === null || total === null) return null;
  return `${formatCreditAmount(used)} / ${formatCreditAmount(total)} credits`;
};

export const creditAmounts = (limit: CodingPlanLimitFields) => {
  const used = toNumber(limit?.currentValue);
  const total = toNumber(limit?.usage);
  const remaining = toNumber(limit?.remaining);
  if (used === null || total === null || used < 0 || total <= 0) return undefined;
  return remaining === null || remaining < 0 ? { used, limit: total } : { used, limit: total, remaining };
};

const resolveUsedPercent = (limit: CodingPlanLimitFields) => {
  const percentage = toNumber(limit?.percentage);
  if (percentage !== null) {
    return percentage;
  }
  const used = toNumber(limit?.currentValue);
  const total = toNumber(limit?.usage);
  if (used === null || total === null || total <= 0) return null;
  return Math.round((used / total) * 100);
};

export const envelopeError = (payload: EnvelopeFields | null | undefined) => {
  const code = payload?.code;
  if (payload?.success !== false && !(code !== undefined && code !== null && code !== 200)) {
    return null;
  }
  const msg = asNonEmptyString(payload?.msg);
  return msg ?? `API error: ${code ?? 'unknown'}`;
};

function getApiKey(auth: LegacyAuthFile) {
  const rawEntry: unknown = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const entry = hasAuthFields(rawEntry) ? rawEntry : null;
  const apiKeyFromAuth = entry?.key ?? entry?.token;

  if (apiKeyFromAuth) {
    return apiKeyFromAuth;
  }

  try {
    const { mergedConfig } = readConfigLayers();

    for (const alias of aliases) {
      const provider = mergedConfig?.provider;
      const providerConfig = hasProviderAliases(provider) ? provider[alias] : undefined;
      const options = hasProviderOptions(providerConfig) ? providerConfig.options : undefined;
      if (hasApiKey(options) && options.apiKey) {
        const key: unknown = resolveConfigApiKey(options.apiKey);
        return key;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export const isConfigured = (auth: LegacyAuthFile) => {
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

    const rawPayload: unknown = await response.json();
    const payload = hasPayloadFields(rawPayload) ? rawPayload : null;

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

    const data = hasDataFields(payload?.data) ? payload.data : null;
    const limits = isLimitArray(data?.limits) ? data.limits : [];

    const windows: Record<string, UsageWindow> = {};

    for (const limit of limits.filter(isCreditLimit)) {
      const windowSeconds = resolveWindowSeconds(limit);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = limit?.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null;

      windows[windowLabel] = toUsageWindow({
        usedPercent: resolveUsedPercent(limit),
        windowSeconds,
        resetAt,
        valueLabel: formatCreditValueLabel(limit),
        credits: creditAmounts(limit)
      });
    }

    const mcpToolsTimeLimit = limits.find(isTimeLimit);
    if (mcpToolsTimeLimit) {
      const monthSeconds = 30 * 24 * 60 * 60;
      const resetAt = mcpToolsTimeLimit?.nextResetTime ? normalizeTimestamp(mcpToolsTimeLimit.nextResetTime) : null;
      const usedPercent = isNumber(mcpToolsTimeLimit.percentage) ? mcpToolsTimeLimit.percentage : null;

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
      planLabel: asNonEmptyString(data?.level)
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
