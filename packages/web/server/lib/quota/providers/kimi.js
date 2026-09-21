import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  durationToLabel,
  durationToSeconds
} from '../utils/index.js';

export const providerId = 'kimi-for-coding';
export const providerName = 'Kimi for Coding';
const aliases = ['kimi-for-coding', 'kimi'];

// Kimi's weekly `usage` block reports `used`; its rate-limit `limits[].detail`
// blocks report `remaining` instead. Neither field is guaranteed present, so
// derive usedPercent from whichever one the API actually returned.
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
    const response = await fetch('https://api.kimi.com/coding/v1/usages', {
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
    const windows = {};
    const usage = payload?.usage ?? null;
    if (usage) {
      const limit = toNumber(usage.limit);
      const used = toNumber(usage.used);
      const remaining = toNumber(usage.remaining);
      const usedPercent = computeUsedPercent(limit, used, remaining);
      windows.weekly = toUsageWindow({
        usedPercent,
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
      const total = toNumber(detail?.limit);
      const used = toNumber(detail?.used);
      const remaining = toNumber(detail?.remaining);
      const usedPercent = computeUsedPercent(total, used, remaining);
      windows[label] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt: toTimestamp(detail?.resetTime)
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
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
