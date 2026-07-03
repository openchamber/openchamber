import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
} from '../utils/index.js';

// Status 3 indicates the window is not applicable for the current plan tier.
const WINDOW_STATUS_INACTIVE = 3;

const TEXT_MODELS = ['general', 'chat', 'text'];

const pickChatModel = (modelRemains) => {
  if (!Array.isArray(modelRemains) || modelRemains.length === 0) return null;

  const m3Candidate = modelRemains.find(
    (m) => m?.model_name && /^minimax-m/i.test(m.model_name) && toNumber(m.current_interval_total_count) > 0
  );
  if (m3Candidate) return m3Candidate;

  const textCandidate = modelRemains.find(
    (m) => m?.model_name && TEXT_MODELS.includes(m.model_name.toLowerCase())
  );
  if (textCandidate) return textCandidate;

  const percentCandidate = modelRemains.find(
    (m) => typeof m?.current_interval_remaining_percent === 'number'
  );
  if (percentCandidate) return percentCandidate;

  return modelRemains[0];
};

const isUsablePayload = (payload) => {
  const baseResp = payload?.base_resp;
  if (baseResp && baseResp.status_code !== 0) return false;
  const rems = payload?.model_remains;
  return Array.isArray(rems) && rems.length > 0;
};

const fetchEndpoint = async (url, apiKey) => {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!isUsablePayload(payload)) return null;
    return payload;
  } catch {
    return null;
  }
};

const coercePercent = (value) => {
  const n = toNumber(value);
  return n !== null ? Math.max(0, Math.min(100, n)) : null;
};

/**
 * Check if a window (interval or weekly) is active for the current plan.
 * Status 3 means the window is not applicable (e.g. legacy plans without weekly limits).
 * When the status field is absent, default to active.
 */
const isWindowActive = (status) => {
  const n = toNumber(status);
  return n === null || n !== WINDOW_STATUS_INACTIVE;
};

/**
 * Calculate window duration in seconds from API timestamps or remains_time.
 * MiniMax API returns remains_time in milliseconds (confirmed via live API testing:
 * 9664502 ms = 2.68h in a 5h window, consistent with remaining_percent).
 */
const calculateWindowSeconds = (startAt, resetAt, remainsTimeMs) => {
  if (startAt && resetAt && resetAt > startAt) {
    return Math.floor((resetAt - startAt) / 1000);
  }
  if (remainsTimeMs && remainsTimeMs > 0) {
    return Math.floor(remainsTimeMs / 1000);
  }
  return null;
};

const calculateUsage = (model, isTokenPlan) => {
  const intervalTotal = toNumber(model.current_interval_total_count);
  const intervalUsageRaw = toNumber(model.current_interval_usage_count);
  const intervalStartAt = toTimestamp(model.start_time);
  const intervalResetAt = toTimestamp(model.end_time);
  const intervalRemainsTime = toNumber(model.remains_time);
  const intervalRemainingPercent = coercePercent(model.current_interval_remaining_percent);

  const weeklyTotal = toNumber(model.current_weekly_total_count);
  const weeklyUsageRaw = toNumber(model.current_weekly_usage_count);
  const weeklyStartAt = toTimestamp(model.weekly_start_time);
  const weeklyResetAt = toTimestamp(model.weekly_end_time);
  const weeklyRemainsTime = toNumber(model.weekly_remains_time);
  const weeklyRemainingPercent = coercePercent(model.current_weekly_remaining_percent);

  let intervalUsedPercent = null;
  if (intervalRemainingPercent !== null) {
    intervalUsedPercent = 100 - intervalRemainingPercent;
  } else if (intervalTotal > 0 && intervalUsageRaw !== null) {
    const intervalUsed = isTokenPlan
      ? Math.max(0, intervalTotal - intervalUsageRaw)
      : intervalUsageRaw;
    intervalUsedPercent = Math.max(0, Math.min(100, (intervalUsed / intervalTotal) * 100));
  }

  let weeklyUsedPercent = null;
  if (weeklyRemainingPercent !== null) {
    weeklyUsedPercent = 100 - weeklyRemainingPercent;
  } else if (weeklyTotal > 0 && weeklyUsageRaw !== null) {
    const weeklyUsed = isTokenPlan
      ? Math.max(0, weeklyTotal - weeklyUsageRaw)
      : weeklyUsageRaw;
    weeklyUsedPercent = Math.max(0, Math.min(100, (weeklyUsed / weeklyTotal) * 100));
  }

  const intervalWindowSeconds = calculateWindowSeconds(intervalStartAt, intervalResetAt, intervalRemainsTime);
  const weeklyWindowSeconds = calculateWindowSeconds(weeklyStartAt, weeklyResetAt, weeklyRemainsTime);

  return {
    intervalUsedPercent,
    intervalWindowSeconds,
    intervalResetAt,
    weeklyUsedPercent,
    weeklyWindowSeconds,
    weeklyResetAt,
  };
};

export const createMiniMaxCodingPlanProvider = ({ providerId, providerName, aliases, tokenPlanUrl, codingPlanUrl }) => {
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
      let payload = await fetchEndpoint(tokenPlanUrl, apiKey);
      let isTokenPlan = true;

      if (!payload) {
        payload = await fetchEndpoint(codingPlanUrl, apiKey);
        isTokenPlan = false;
      }

      if (!payload) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'API returned no usable quota data',
        });
      }

      const model = pickChatModel(payload.model_remains);
      if (!model) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'No model quota data available',
        });
      }

      const {
        intervalUsedPercent,
        intervalWindowSeconds,
        intervalResetAt,
        weeklyUsedPercent,
        weeklyWindowSeconds,
        weeklyResetAt,
      } = calculateUsage(model, isTokenPlan);

      const windows = {
        '5h': toUsageWindow({
          usedPercent: intervalUsedPercent,
          windowSeconds: intervalWindowSeconds,
          resetAt: intervalResetAt,
        }),
      };

      // Only include the weekly window when the plan tier supports it.
      // Status 3 = not applicable (e.g. legacy Coding Plan without weekly limits).
      const weeklyActive = isWindowActive(model.current_weekly_status);
      const hasWeeklyData =
        weeklyActive &&
        (coercePercent(model.current_weekly_remaining_percent) !== null ||
          toNumber(model.current_weekly_total_count) > 0);

      if (hasWeeklyData) {
        windows.weekly = toUsageWindow({
          usedPercent: weeklyUsedPercent,
          windowSeconds: weeklyWindowSeconds,
          resetAt: weeklyResetAt,
        });
      }

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
