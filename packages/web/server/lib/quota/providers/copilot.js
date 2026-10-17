import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  formatCredits
} from '../utils/index.js';

const buildCopilotWindows = (payload) => {
  const quota = payload?.quota_snapshots ?? {};
  const resetAt = toTimestamp(payload?.quota_reset_date);
  const windows = {};

  // Mirrors the quota semantics of microsoft/vscode-copilot-chat
  // (CopilotUserQuotaInfo): each snapshot carries entitlement, remaining,
  // unlimited, and percent_remaining. Unlimited plans report no usable
  // entitlement; percent_remaining is a server-computed fallback.
  // `usedPercent` is computed from remaining/entitlement, and the value label
  // derives its credits from the same `entitlement - quota_remaining` axis
  // GitHub's own Copilot panel uses, so the percent and the label agree.
  const addWindow = (label, snapshot) => {
    if (!snapshot) return;

    if (snapshot.unlimited === true) {
      windows[label] = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt,
        valueLabel: 'Unlimited'
      });
      return;
    }

    const entitlement = toNumber(snapshot.entitlement);
    // `quota_remaining` is the precise twin of `remaining`: the endpoint sends it
    // with one decimal (39078.5) and truncates it into `remaining` (39078).
    // GitHub's own Copilot panel reports the used figure as
    // `entitlement - quota_remaining` (60,000 - 39,078.5 = 20,921.5 used),
    // so prefer it and fall back to the integer twin.
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
    // `remaining` reports the axis opposite to everything else the quota UI
    // renders (the percent above, the progress bar, the used/remaining toggle),
    // so the old `remaining / entitlement left` label made OpenChamber state the
    // opposite of GitHub's own Copilot panel for the same account. VS Code and
    // GitHub both report `entitlement - quota_remaining` spent, so the label
    // uses that axis and keeps the fractional credit rather than rounding it
    // away, which also keeps it stable across the two twin fields.
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

// A Copilot login on GitHub Enterprise Server carries `enterpriseUrl`, and that
// server hosts its own quota endpoint. Only a bare origin with a plausible DNS
// hostname is accepted, so a value that is not a usable host is refused here
// rather than turned into a request that carries the credential.
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
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) }
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
    return buildResult({
      providerId: providerIdAddon,
      providerName: providerNameAddon,
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload) }
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
