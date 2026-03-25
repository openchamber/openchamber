import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
} from '../utils/index.js';

export const createMiniMaxCodingPlanProvider = ({ providerId, providerName, aliases, endpoint }) => {
  const isConfigured = () => {
    const auth = readAuthFile();
    const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
    return Boolean(entry?.key || entry?.token);
  };

  const fetchQuota = async () => {
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
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

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

      const targetModel = payload?.model_remains?.find((item) => item?.model_name === 'MiniMax-M*');
      if (!targetModel) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'No MiniMax-M* quota data available',
        });
      }

      const intervalTotal = toNumber(targetModel.current_interval_total_count);
      const intervalUsage = toNumber(targetModel.current_interval_usage_count);
      const intervalStartAt = toTimestamp(targetModel.start_time);
      const intervalResetAt = toTimestamp(targetModel.end_time);
      const weeklyTotal = toNumber(targetModel.current_weekly_total_count);
      const weeklyUsage = toNumber(targetModel.current_weekly_usage_count);
      const weeklyStartAt = toTimestamp(targetModel.weekly_start_time);
      const weeklyResetAt = toTimestamp(targetModel.weekly_end_time);
      const intervalUsed = intervalTotal - intervalUsage;
      const weeklyUsed = weeklyTotal - weeklyUsage;
      const intervalUsedPercent =
        intervalTotal > 0 ? Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100)) : null;
      const intervalWindowSeconds =
        intervalStartAt && intervalResetAt && intervalResetAt > intervalStartAt
          ? Math.floor((intervalResetAt - intervalStartAt) / 1000)
          : null;
      const weeklyUsedPercent =
        weeklyTotal > 0 ? Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100)) : null;
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

  return {
    providerId,
    providerName,
    aliases,
    isConfigured,
    fetchQuota,
  };
};
