import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { z } from 'zod';
import { readManagedCredential, writeManagedCredential } from '../credentials/providers.js';
import type { CursorCredential } from '../credentials/contracts.js';
import type { UsageWindow } from '../utils/contracts.js';
import { fetchCursorSummaryWindow } from './cursor-summary.js';
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

interface CursorAuthState {
  accessToken: string | null;
  refreshToken: string | null;
  source: 'env' | 'file' | 'managed' | 'import' | 'validation';
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isJsonArray = (value: unknown): value is unknown[] => Array.isArray(value);
const cursorJson = z.union([z.string(), z.custom<number>(isNumber), z.boolean(), z.null(), z.custom<object>(isJsonObject)]);
type CursorJson = z.infer<typeof cursorJson>;
const field = (value: CursorJson | undefined, key: string): CursorJson | undefined => {
  if (!isJsonObject(value)) return undefined;
  const entry = value[key];
  return entry === undefined ? undefined : cursorJson.parse(entry);
};

const readJwtPayload = (token: string) => {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return null;
    return cursorJson.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
};

const readStateValue = (key: string) => {
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
    const parsed = cursorJson.parse(JSON.parse(rows || '[]'));
    const value = field(field(parsed, '0'), 'value');
    return isString(value) && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
};

const readFileToken = (path: string | null) => {
  try {
    if (!path || !existsSync(path)) return null;
    const content = readFileSync(path, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
};

const loadAuthState = (): CursorAuthState => {
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

const tokenNeedsRefresh = (token: string | null) => {
  if (!token) return true;
  const payload = readJwtPayload(token);
  const exp = field(payload, 'exp');
  const expiresAt = isNumber(exp) ? exp * 1000 : null;
  return !expiresAt || expiresAt - Date.now() <= REFRESH_BUFFER_MS;
};

const persistAccessToken = (auth: CursorAuthState, accessToken: string) => {
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

const refreshAccessToken = async (auth: CursorAuthState) => {
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

  const body = await response.json().then(cursorJson.parse).catch(() => null);
  if (field(body, 'shouldLogout') === true) {
    throw new Error('Session expired - please sign in to Cursor again');
  }
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  }
  const accessToken = field(body, 'access_token');
  if (!isString(accessToken) || !accessToken) {
    throw new Error('Cursor refresh response did not include an access token');
  }

  persistAccessToken(auth, accessToken);
  return accessToken;
};

const resolveCredentialAccessToken = async (auth: CursorAuthState) => {
  if (!auth.accessToken && !auth.refreshToken) return null;
  if (!tokenNeedsRefresh(auth.accessToken)) return auth.accessToken;
  return refreshAccessToken(auth);
};

const resolveAccessToken = async () => resolveCredentialAccessToken(loadAuthState());

export const validateCursorCredential = async (credential: CursorCredential) => {
  const accessToken = await resolveCredentialAccessToken({ ...credential, source: 'validation' });
  if (!accessToken) throw new Error('Cursor credentials are invalid');
  await connectPost(USAGE_URL, accessToken);
};

const connectPost = async (url: string, accessToken: string, body: { teamId?: string } = {}) => {
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

  return cursorJson.parse(await response.json());
};

const connectGet = async (url: string, accessToken: string) => {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  }

  return cursorJson.parse(await response.json());
};

const centsLabel = (cents: CursorJson | undefined) => {
  const value = toNumber(cents);
  return value === null ? null : `$${formatMoney(value / 100)}`;
};

const percentFromSpend = (planUsage: CursorJson) => {
  const explicit = toNumber(field(planUsage, 'totalPercentUsed'));
  if (explicit !== null) return explicit;
  const limit = toNumber(field(planUsage, 'limit'));
  const remaining = toNumber(field(planUsage, 'remaining'));
  if (!limit || remaining === null) return null;
  return Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
};

const buildWindows = (usage: CursorJson, plan: CursorJson) => {
  const planUsage = field(usage, 'planUsage') ?? {};
  const spendLimitUsage = field(usage, 'spendLimitUsage') ?? {};
  const resetAt = toTimestamp(field(usage, 'billingCycleEnd') ?? field(field(plan, 'planInfo'), 'billingCycleEnd'));
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  const windows: Record<string, UsageWindow> = {};

  windows.billing_cycle = toUsageWindow({
    usedPercent: percentFromSpend(planUsage),
    windowSeconds,
    resetAt,
    valueLabel: centsLabel(field(planUsage, 'totalSpend'))
  });

  const autoPercent = toNumber(field(planUsage, 'autoPercentUsed'));
  if (autoPercent !== null) {
    windows.auto = toUsageWindow({ usedPercent: autoPercent, windowSeconds, resetAt });
  }

  const apiPercent = toNumber(field(planUsage, 'apiPercentUsed'));
  if (apiPercent !== null) {
    windows.api = toUsageWindow({ usedPercent: apiPercent, windowSeconds, resetAt });
  }

  const planLimit = centsLabel(field(planUsage, 'limit'));
  if (planLimit) {
    const limit = toNumber(field(planUsage, 'limit'));
    const remaining = toNumber(field(planUsage, 'remaining'));
    windows.plan_limit = toUsageWindow({
      usedPercent: limit && remaining !== null
        ? Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100))
        : null,
      windowSeconds,
      resetAt,
      valueLabel: `${centsLabel(field(planUsage, 'remaining')) ?? '$0.00'} remaining of ${planLimit}`
    });
  }

  const onDemandLimit = toNumber(field(spendLimitUsage, 'individualLimit')) ?? toNumber(field(spendLimitUsage, 'pooledLimit'));
  if (onDemandLimit && onDemandLimit > 0) {
    const remaining = toNumber(field(spendLimitUsage, 'individualRemaining')) ?? toNumber(field(spendLimitUsage, 'pooledRemaining')) ?? 0;
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

const pickRequestUsage = (authUsage: CursorJson) => {
  let best: { used: number; limit: number; bucket: string } | null = null;
  for (const key of Object.keys(authUsage ?? {})) {
    if (AUTH_USAGE_METADATA_KEYS.has(key)) continue;
    const entry = field(authUsage, key);
    const used = toNumber(field(entry, 'numRequests'));
    const limit = toNumber(field(entry, 'maxRequestUsage'));
    if (used === null || !limit) continue;
    if (!best || limit > best.limit) best = { used, limit, bucket: key };
  }
  return best;
};

const pickTeamMemberSpendByUserId = (teamSpend: CursorJson, userId: CursorJson | undefined) => {
  const id = toNumber(userId);
  const members = field(teamSpend, 'teamMemberSpend');
  if (id === null || !isJsonArray(members)) return null;
  const member = members.find((entry) => toNumber(field(cursorJson.parse(entry), 'userId')) === id);
  return member === undefined ? null : cursorJson.parse(member);
};

const buildEnterpriseWindows = (usage: CursorJson, plan: CursorJson, authUsage: CursorJson, hardLimit: CursorJson, teamMemberSpend: CursorJson) => {
  const resetAt = toTimestamp(field(field(plan, 'planInfo'), 'billingCycleEnd') ?? field(usage, 'billingCycleEnd'));
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  const windows: Record<string, UsageWindow> = {};
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

  const onDemandLimitDollars = toNumber(field(hardLimit, 'hardLimitPerUser'));
  const onDemandUsedCents = toNumber(field(teamMemberSpend, 'spendCents'));
  if (onDemandLimitDollars !== null && onDemandLimitDollars > 0 && onDemandUsedCents !== null) {
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

const appendCreditsWindow = (windows: Record<string, UsageWindow>, credits: CursorJson) => {
  const balance = toNumber(field(credits, 'balanceCents') ?? field(credits, 'totalBalanceCents') ?? field(credits, 'amountCents'));
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

    if (field(usage, 'enabled') === false) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No active Cursor subscription'
      });
    }

    if (!field(usage, 'planUsage')) {
      const profile = await connectGet(STRIPE_PROFILE_URL, accessToken).catch(() => null);
      const profileTeamId = field(profile, 'teamId');
      const teamId = profileTeamId ? String(profileTeamId) : null;
      const hardLimitBody = teamId ? { teamId } : {};
      const [authUsage, hardLimit, teamSpend, me] = await Promise.all([
        connectGet(AUTH_USAGE_URL, accessToken).catch(() => null),
        connectPost(HARD_LIMIT_URL, accessToken, hardLimitBody).catch(() => null),
        teamId ? connectPost(TEAM_SPEND_URL, accessToken, hardLimitBody).catch(() => null) : null,
        connectPost(ME_URL, accessToken).catch(() => null)
      ]);
      const memberSpend = pickTeamMemberSpendByUserId(teamSpend, field(me, 'userId'));
      const windows = buildEnterpriseWindows(usage, plan, authUsage, hardLimit, memberSpend);
      if (!windows.billing_cycle) {
        const summaryWindow = await fetchCursorSummaryWindow(accessToken).catch(() => null);
        if (summaryWindow) windows.billing_cycle = summaryWindow;
      }
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

      const planName = field(field(plan, 'planInfo'), 'planName');
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
      providerName: field(field(plan, 'planInfo'), 'planName') ? `Cursor ${field(field(plan, 'planInfo'), 'planName')}` : providerName,
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
