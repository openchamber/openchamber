import { readQuotaJson } from '../utils/response-body.js';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { envelopeError } from './zhipuai-coding-plan.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  resolveWindowSeconds,
  resolveWindowLabel,
  normalizeTimestamp,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'zai-coding-plan';
export const providerName = 'z.ai';
export const aliases = ['zai-coding-plan', 'zai', 'z.ai'];

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

// The monitor API can report percentages outside [0, 100]; clamp at the
// read site. Non-finite or non-number input stays null. (No clamp inside
// toUsageWindow: wafer's overage branch deliberately exceeds 100.)
const clampUsedPercent = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

// Gift reset timestamps come as 'YYYY-MM-DD HH:mm:ss' in UTC+8.
const ZAI_RESET_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const parseZaiResetExpire = (value) => {
  // The pattern test coerces any non-string JSON value into a string that
  // cannot match, so only a real 'YYYY-MM-DD HH:mm:ss' value gets through.
  if (!ZAI_RESET_TIME_PATTERN.test(value)) return null;
  const timestamp = Date.parse(`${value.replace(' ', 'T')}+08:00`);
  return Number.isNaN(timestamp) ? null : timestamp;
};

// Keep only claimable resets: available, with a parseable, not-yet-expired
// time. The nearest expiry is the one worth activating first; expired records
// are pointless to show. (z.ai also flips `available` to false on expiry, so
// the check below stays a single condition.)
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
    }
  }
  return best;
};

const ZAI_GIFT_RESET_URL = 'https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL';
const ZAI_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const ZAI_WEEK_WINDOW_SECONDS = 7 * 24 * 60 * 60;

// Supplementary call: gift reset info must never fail the quota result.
const attachZaiGiftResets = async (windows, apiKey) => {
  try {
    const response = await fetch(ZAI_GIFT_RESET_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return;
    const payload = await readQuotaJson(response);
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

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

export const isConfigured = (auth) => Boolean(getApiKey(auth));

const ZAI_GIFT_RESET_USE_URL = 'https://api.z.ai/api/biz/customer-package-reset/use';
export const giftResetTypes = ['FIVE_HOUR', 'WEEK'];

export const useZaiGiftReset = async ({ recordId, resetType, readAuth = readOpenCodeCredentials }) => {
  const apiKey = getApiKey(await readAuth());

  if (!apiKey) {
    throw new Error('Not configured');
  }
  if (!Number.isFinite(recordId) || !giftResetTypes.includes(resetType)) {
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
      requestId: crypto.randomUUID()
    }),
    signal: AbortSignal.timeout(15_000)
  });

  const payload = await readQuotaJson(response).catch(() => null);
  if (!response.ok || payload?.success !== true) {
    throw new Error(payload?.msg || `API error: ${response.status}`);
  }
  return true;
};

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials } = {}) => {
  const apiKey = getApiKey(await readAuth());

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: timeoutSignal
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

    const payload = await readQuotaJson(response);
    // Like bigmodel.cn, z.ai reports an expired key or a missing plan as
    // `{code, msg, success: false}` with HTTP 200; without this the card is
    // just empty.
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
    // The API renamed TOKENS_LIMIT to CREDIT_LIMIT; field semantics stayed the same,
    // so both limit types map to the same windows.
    for (const limit of limits.filter((entry) => entry?.type === 'TOKENS_LIMIT' || entry?.type === 'CREDIT_LIMIT')) {
      const windowSeconds = resolveWindowSeconds(limit);
      const windowLabel = resolveWindowLabel(windowSeconds);
      const resetAt = limit?.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null;
      const usedPercent = clampUsedPercent(limit?.percentage);
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
        usedPercent: clampUsedPercent(mcpToolsTimeLimit.percentage),
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
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};
