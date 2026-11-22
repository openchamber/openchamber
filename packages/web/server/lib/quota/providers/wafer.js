import { readQuotaJson } from '../utils/response-body.js';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'wafer';
export const providerName = 'Wafer.ai';
export const aliases = ['wafer', 'wafer-ai', 'wafer_ai', 'wafer.ai'];

const WAFER_QUOTA_URL = 'https://pass.wafer.ai/v1/inference/quota';
const WAFER_WINDOW_SECONDS = 5 * 3600;

const getApiKey = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token);
};

export const isConfigured = (auth) => Boolean(getApiKey(auth));

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
  const apiKey = getApiKey(auth);

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
    const response = await fetch(WAFER_QUOTA_URL, {
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
        error: `API error: ${response.status}`
      });
    }

    const payload = await readQuotaJson(response);
    const remaining = toNumber(payload?.remaining_included_requests);
    const limit = toNumber(payload?.included_request_limit);
    const overage = toNumber(payload?.overage_request_count);
    const usedPercentRaw = toNumber(payload?.current_period_used_percent);
    const windowStart = toTimestamp(payload?.window_start);
    const windowEnd = toTimestamp(payload?.window_end);
    const planTier = asNonEmptyString(payload?.plan_tier);

    if (remaining === null && limit === null && overage === null && usedPercentRaw === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const hasOverage = overage !== null && overage > 0;
    // A present percent keeps the deliberate overage behaviour (no 100 clamp
    // when overage is present). An absent percent must not be fabricated as
    // 0: derive it from the remaining/limit counts in the same payload when
    // both are present, and report null when there is nothing to derive from.
    let usedPercent = null;
    if (usedPercentRaw !== null) {
      usedPercent = hasOverage
        ? Math.max(0, usedPercentRaw)
        : Math.max(0, Math.min(100, usedPercentRaw));
    } else if (remaining !== null && limit !== null && limit > 0) {
      usedPercent = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
    }

    const windowSeconds = windowStart !== null && windowEnd !== null
      ? Math.round((windowEnd - windowStart) / 1000)
      : WAFER_WINDOW_SECONDS;
    const windowLabel = resolveWindowLabel(windowSeconds);

    let valueLabel = null;
    if (remaining !== null && limit !== null) {
      const parts = [];
      if (planTier) parts.push(planTier);
      parts.push(`${remaining} / ${limit} left`);
      if (hasOverage) parts.push(`+${overage} overage`);
      valueLabel = parts.join(' · ');
    }

    const windows = {};
    windows[windowLabel] = toUsageWindow({
      usedPercent,
      windowSeconds,
      resetAt: windowEnd,
      valueLabel
    });

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
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
