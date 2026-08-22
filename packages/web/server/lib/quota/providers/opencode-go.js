import { readAuthFile } from '../../opencode/auth.js';
import { deleteLegacyOpenCodeGoCredential } from '../credentials/store.js';
import { buildResult, getAuthEntry, normalizeAuthEntry, toUsageWindow } from '../utils/index.js';

export const providerId = 'opencode-go';
export const providerName = 'OpenCode Go';
export const aliases = ['opencode-go'];

const windowsByApiKey = {
  '5h': 'rolling',
  weekly: 'weekly',
  monthly: 'monthly',
};

export const parseOpenCodeGoUsage = (payload) => {
  const usage = payload && typeof payload === 'object' ? payload.usage : null;
  if (!usage || typeof usage !== 'object') return {};
  const windows = {};
  for (const [key, apiKey] of Object.entries(windowsByApiKey)) {
    const entry = usage[apiKey];
    if (!entry || typeof entry !== 'object') continue;
    const usedPercent = entry.percent;
    const resetAt = entry.resetsAt;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) continue;
    if (typeof resetAt !== 'string' || !Number.isFinite(new Date(resetAt).getTime())) continue;
    windows[key] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetAt,
      windowSeconds: null,
    });
  }
  return windows;
};

export const fetchOpenCodeGoUsage = async (apiKey, fetchImpl = fetch) => {
  const response = await fetchImpl('https://opencode.ai/zen/go/v1/usage', {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'OpenChamber quota provider',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('OpenCode Go authentication failed');
  }
  if (!response.ok) throw new Error(`OpenCode Go usage API returned HTTP ${response.status}`);
  const windows = parseOpenCodeGoUsage(await response.json().catch(() => null));
  if (Object.keys(windows).length === 0) throw new Error('OpenCode Go usage data could not be parsed');
  return windows;
};

const getApiKey = () => {
  const entry = normalizeAuthEntry(getAuthEntry(readAuthFile(), aliases));
  return entry?.key ?? entry?.token ?? null;
};

export const isConfigured = () => Boolean(getApiKey());

export const fetchQuota = async () => {
  try {
    deleteLegacyOpenCodeGoCredential();
    const apiKey = getApiKey();
    if (!apiKey) return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
    const windows = await fetchOpenCodeGoUsage(apiKey);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows } });
  } catch (error) {
    return buildResult({ providerId, providerName, ok: false, configured: true, error: error instanceof Error ? error.message : 'Request failed' });
  }
};
