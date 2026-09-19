import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  asObject,
  formatMoney
} from '../utils/index.js';

export const providerId = 'openrouter';
export const providerName = 'OpenRouter';
export const aliases = ['openrouter'];
const OPENROUTER_QUOTA_URL = 'https://openrouter.ai/api/v1/key';
const PERIOD_SECONDS = { daily: 86400, weekly: 604800, monthly: 30 * 86400 };

export const resolveResetAt = (limitReset, nowMs) => {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (limitReset === 'daily') return Date.UTC(y, m, d + 1);
  if (limitReset === 'weekly') {
    const dow = now.getUTCDay();
    return Date.UTC(y, m, d + ((8 - dow) % 7 || 7));
  }
  if (limitReset === 'monthly') return Date.UTC(y, m + 1, 1);
  return null;
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

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(OPENROUTER_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Session expired — please re-authenticate with OpenRouter'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const data = asObject(payload?.data);

    if (data === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    if (data.is_management_key === true) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Management key configured — quota needs an inference API key'
      });
    }

    const limit = toNumber(data.limit);
    const limitRemaining = toNumber(data.limit_remaining);
    if (limit !== null && limitRemaining === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const usageMonthly = toNumber(data.usage_monthly);
    if (limit === null && usageMonthly === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const nowMs = Date.now();
    let windowKey;
    let windowSeconds;
    let resetAt;
    let usedPercent;
    let valueLabel;

    if (limit === null) {
      windowKey = 'monthly';
      windowSeconds = PERIOD_SECONDS.monthly;
      resetAt = resolveResetAt('monthly', nowMs);
      usedPercent = null;
      valueLabel = `$${formatMoney(usageMonthly)} spent`;
    } else {
      const used = Math.max(0, limit - limitRemaining);
      const percent = limit > 0 ? (used / limit) * 100 : null;
      usedPercent = percent === null ? null : Math.min(100, percent);
      valueLabel = `$${formatMoney(used)} / $${formatMoney(limit)}`;

      if (Object.hasOwn(PERIOD_SECONDS, data.limit_reset)) {
        windowKey = data.limit_reset;
        windowSeconds = PERIOD_SECONDS[data.limit_reset];
        resetAt = resolveResetAt(data.limit_reset, nowMs);
      } else {
        windowKey = 'credits';
        windowSeconds = null;
        resetAt = null;
      }
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {
          [windowKey]: toUsageWindow({
            usedPercent,
            windowSeconds,
            resetAt,
            valueLabel
          })
        }
      }
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
