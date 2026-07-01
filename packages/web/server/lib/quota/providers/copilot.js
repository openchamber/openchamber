import fs from 'fs';
import path from 'path';
import os from 'os';

import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  getLegacyOpenCodePath
} from '../utils/index.js';

const COPILOT_VERSION = '0.35.0';
const COPILOT_HEADERS = {
  'User-Agent': `GitHubCopilotChat/${COPILOT_VERSION}`,
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': `copilot-chat/${COPILOT_VERSION}`,
  'Copilot-Integration-Id': 'vscode-chat'
};

const COPILOT_PLAN_LIMITS = {
  free: 50,
  pro: 300,
  'pro+': 1500,
  business: 300,
  enterprise: 1000
};

const COPILOT_OAUTH_ENDPOINT = 'https://api.github.com/copilot_internal/user';
const COPILOT_OAUTH_TOKEN_ENDPOINT = 'https://api.github.com/copilot_internal/v2/token';

const copilotResetCountdown = (date) => {
  const resetAt = toTimestamp(date);
  if (resetAt === null) return null;
  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) return 'resets soon';
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
};

const buildCopilotWindow = (label, snapshot, suffix, trendKey) => {
  if (!snapshot) return null;
  if (snapshot.unlimited) {
    return toUsageWindow({
      usedPercent: 0,
      windowSeconds: null,
      resetAt: null,
      detail: ['Used: Unlimited'],
      suffix,
      trendKey
    });
  }
  const entitlement = toNumber(snapshot.entitlement);
  const remaining = toNumber(snapshot.remaining);
  const percentRemaining = toNumber(snapshot.percent_remaining);
  const used = entitlement !== null && remaining !== null
    ? Math.max(0, entitlement - remaining)
    : null;
  // Canonical uses percent_remaining directly; fall back to derived only when
  // the API omits it (defensive, matches canonical copilotWindow math).
  const usedPercent = percentRemaining !== null
    ? Math.max(0, 100 - percentRemaining)
    : (entitlement && remaining !== null
      ? Math.max(0, 100 - (remaining / entitlement) * 100)
      : null);
  const valueLabel = used !== null && entitlement !== null
    ? `${used.toFixed(0)} / ${entitlement.toFixed(0)}`
    : null;
  return toUsageWindow({
    usedPercent,
    windowSeconds: null,
    resetAt: null,
    valueLabel,
    detail: valueLabel ? [`Used: ${valueLabel}`] : null,
    suffix,
    trendKey
  });
};

const buildCopilotWindows = (payload) => {
  const snaps = payload?.quota_snapshots ?? {};
  const resetAt = toTimestamp(payload?.quota_reset_date);
  const resetText = copilotResetCountdown(payload?.quota_reset_date);
  const windows = {};

  // Canonical order: premium first, then chat/completions only when present
  // and not unlimited.
  const premium = buildCopilotWindow('premium', snaps.premium_interactions, 'premium', 'github-copilot:premium');
  if (premium) windows.premium = premium;

  if (snaps.chat && !snaps.chat.unlimited) {
    const chat = buildCopilotWindow('chat', snaps.chat, 'chat', 'github-copilot:chat');
    if (chat) windows.chat = chat;
  }
  if (snaps.completions && !snaps.completions.unlimited) {
    const completions = buildCopilotWindow('completions', snaps.completions, 'completions', 'github-copilot:completions');
    if (completions) windows.completions = completions;
  }

  // Attach reset info + overage to every window (canonical footer is shared).
  const overage = toNumber(snaps.premium_interactions?.overage_count);
  const extra = [];
  if (overage !== null && overage > 0) {
    extra.push(`Overage: ${overage.toFixed(0)} requests`);
  }
  for (const key of Object.keys(windows)) {
    const w = windows[key];
    windows[key] = {
      ...w,
      resetAt,
      resetText,
      ...(extra.length ? { extra } : {})
    };
  }

  return windows;
};

const readCopilotPAT = () => {
  const filePath = getLegacyOpenCodePath('copilot-quota-token.json');
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.token && cfg.username && cfg.tier) return cfg;
  } catch {
    // unreadable / malformed — skip silently, matches canonical readCopilotPAT
  }
  return null;
};

const buildPatWindows = (billing, pat) => {
  const limit = COPILOT_PLAN_LIMITS[pat.tier] ?? 300;
  const totalUsed = (billing.usageItems ?? [])
    .filter((i) => i.sku && i.sku.includes('Premium'))
    .reduce((s, i) => s + (toNumber(i.grossQuantity) ?? 0), 0);
  const remaining = Math.max(0, limit - totalUsed);
  const pct = Math.round((remaining / limit) * 100);
  const period = billing.timePeriod?.month
    ? `${billing.timePeriod.year}-${String(billing.timePeriod.month).padStart(2, '0')}`
    : String(billing.timePeriod?.year ?? '');

  const windows = {
    premium: toUsageWindow({
      usedPercent: Math.max(0, 100 - pct),
      windowSeconds: null,
      resetAt: null,
      valueLabel: `${totalUsed.toFixed(0)} / ${limit.toFixed(0)}`,
      detail: [`Used: ${totalUsed.toFixed(0)} / ${limit.toFixed(0)}`],
      suffix: 'premium',
      trendKey: 'github-copilot:premium',
      extra: [`Billing period: ${period}`]
    })
  };
  return windows;
};

export const providerId = 'github-copilot';
export const providerName = 'GitHub Copilot';
const aliases = ['github-copilot', 'copilot'];

export const isConfigured = () => {
  if (readCopilotPAT()) return true;
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token || entry?.refresh);
};

const fetchQuotaViaOAuth = async (accessToken) => {
  const direct = await fetch(COPILOT_OAUTH_ENDPOINT, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `token ${accessToken}`,
      ...COPILOT_HEADERS
    }
  });

  if (direct.ok) {
    const payload = await direct.json();
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: buildCopilotWindows(payload), subtitle: 'Copilot subscription' }
    });
  }

  // Canonical OAuth fallback: exchange refresh token, then retry with the
  // exchanged token. OpenCode's OAuth scope usually lacks quota access, so
  // this path commonly fails — surface the PAT guidance error.
  const exchRes = await fetch(COPILOT_OAUTH_TOKEN_ENDPOINT, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...COPILOT_HEADERS
    }
  });

  if (exchRes.ok) {
    const exchData = await exchRes.json();
    const afterExch = await fetch(COPILOT_OAUTH_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${exchData.token}`,
        ...COPILOT_HEADERS
      }
    });
    if (afterExch.ok) {
      const payload = await afterExch.json();
      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: { windows: buildCopilotWindows(payload), subtitle: 'Copilot subscription' }
      });
    }
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: `Copilot API error after token exchange (${afterExch.status})`
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: false,
    configured: true,
    error:
      'GitHub Copilot quota unavailable via OAuth. OpenCode\'s OAuth integration doesn\'t expose the quota API scope. ' +
      'Create a fine-grained PAT with Plan -> Read-only permission and save to ' +
      `${getLegacyOpenCodePath('copilot-quota-token.json')} ` +
      '({"token": "github_pat_...", "username": "YourUsername", "tier": "pro"})'
  });
};

const fetchQuotaViaPAT = async (pat) => {
  const response = await fetch(
    `https://api.github.com/users/${pat.username}/settings/billing/premium_request/usage`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${pat.token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }
  );

  if (!response.ok) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: `Billing API error (${response.status})`
    });
  }

  const billing = await response.json();
  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: { windows: buildPatWindows(billing, pat), subtitle: 'Copilot subscription' }
  });
};

export const fetchQuota = async () => {
  // PAT takes precedence (canonical queryCopilot checks PAT first).
  const pat = readCopilotPAT();
  if (pat) {
    try {
      return await fetchQuotaViaPAT(pat);
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : 'Request failed'
      });
    }
  }

  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const accessToken = entry?.access ?? entry?.token ?? entry?.refresh;

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
    return await fetchQuotaViaOAuth(accessToken);
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
  const result = await fetchQuota();
  if (!result.ok) {
    return {
      ...result,
      providerId: providerIdAddon,
      providerName: providerNameAddon
    };
  }
  const windows = result.usage?.windows ?? {};
  const premium = windows.premium ? { premium: windows.premium } : windows;
  return buildResult({
    providerId: providerIdAddon,
    providerName: providerNameAddon,
    ok: true,
    configured: true,
    usage: { windows: premium, subtitle: 'Copilot add-on' }
  });
};