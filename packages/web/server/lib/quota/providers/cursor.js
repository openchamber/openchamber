import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { readManagedCredential, writeManagedCredential } from '../credentials/providers.js';
import {
  buildResult,
  formatMoney,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../utils/index.js';

const BASE_URL = 'https://api2.cursor.sh';
const USAGE_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const PLAN_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetPlanInfo`;
const HARD_LIMIT_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetHardLimit`;
const TEAM_SPEND_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetTeamSpend`;
const ME_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetMe`;
const AUTH_USAGE_URL = `${BASE_URL}/auth/usage`;
const STRIPE_PROFILE_URL = `${BASE_URL}/auth/full_stripe_profile`;
const CREDITS_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetCreditGrantsBalance`;
const REFRESH_URL = `${BASE_URL}/oauth/token`;
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const STATE_DB = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

export const providerId = 'cursor';
export const providerName = 'Cursor';
const aliases = ['cursor'];

const readJwtPayload = (token) => {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const readStateValue = (key) => {
  if (!existsSync(STATE_DB)) return null;
  try {
    const escapedKey = String(key).replace(/'/g, "''");
    const rows = execFileSync('sqlite3', [
      '-json',
      STATE_DB,
      `SELECT value FROM ItemTable WHERE key = '${escapedKey}' LIMIT 1;`
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(rows || '[]');
    const value = parsed?.[0]?.value;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
};

const readFileToken = (path) => {
  try {
    if (!path || !existsSync(path)) return null;
    const content = readFileSync(path, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
};

const loadAuthState = () => {
  const envAccessToken = process.env.CURSOR_TOKEN || process.env.CURSOR_ACCESS_TOKEN || null;
  const envRefreshToken = process.env.CURSOR_REFRESH_TOKEN || null;
  const accessTokenPath = process.env.CURSOR_TOKEN_FILE || null;
  const refreshTokenPath = process.env.CURSOR_REFRESH_TOKEN_FILE || null;
  const fileAccessToken = readFileToken(accessTokenPath);
  const fileRefreshToken = readFileToken(refreshTokenPath);

  if (envAccessToken || envRefreshToken) {
    return {
      accessToken: envAccessToken,
      refreshToken: envRefreshToken,
      source: 'env'
    };
  }

  if (fileAccessToken || fileRefreshToken) {
    return {
      accessToken: fileAccessToken,
      refreshToken: fileRefreshToken,
      source: 'file'
    };
  }

  const managed = readManagedCredential(providerId);
  return {
    accessToken: managed?.accessToken || null,
    refreshToken: managed?.refreshToken || null,
    source: 'managed'
  };
};

const tokenNeedsRefresh = (token) => {
  if (!token) return true;
  const payload = readJwtPayload(token);
  const expiresAt = typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  return !expiresAt || expiresAt - Date.now() <= REFRESH_BUFFER_MS;
};

const persistAccessToken = (auth, accessToken) => {
  if (auth.source === 'managed') writeManagedCredential(providerId, { accessToken, refreshToken: auth.refreshToken || '' });
};

export const importCursorCredential = async () => {
  const credential = {
    accessToken: readStateValue('cursorAuth/accessToken') || '',
    refreshToken: readStateValue('cursorAuth/refreshToken') || '',
  };
  if (!credential.accessToken && !credential.refreshToken) throw new Error('Cursor credentials are unavailable');
  const accessToken = await resolveCredentialAccessToken({ ...credential, source: 'import' });
  if (!accessToken) throw new Error('Cursor credentials are invalid');
  return writeManagedCredential(providerId, { ...credential, accessToken });
};

const refreshAccessToken = async (auth) => {
  if (!auth.refreshToken) return auth.accessToken;

  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: auth.refreshToken
    })
  });

  const body = await response.json().catch(() => null);
  if (body?.shouldLogout === true) {
    throw new Error('Session expired - please sign in to Cursor again');
  }
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  }
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error('Cursor refresh response did not include an access token');
  }

  persistAccessToken(auth, body.access_token);
  return body.access_token;
};

const resolveCredentialAccessToken = async (auth) => {
  if (!auth.accessToken && !auth.refreshToken) return null;
  if (!tokenNeedsRefresh(auth.accessToken)) return auth.accessToken;
  return refreshAccessToken(auth);
};

const resolveAccessToken = async () => resolveCredentialAccessToken(loadAuthState());

export const validateCursorCredential = async (credential) => {
  const accessToken = await resolveCredentialAccessToken({ ...credential, source: 'validation' });
  if (!accessToken) throw new Error('Cursor credentials are invalid');
  await connectPost(USAGE_URL, accessToken);
};

const connectPost = async (url, accessToken, body = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  }

  return response.json();
};

const connectGet = async (url, accessToken) => {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  }

  return response.json();
};

const centsLabel = (cents) => {
  const value = toNumber(cents);
  return value === null ? null : `$${formatMoney(value / 100)}`;
};

const percentFromSpend = (planUsage) => {
  const explicit = toNumber(planUsage?.totalPercentUsed);
  if (explicit !== null) return explicit;
  const limit = toNumber(planUsage?.limit);
  const remaining = toNumber(planUsage?.remaining);
  if (!limit || remaining === null) return null;
  return Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
};

const buildWindows = (usage, plan) => {
  const planUsage = usage?.planUsage ?? {};
  const spendLimitUsage = usage?.spendLimitUsage ?? {};
  const resetAt = toTimestamp(usage?.billingCycleEnd ?? plan?.planInfo?.billingCycleEnd);
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  const windows = {};

  windows.billing_cycle = toUsageWindow({
    usedPercent: percentFromSpend(planUsage),
    windowSeconds,
    resetAt,
    valueLabel: centsLabel(planUsage.totalSpend)
  });

  const autoPercent = toNumber(planUsage.autoPercentUsed);
  if (autoPercent !== null) {
    windows.auto = toUsageWindow({ usedPercent: autoPercent, windowSeconds, resetAt });
  }

  const apiPercent = toNumber(planUsage.apiPercentUsed);
  if (apiPercent !== null) {
    windows.api = toUsageWindow({ usedPercent: apiPercent, windowSeconds, resetAt });
  }

  const planLimit = centsLabel(planUsage.limit);
  if (planLimit) {
    const limit = toNumber(planUsage.limit);
    const remaining = toNumber(planUsage.remaining);
    windows.plan_limit = toUsageWindow({
      usedPercent: limit && remaining !== null
        ? Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100))
        : null,
      windowSeconds,
      resetAt,
      valueLabel: `${centsLabel(planUsage.remaining) ?? '$0.00'} remaining of ${planLimit}`
    });
  }

  const onDemandLimit = toNumber(spendLimitUsage.individualLimit) ?? toNumber(spendLimitUsage.pooledLimit);
  if (onDemandLimit && onDemandLimit > 0) {
    const remaining = toNumber(spendLimitUsage.individualRemaining) ?? toNumber(spendLimitUsage.pooledRemaining) ?? 0;
    windows.on_demand = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, ((onDemandLimit - remaining) / onDemandLimit) * 100)),
      windowSeconds,
      resetAt,
      valueLabel: `${centsLabel(remaining) ?? '$0.00'} remaining of ${centsLabel(onDemandLimit)}`
    });
  }

  return windows;
};

const AUTH_USAGE_METADATA_KEYS = new Set(['startOfMonth']);

const pickRequestUsage = (authUsage) => {
  let best = null;
  for (const [key, entry] of Object.entries(authUsage ?? {})) {
    if (AUTH_USAGE_METADATA_KEYS.has(key)) continue;
    const used = toNumber(entry?.numRequests);
    const limit = toNumber(entry?.maxRequestUsage);
    if (used === null || !limit) continue;
    if (!best || limit > best.limit) best = { used, limit, bucket: key };
  }
  return best;
};

const pickTeamMemberSpendByUserId = (teamSpend, userId) => {
  const id = toNumber(userId);
  if (id === null || !Array.isArray(teamSpend?.teamMemberSpend)) return null;
  return teamSpend.teamMemberSpend.find((member) => toNumber(member?.userId) === id) ?? null;
};

const buildEnterpriseWindows = (usage, plan, authUsage, hardLimit, teamMemberSpend) => {
  const resetAt = toTimestamp(plan?.planInfo?.billingCycleEnd ?? usage?.billingCycleEnd);
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  const windows = {};
  const requestUsage = pickRequestUsage(authUsage);

  if (requestUsage) {
    const { used, limit } = requestUsage;
    windows.billing_cycle = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
      windowSeconds,
      resetAt,
      valueLabel: `${Math.round(used)} / ${Math.round(limit)}`
    });
  }

  const onDemandLimitDollars = toNumber(hardLimit?.hardLimitPerUser);
  const onDemandUsedCents = toNumber(teamMemberSpend?.spendCents);
  if (onDemandLimitDollars > 0 && onDemandUsedCents !== null) {
    const onDemandLimitCents = onDemandLimitDollars * 100;
    windows.on_demand = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, (onDemandUsedCents / onDemandLimitCents) * 100)),
      windowSeconds,
      resetAt,
      valueLabel: `${centsLabel(onDemandUsedCents)} / ${centsLabel(onDemandLimitCents)}`
    });
  }

  return windows;
};

const appendCreditsWindow = (windows, credits) => {
  const balance = toNumber(credits?.balanceCents ?? credits?.totalBalanceCents ?? credits?.amountCents);
  if (balance === null) return;
  windows.credits = toUsageWindow({
    usedPercent: null,
    windowSeconds: null,
    resetAt: null,
    valueLabel: centsLabel(balance)
  });
};

export const isConfigured = () => {
  const auth = loadAuthState();
  return Boolean(auth.accessToken || auth.refreshToken);
};

export const fetchQuota = async () => {
  const accessToken = await resolveAccessToken();
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
    const [usage, plan, credits] = await Promise.all([
      connectPost(USAGE_URL, accessToken),
      connectPost(PLAN_URL, accessToken).catch(() => null),
      connectPost(CREDITS_URL, accessToken).catch(() => null)
    ]);

    if (usage?.enabled === false) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No active Cursor subscription'
      });
    }

    if (!usage?.planUsage) {
      const profile = await connectGet(STRIPE_PROFILE_URL, accessToken).catch(() => null);
      const teamId = profile?.teamId ? String(profile.teamId) : null;
      const hardLimitBody = teamId ? { teamId } : {};
      const [authUsage, hardLimit, teamSpend, me] = await Promise.all([
        connectGet(AUTH_USAGE_URL, accessToken).catch(() => null),
        connectPost(HARD_LIMIT_URL, accessToken, hardLimitBody).catch(() => null),
        teamId ? connectPost(TEAM_SPEND_URL, accessToken, hardLimitBody).catch(() => null) : null,
        connectPost(ME_URL, accessToken).catch(() => null)
      ]);
      const memberSpend = pickTeamMemberSpendByUserId(teamSpend, me?.userId);
      const windows = buildEnterpriseWindows(usage, plan, authUsage, hardLimit, memberSpend);
      if (!windows.billing_cycle && !windows.on_demand) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'No active Cursor subscription'
        });
      }
      appendCreditsWindow(windows, credits);

      const planName = plan?.planInfo?.planName;
      return buildResult({
        providerId,
        providerName: planName ? `Cursor ${planName}` : providerName,
        ok: true,
        configured: true,
        usage: { windows }
      });
    }

    const windows = buildWindows(usage, plan);
    appendCreditsWindow(windows, credits);

    return buildResult({
      providerId,
      providerName: plan?.planInfo?.planName ? `Cursor ${plan.planInfo.planName}` : providerName,
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
