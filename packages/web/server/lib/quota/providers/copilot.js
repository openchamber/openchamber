import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  asNonEmptyString,
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  formatCredits
} from '../utils/index.js';

const resolveCopilotPlanLabel = (payload) => {
  if (!payload) return null;
  const sku = asNonEmptyString(payload.access_type_sku);
  const plan = asNonEmptyString(payload.copilot_plan);
  const canSignup = Boolean(payload.can_signup_for_limited);

  if (sku === 'free_limited_copilot') return 'Copilot Free';
  if (sku === 'free_educational_quota') return 'Copilot Student';
  if (plan === 'individual_edu') return 'Copilot Student';
  if (plan === 'individual') return 'Copilot Pro';
  if (plan === 'individual_pro') return 'Copilot Pro+';
  if (plan === 'individual_max') return 'Copilot Max';
  if (plan === 'business') return 'Copilot Business';
  if (plan === 'enterprise') return 'Copilot Enterprise';
  if (canSignup) return 'Copilot Free';
  return null;
};

const buildCopilotWindows = (payload) => {
  const quota = payload?.quota_snapshots ?? {};
  const resetAt = toTimestamp(payload?.quota_reset_date);
  const windows = {};

  // external: https://github.com/microsoft/vscode-copilot-chat CopilotUserQuotaInfo uses percent_remaining when entitlement is unusable.
  const addWindow = (label, snapshot) => {
    if (!snapshot) return;

    if (snapshot.unlimited === true) {
      const creditsUsed = toNumber(typeof snapshot.credits_used === 'string'
        ? asNonEmptyString(snapshot.credits_used)
        : snapshot.credits_used);
      const showCreditsUsed = snapshot.has_quota !== false && creditsUsed !== null && creditsUsed >= 0;
      windows[label] = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt,
        valueLabel: showCreditsUsed ? null : 'Unlimited',
        creditsUsed: showCreditsUsed ? creditsUsed : undefined
      });
      return;
    }

    const entitlement = toNumber(snapshot.entitlement);
    // external: https://github.com/microsoft/vscode-copilot-chat Copilot derives spent credits from entitlement minus fractional quota_remaining.
    const remaining = toNumber(snapshot.quota_remaining) ?? toNumber(snapshot.remaining);
    let usedPercent = entitlement !== null && entitlement > 0 && remaining !== null
      ? Math.min(100, Math.max(0, 100 - (remaining / entitlement) * 100))
      : null;
    if (usedPercent === null) {
      const percentRemaining = toNumber(snapshot.percent_remaining);
      if (percentRemaining !== null) {
        usedPercent = Math.min(100, Math.max(0, 100 - percentRemaining));
      }
    }
    const used = entitlement === null || entitlement <= 0
      ? null
      : remaining !== null
        ? Math.max(0, Math.min(entitlement, entitlement - remaining))
        : null;
    const valueLabel = used === null
      ? null
      : `${formatCredits(used)} / ${formatCredits(entitlement)} used`;
    windows[label] = toUsageWindow({
      usedPercent,
      windowSeconds: null,
      resetAt,
      valueLabel
    });
  };

  addWindow('premium_interactions', quota.premium_interactions);

  return windows;
};

export const providerId = 'github-copilot';
export const providerName = 'GitHub Copilot';
const aliases = ['github-copilot', 'copilot'];

const INVALID_COPILOT_ENTERPRISE_URL = 'Invalid GitHub Copilot Enterprise URL';

const COPILOT_ENTERPRISE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const copilotUserUrl = (enterpriseUrl) => {
  const host = `${enterpriseUrl ?? ''}`.trim();
  if (!host) return 'https://api.github.com/copilot_internal/user';

  const url = new URL(host.includes('://') ? host : `https://${host}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(INVALID_COPILOT_ENTERPRISE_URL);
  if (url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(INVALID_COPILOT_ENTERPRISE_URL);
  }
  if (!COPILOT_ENTERPRISE_HOST.test(url.hostname)) throw new Error(INVALID_COPILOT_ENTERPRISE_URL);

  return `https://api.${url.hostname}/copilot_internal/user`;
};

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async () => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;

  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch(copilotUserUrl(entry?.enterpriseUrl), {
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
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const planLabel = resolveCopilotPlanLabel(payload);
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) },
      planLabel
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

export const providerIdAddon = 'github-copilot-addon';
export const providerNameAddon = 'GitHub Copilot Add-on';

export const fetchQuotaAddon = async () => {
  const auth = await readOpenCodeCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token;

  if (!accessToken) {
    return buildResult({
      providerId: providerIdAddon,
      providerName: providerNameAddon,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const response = await fetch(copilotUserUrl(entry?.enterpriseUrl), {
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
        providerName: providerNameAddon,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const planLabel = resolveCopilotPlanLabel(payload);
    return buildResult({
      providerId: providerIdAddon,
      providerName: providerNameAddon,
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) },
      planLabel
    });
  } catch (error) {
    return buildResult({
      providerId: providerIdAddon,
      providerName: providerNameAddon,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
