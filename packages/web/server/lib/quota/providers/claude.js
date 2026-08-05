import { readAuthFile, writeAuthFile } from '../../opencode/auth.js';
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

// Public OAuth contract used by the OpenCode Anthropic plugin
// (packages/opencode/src/auth/anthropic.ts): refresh-token exchange against the
// console token endpoint with this client id, returning a rotated refresh token.
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const REQUEST_TIMEOUT_MS = 30_000;
// Renew while the token is still valid so a request in flight cannot fall into
// the expired window between a model call and the usage refresh.
const EXPIRY_MARGIN_MS = 60_000;

// Single-flight renewal: concurrent usage refreshes share one token exchange
// instead of firing several renewals at the same time.
let claudeRefreshPromise = null;

const decodeJwtExpiryMs = (token) => {
  try {
    const payload = token.split('.')[1];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims?.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
};

const normalizeExpiryMs = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  // OpenCode stores `expires` in milliseconds; tolerate seconds for older entries.
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const refreshClaudeOauth = async (entry, authKey) => {
  if (!claudeRefreshPromise) {
    claudeRefreshPromise = (async () => {
      const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: entry.refresh,
          client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Claude token refresh failed with ${response.status}`);
      }
      const payload = await response.json();
      const access = typeof payload?.access_token === 'string' ? payload.access_token : '';
      if (!access) {
        throw new Error('Claude token refresh returned no access token');
      }
      const refreshed = {
        ...entry,
        type: 'oauth',
        access,
        refresh: typeof payload?.refresh_token === 'string' && payload.refresh_token
          ? payload.refresh_token
          : entry.refresh,
        expires: Date.now() + (Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : 3600) * 1000,
      };
      const auth = readAuthFile();
      auth[authKey] = refreshed;
      writeAuthFile(auth);
      return refreshed;
    })().finally(() => {
      claudeRefreshPromise = null;
    });
  }
  return claudeRefreshPromise;
};

/**
 * Return the entry with a usable access token, renewing it when the stored
 * token is expired (or about to expire). Returns null when the entry has no
 * refresh token, so callers fall back to the stored token as-is.
 */
const ensureFreshClaudeOauth = async (entry, authKey) => {
  const expires = normalizeExpiryMs(entry.expires) ?? decodeJwtExpiryMs(entry.access);
  if (entry.access && expires !== null && expires > Date.now() + EXPIRY_MARGIN_MS) {
    return entry;
  }
  if (!entry.refresh) {
    return null;
  }
  return refreshClaudeOauth(entry, authKey);
};

const parseUsagePayload = (payload) => {
  const windows = {};
  const fiveHour = payload?.five_hour ?? null;
  const sevenDay = payload?.seven_day ?? null;
  const sevenDaySonnet = payload?.seven_day_sonnet ?? null;
  const sevenDayOpus = payload?.seven_day_opus ?? null;

  if (fiveHour) {
    windows['5h'] = toUsageWindow({
      usedPercent: toNumber(fiveHour.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(fiveHour.resets_at)
    });
  }
  if (sevenDay) {
    windows['7d'] = toUsageWindow({
      usedPercent: toNumber(sevenDay.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDay.resets_at)
    });
  }
  if (sevenDaySonnet) {
    windows['7d-sonnet'] = toUsageWindow({
      usedPercent: toNumber(sevenDaySonnet.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDaySonnet.resets_at)
    });
  }
  if (sevenDayOpus) {
    windows['7d-opus'] = toUsageWindow({
      usedPercent: toNumber(sevenDayOpus.utilization),
      windowSeconds: null,
      resetAt: toTimestamp(sevenDayOpus.resets_at)
    });
  }

  return windows;
};

const fetchClaudeUsage = async (accessToken) => {
  const response = await fetch(ANTHROPIC_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) {
    return { status: response.status };
  }

  const payload = await response.json();
  return { status: 200, windows: parseUsagePayload(payload) };
};

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.access || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
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

  // Write renewed credentials back under the key the entry was read from, so
  // the OpenCode Anthropic plugin keeps using them.
  const authKey = aliases.find((alias) => auth[alias]) ?? 'anthropic';

  try {
    // Renew first when the stored token is expired (or about to expire) — the
    // window between model calls and the usage refresh must not 401.
    let current = entry;
    let token = accessToken;
    if (entry?.type === 'oauth' && entry.refresh) {
      const fresh = await ensureFreshClaudeOauth(entry, authKey);
      if (fresh) {
        current = fresh;
        if (fresh.access) {
          token = fresh.access;
        }
      }
    }

    const result = await fetchClaudeUsage(token);

    if (result.status === 401 && current?.type === 'oauth' && current.refresh) {
      // The usage API rejected even a fresh token — renew once more (with the
      // rotated refresh token from the last renewal) and retry before declaring
      // the session dead.
      const renewed = await refreshClaudeOauth(current, authKey);
      const retryResult = await fetchClaudeUsage(renewed.access);
      if (retryResult.status === 200) {
        return buildResult({
          providerId,
          providerName,
          ok: true,
          configured: true,
          usage: { windows: retryResult.windows }
        });
      }
      if (retryResult.status === 401) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'Session expired — please re-authenticate with Claude'
        });
      }
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${retryResult.status}`
      });
    }

    if (result.status !== 200) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: result.status === 401
          ? 'Session expired — please re-authenticate with Claude'
          : `API error: ${result.status}`
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: result.windows }
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
