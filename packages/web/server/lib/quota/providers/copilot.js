import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';

const buildCopilotWindows = (payload) => {
  const quota = payload?.quota_snapshots ?? {};
  const resetAt = toTimestamp(payload?.quota_reset_date);
  const windows = {};

  const addWindow = (label, snapshot) => {
    if (!snapshot) return;
    const entitlement = toNumber(snapshot.entitlement);
    const remaining = toNumber(snapshot.remaining);
    const usedPercent = entitlement && remaining !== null
      ? Math.max(0, 100 - (remaining / entitlement) * 100)
      : null;
    const valueLabel = entitlement !== null && remaining !== null
      ? `${remaining.toFixed(0)} / ${entitlement.toFixed(0)} left`
      : null;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel
    });
  };

  addWindow('chat', quota.chat);
  addWindow('completions', quota.completions);
  addWindow('premium', quota.premium_interactions);

  return windows;
};

const normalizeEnterpriseHost = (enterpriseUrl) => {
  if (typeof enterpriseUrl !== 'string' || !enterpriseUrl.trim()) {
    return null;
  }
  const raw = enterpriseUrl.trim();
  const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    const host = parsed.host.toLowerCase();
    if (!host || host === 'github.com') {
      return null;
    }
    return host;
  } catch {
    return null;
  }
};

const resolveCopilotQuotaUrl = (enterpriseHost) => {
  if (!enterpriseHost) {
    return 'https://api.github.com/copilot_internal/user';
  }
  return `https://${enterpriseHost}/api/v3/copilot_internal/user`;
};

const resolveProviderName = (baseName, enterpriseHost) => {
  if (!enterpriseHost) {
    return baseName;
  }
  return `${baseName} (${enterpriseHost})`;
};

export const providerId = 'github-copilot';
export const providerName = 'GitHub Copilot';
const aliases = ['github-copilot', 'copilot'];

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const enterpriseHost = normalizeEnterpriseHost(entry?.enterpriseUrl);
  const endpointUrl = resolveCopilotQuotaUrl(enterpriseHost);
  const resolvedProviderName = resolveProviderName(providerName, enterpriseHost);

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName: resolvedProviderName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName: resolvedProviderName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    return buildResult({
      providerId,
      providerName: resolvedProviderName,
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName: resolvedProviderName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};

export const providerIdAddon = 'github-copilot-addon';
export const providerNameAddon = 'GitHub Copilot Add-on';

export const fetchQuotaAddon = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;
  const enterpriseHost = normalizeEnterpriseHost(entry?.enterpriseUrl);
  const endpointUrl = resolveCopilotQuotaUrl(enterpriseHost);
  const resolvedProviderName = resolveProviderName(providerNameAddon, enterpriseHost);

  if (!accessToken) {
    return buildResult({
      providerId: providerIdAddon,
      providerName: resolvedProviderName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'X-Github-Api-Version': '2025-04-01'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId: providerIdAddon,
        providerName: resolvedProviderName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const windows = buildCopilotWindows(payload);
    const premium = windows.premium ? { premium: windows.premium } : windows;

    return buildResult({
      providerId: providerIdAddon,
      providerName: resolvedProviderName,
      ok: true,
      configured: true,
      usage: { windows: premium }
    });
  } catch (error) {
    return buildResult({
      providerId: providerIdAddon,
      providerName: resolvedProviderName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
