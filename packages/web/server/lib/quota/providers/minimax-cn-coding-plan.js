// MiniMax Coding Plan Provider (minimaxi.com)
import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
} from '../utils/index.js';

export const providerId = 'minimax-cn-coding-plan';
export const providerName = 'MiniMax Coding Plan (minimaxi.com)';
export const aliases = ['minimax-cn-coding-plan'];

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
      error: 'Not configured',
    });
  }

  try {
    const response = await fetch(
      'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
      });
    }

    const payload = await response.json();
    const baseResp = payload?.base_resp;
    if (baseResp && baseResp.status_code !== 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: baseResp.status_msg || `API error: ${baseResp.status_code}`,
      });
    }

    const firstModel = payload?.model_remains?.[0];
    if (!firstModel) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No model quota data available',
      });
    }

    const intervalTotal = toNumber(firstModel.current_interval_total_count);
    const intervalUsage = toNumber(firstModel.current_interval_usage_count);
    const intervalStartAt = toTimestamp(firstModel.start_time);
    const intervalResetAt = toTimestamp(firstModel.end_time);
    const weeklyTotal = toNumber(firstModel.current_weekly_total_count);
    const weeklyUsage = toNumber(firstModel.current_weekly_usage_count);
    const weeklyStartAt = toTimestamp(firstModel.weekly_start_time);
    const weeklyResetAt = toTimestamp(firstModel.weekly_end_time);

    const intervalUsed = intervalTotal - intervalUsage;
    const weeklyUsed = weeklyUsage;

    const intervalUsedPercent =
      intervalTotal > 0 && intervalUsed != null
        ? Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100))
        : null;
    const intervalWindowSeconds =
      intervalStartAt && intervalResetAt && intervalResetAt > intervalStartAt
        ? Math.floor((intervalResetAt - intervalStartAt) / 1000)
        : null;
    const weeklyUsedPercent =
      weeklyTotal > 0 && weeklyUsed != null
        ? Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100))
        : null;
    const weeklyWindowSeconds =
      weeklyStartAt && weeklyResetAt && weeklyResetAt > weeklyStartAt
        ? Math.floor((weeklyResetAt - weeklyStartAt) / 1000)
        : null;

    const windows = {
      '5h': toUsageWindow({
        usedPercent: intervalUsedPercent,
        windowSeconds: intervalWindowSeconds,
        resetAt: intervalResetAt,
      }),
      weekly: toUsageWindow({
        usedPercent: weeklyUsedPercent,
        windowSeconds: weeklyWindowSeconds,
        resetAt: weeklyResetAt,
      }),
    };

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
