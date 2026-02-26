// MiniMax Coding Plan Provider
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
      },
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

    const windows = {};
    const modelRemains = payload?.model_remains;

    if (Array.isArray(modelRemains) && modelRemains.length > 0) {
      const firstModel = modelRemains[0];
      const total = toNumber(firstModel?.current_interval_total_count);
      const used = 600 - toNumber(firstModel?.current_interval_usage_count);

      if (total === null || used === null) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'Missing required quota fields',
        });
      }

      const usedPercent =
        total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : null;

      const startTime = toTimestamp(firstModel?.start_time);
      const endTime = toTimestamp(firstModel?.end_time);
      const windowSeconds =
        startTime && endTime && endTime > startTime
          ? Math.floor((endTime - startTime) / 1000)
          : null;

      windows['5h'] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt: endTime,
      });
    } else {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No model quota data available',
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
