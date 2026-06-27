import { loadAuthMerged } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';

export const providerId = 'claude';
export const providerName = 'Claude';
const aliases = ['anthropic', 'claude'];

// Canonical Anthropic OAuth constants (mystatus/plugin/mystatus.ts).
const ANTHROPIC_CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';
const ANTHROPIC_USER_AGENT = 'claude-code/1.0.17';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// Anthropic OAuth access tokens are JWTs; the `sub` claim identifies the
// account and is stable across token refreshes, so it is a good accountKey.
const readJwtSubject = (token) => {
  if (typeof token !== 'string' || !token) return null;
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const sub = decoded?.sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
  }
};

// Canonical refreshAnthropicToken: POST form-urlencoded grant_type=refresh_token
// to https://console.anthropic.com/v1/oauth/token. Returns the new access
// token string, or null on failure. Never logs token values.
const refreshAnthropicToken = async (refreshToken) => {
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ANTHROPIC_CLAUDE_CODE_CLIENT_ID
    });
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data?.access_token === 'string' ? data.access_token : null;
  } catch {
    return null;
  }
};

// Resolve a usable access token from an oauth auth entry, refreshing when
// expired. Mirrors canonical queryAnthropic auth handling. Returns
// { accessToken, accountKey } or null when not usable.
const resolveAccessToken = async (entry) => {
  const oauth = entry && typeof entry === 'object' ? entry : null;
  const access = oauth?.access ?? oauth?.token;
  const refresh = oauth?.refresh;
  const expires = oauth?.expires;

  let accessToken = typeof access === 'string' ? access : null;
  if (!accessToken || (typeof expires === 'number' && expires < Date.now())) {
    if (!refresh) return null;
    const refreshed = await refreshAnthropicToken(refresh);
    if (!refreshed) return null;
    accessToken = refreshed;
  }
  if (!accessToken) return null;
  return { accessToken, accountKey: readJwtSubject(accessToken) };
};

export const isConfigured = () => {
  const auth = loadAuthMerged();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async () => {
  const auth = loadAuthMerged();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));

  if (!entry) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const resolved = await resolveAccessToken(entry);
  if (!resolved) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'Anthropic token expired and no refresh token available'
    });
  }
  const { accessToken, accountKey } = resolved;

  try {
    const response = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': ANTHROPIC_BETA_HEADER,
        'User-Agent': ANTHROPIC_USER_AGENT,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${response.status}`,
        accountKey
      });
    }

    const payload = await response.json();
    const windows = {};
    const fiveHour = payload?.five_hour ?? null;
    const sevenDay = payload?.seven_day ?? null;
    const sevenDaySonnet = payload?.seven_day_sonnet ?? null;
    const sevenDayOpus = payload?.seven_day_opus ?? null;
    const sevenDayCowork = payload?.seven_day_cowork ?? null;

    if (fiveHour) {
      windows['5h'] = toUsageWindow({
        usedPercent: toNumber(fiveHour.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(fiveHour.resets_at),
        suffix: 'rolling 5h',
        trendKey: 'claude:5h'
      });
    }
    if (sevenDay) {
      windows['7d'] = toUsageWindow({
        usedPercent: toNumber(sevenDay.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDay.resets_at),
        suffix: '7-day all models',
        trendKey: 'claude:7d'
      });
    }
    if (sevenDaySonnet) {
      windows['7d-sonnet'] = toUsageWindow({
        usedPercent: toNumber(sevenDaySonnet.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDaySonnet.resets_at),
        suffix: '7-day Sonnet',
        trendKey: 'claude:7d-sonnet'
      });
    }
    if (sevenDayOpus) {
      windows['7d-opus'] = toUsageWindow({
        usedPercent: toNumber(sevenDayOpus.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDayOpus.resets_at),
        suffix: '7-day Opus',
        trendKey: 'claude:7d-opus'
      });
    }
    if (sevenDayCowork) {
      windows['7d-cowork'] = toUsageWindow({
        usedPercent: toNumber(sevenDayCowork.utilization),
        windowSeconds: null,
        resetAt: toTimestamp(sevenDayCowork.resets_at),
        suffix: '7-day Cowork',
        trendKey: 'claude:7d-cowork'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows, subtitle: 'Claude subscription' },
      accountKey
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
      accountKey
    });
  }
};