import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  resolveWindowSeconds,
  resolveWindowLabel,
  normalizeTimestamp
} from '../utils/index.js';

export const providerId = 'zai-coding-plan';
export const providerName = 'z.ai';
const aliases = ['zai-coding-plan', 'zai', 'z.ai'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const buildZaiWindows = (limits) => {
  const windows = {};
  for (const limit of Array.isArray(limits) ? limits : []) {
    if (limit?.type !== 'TOKENS_LIMIT') continue;
    const windowSeconds = resolveWindowSeconds(limit);
    if (windowSeconds === null) continue;
    const label = resolveWindowLabel(windowSeconds);
    windows[label] = toUsageWindow({
      usedPercent: typeof limit.percentage === 'number' ? limit.percentage : null,
      windowSeconds,
      resetAt: limit.nextResetTime ? normalizeTimestamp(limit.nextResetTime) : null
    });
  }
  return windows;
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
    const windows = buildZaiWindows(payload?.data?.limits);

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
