import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { asNonEmptyString } from '../../shared/guards.js';
import { envelopeError } from './zhipuai-coding-plan.js';
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
export const aliases = ['zai-coding-plan', 'zai', 'z.ai'];

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

const ZAI_RESET_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const parseZaiResetExpire = (value) => {
  if (!ZAI_RESET_TIME_PATTERN.test(value)) return null;
  const timestamp = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  return Number.isNaN(timestamp) ? null : timestamp;
};

const pickZaiGiftReset = (records) => {
  if (!Array.isArray(records)) return null;
  const now = Date.now();
  let best = null;
  for (const record of records) {
    if (!record || record?.available !== true) continue;
    if (!Number.isFinite(record?.recordId)) continue;
    const expireAt = parseZaiResetExpire(record.expireTime);
    if (expireAt === null || expireAt <= now) continue;
    if (best === null || expireAt < best.expireAt) {
      best = { recordId: record.recordId, expireAt };
      const grantType = asNonEmptyString(record.grantType);
      if (grantType) {
        best.grantType = grantType;
      }
    }
  }
  return best;
};

const ZAI_GIFT_RESET_URL = 'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL';
const ZAI_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const ZAI_WEEK_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const attachZaiGiftResets = async (windows, apiKey) => {
  try {
    const response = await fetch(ZAI_GIFT_RESET_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) return;
    const payload = await response.json();
    const data = payload?.data;
    if (!data) return;

    const fiveHour = pickZaiGiftReset(data.fiveHourResets);
    const weekly = pickZaiGiftReset(data.weekResets);

    for (const window of Object.values(windows)) {
      if (window?.windowSeconds === ZAI_FIVE_HOUR_WINDOW_SECONDS && fiveHour) {
        window.giftReset = fiveHour;
      } else if (window?.windowSeconds === ZAI_WEEK_WINDOW_SECONDS && weekly) {
        window.giftReset = weekly;
      }
    }
  } catch {
    // Gift resets are optional metadata; ignore failures.
  }
};

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

const ZAI_GIFT_RESET_USE_URL = 'https://api.z.ai/api/biz/customer-package-reset/use';
export const giftResetTypes = ['FIVE_HOUR', 'WEEK'];

export const useZaiGiftReset = async ({ recordId, resetType, grantType }) => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

  if (!apiKey) {
    throw new Error('Not configured');
  }
  const normalizedGrantType = asNonEmptyString(grantType);
  if (!Number.isFinite(recordId)
    || !giftResetTypes.includes(resetType)
    || (grantType !== undefined && normalizedGrantType === null)) {
    throw new Error('Invalid gift reset request');
  }

  const response = await fetch(ZAI_GIFT_RESET_USE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      targetType: 'PERSONAL',
      resetType,
      recordId,
      requestId: crypto.randomUUID(),
      grantType: normalizedGrantType ?? 'GLOBAL'
    })
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    throw new Error(payload?.msg || `API error: ${response.status}`);
  }
  return true;
};

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
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

    await attachZaiGiftResets(windows, apiKey);

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
