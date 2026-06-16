import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  resolveWindowLabel,
  asNonEmptyString,
  loginWithAuthCheck,
} from '../utils/index.js';

import { isJsonMode, isQuietMode, printJson, log } from '../../../../bin/cli-output.js';

export const providerId = 'wafer';
export const providerName = 'Wafer.ai';
export const aliases = ['wafer', 'wafer-ai', 'wafer_ai', 'wafer.ai'];

const WAFER_QUOTA_URL = 'https://pass.wafer.ai/v1/inference/quota';
const WAFER_WINDOW_SECONDS = 5 * 3600;

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const login = async (options = {}) =>
  loginWithAuthCheck({ options, id: providerId, name: providerName, aliases });

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

    const payload = await response.json();
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
    const usedPercent = hasOverage
      ? Math.max(0, usedPercentRaw ?? 0)
      : Math.max(0, Math.min(100, usedPercentRaw ?? 0));

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
