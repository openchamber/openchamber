import { readAuthFile } from '../../opencode/auth.js';
import { readConfig } from '../../opencode/shared.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  normalizeTimestamp
} from '../utils/index.js';

export const providerId = 'kiro';
export const providerName = 'Kiro';
const aliases = ['kiro'];

function getKiroConfig() {
  const config = readConfig(null);
  const providerOpts = config?.provider?.kiro?.options;
  const baseURL = providerOpts?.baseURL || null;
  const configApiKey = providerOpts?.apiKey || null;

  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key || entry?.token || configApiKey;

  return { apiKey, baseURL };
}

export const isConfigured = () => {
  const { apiKey, baseURL } = getKiroConfig();
  return Boolean(apiKey && baseURL);
};

export const fetchQuota = async () => {
  const { apiKey, baseURL } = getKiroConfig();

  if (!apiKey || !baseURL) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const url = `${baseURL.replace(/\/$/, '')}/credits`;
    const response = await fetch(url, {
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
    const credits = payload?.credits;

    if (!credits) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No usage data returned'
      });
    }

    const usageLimit = credits.limit ?? 0;
    const currentUsage = credits.used ?? 0;
    const usedPercent = usageLimit > 0 ? (currentUsage / usageLimit) * 100 : null;
    const resetAt = normalizeTimestamp(payload.next_reset);

    let valueLabel = `${Math.round(currentUsage)} / ${usageLimit} credits`;
    if (credits.overage > 0 && typeof credits.overage_charges_usd === 'number') {
      valueLabel += ` · $${credits.overage_charges_usd.toFixed(2)} overage`;
    }

    const windows = {
      credits: toUsageWindow({
        usedPercent,
        windowSeconds: null,
        resetAt,
        valueLabel
      })
    };

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
