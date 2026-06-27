/**
 * xAI / Grok quota provider.
 *
 * OAuth-only provider ported from the canonical opencode-mystatus source
 * (mystatus/plugin/mystatus.ts, queryXai @ 2056-2162). xAI authenticates via
 * two OAuth sources, never a manual credential:
 *
 *   1. Consumer SuperGrok (~/.grok/auth.json via readGrokAuth): written by
 *      `grok login`, auto-refreshes via refresh_token. Preferred when present
 *      because it stays live across long sessions.
 *   2. OpenCode dev API (auth.json keys 'xai' / 'xai-oauth' via
 *      loadAuthMerged): reads the same account's billing.
 *
 * Flow (faithful to canonical):
 *   - Resolve a usable consumer token: if expired, refresh via
 *     POST https://auth.x.ai/oauth2/token and persist back to
 *     ~/.grok/auth.json (best-effort, never throws).
 *   - creditsToken = consumerToken ?? devToken. If the dev token is expired
 *     and there is no consumer token, surface the canonical "expired" error.
 *   - GET https://cli-chat-proxy.grok.com/v1/billing?format=credits  (percent
 *     + per-product breakdown) -> one "credits" usage window.
 *   - GET https://cli-chat-proxy.grok.com/v1/billing  (absolute used/limit)
 *     -> appended as a detail line on the SAME window (same ledger, not a
 *     separate quota).
 *   - GET https://api.x.ai/v1/models  (liveness reachability check). A
 *     non-ok response fails the whole card.
 *
 * Tokens are never logged. The OAuth refresh write-back uses
 * fs.writeFileSync directly with the JSON payload (no console output).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadAuthMerged, oauthExpires, readGrokAuth } from '../../opencode/auth.js';
import { buildResult, fetchWithRetry, toUsageWindow, toNumber } from '../utils/index.js';

export const providerId = 'xai';
export const providerName = 'xAI';

const GROK_BILLING_BASE = 'https://cli-chat-proxy.grok.com/v1/billing';
const GROK_BILLING_CREDITS_URL = `${GROK_BILLING_BASE}?format=credits`;
const XAI_MODELS_URL = 'https://api.x.ai/v1/models';
const XAI_OAUTH_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

const GROK_AUTH_FILE = path.join(os.homedir(), '.grok', 'auth.json');

/**
 * Resolve the OpenCode dev API OAuth credential from auth.json (merged).
 * Returns the first of 'xai' / 'xai-oauth' that is an oauth entry with an
 * `access` string, or null.
 *
 * @returns {{ access: string, expires?: number } | null}
 */
function resolveDevAuth() {
  const merged = loadAuthMerged();
  for (const key of ['xai', 'xai-oauth']) {
    const cred = merged[key];
    if (!cred || typeof cred !== 'object') continue;
    if (cred.type !== 'oauth') continue;
    const access = typeof cred.access === 'string' && cred.access ? cred.access : null;
    if (!access) continue;
    const exp = oauthExpires(cred);
    return { access, expires: exp };
  }
  return null;
}

/**
 * Parse ~/.grok/auth.json into the canonical consumer auth shape. Mirrors
 * `loadGrokConsumerAuth` (mystatus.ts 1943-1964): the first entry with a
 * string `key` wins.
 *
 * @returns {{ storeKey: string, key: string, refreshToken?: string, expiresAt?: number, filePath: string } | null}
 */
function parseGrokConsumerAuth(file) {
  const data = readGrokAuth(file);
  if (!data) return null;
  for (const [storeKey, v] of Object.entries(data)) {
    if (!v || typeof v !== 'object') continue;
    const entry = v;
    if (typeof entry.key !== 'string' || !entry.key) continue;
    const expMs = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
    return {
      storeKey,
      key: entry.key,
      refreshToken: typeof entry.refresh_token === 'string' ? entry.refresh_token : undefined,
      expiresAt: Number.isFinite(expMs) ? expMs : undefined,
      filePath: file ?? GROK_AUTH_FILE,
    };
  }
  return null;
}

/**
 * Refresh an expired consumer token via POST https://auth.x.ai/oauth2/token
 * and persist the refreshed token back to ~/.grok/auth.json. Faithful to
 * canonical `refreshGrokConsumerToken` (1969-2013). Returns the fresh access
 * token, or null on failure (caller falls back to the stale token / dev
 * token). Never throws. Never logs token values.
 *
 * @param {{ storeKey: string, refreshToken?: string, filePath: string }} auth
 * @returns {Promise<string | null>}
 */
async function refreshGrokConsumerToken(auth) {
  if (!auth.refreshToken) return null;
  try {
    const res = await fetchWithRetry(XAI_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: auth.refreshToken,
      }),
      maxRetries: 1,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.access_token !== 'string' || !data.access_token) return null;

    // Best-effort write-back so the next run starts fresh. Never throws.
    try {
      const raw = fs.readFileSync(auth.filePath, 'utf8');
      const file = JSON.parse(raw);
      const entry = file[auth.storeKey];
      if (entry && typeof entry === 'object') {
        entry.key = data.access_token;
        if (typeof data.refresh_token === 'string') entry.refresh_token = data.refresh_token;
        if (typeof data.expires_in === 'number') {
          entry.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
        }
        fs.writeFileSync(auth.filePath, JSON.stringify(file, null, 2));
      }
    } catch {
      // swallow — write-back is best-effort
    }

    return data.access_token;
  } catch {
    return null;
  }
}

/**
 * Resolve a usable consumer access token: use the stored one if still valid,
 * otherwise try to refresh. Returns null if there is no consumer auth at
 * all. Mirrors `resolveGrokConsumerToken` (2015-2026).
 *
 * @returns {Promise<string | null>}
 */
async function resolveGrokConsumerToken() {
  const auth = parseGrokConsumerAuth();
  if (!auth) return null;
  const expired = typeof auth.expiresAt === 'number' && auth.expiresAt <= Date.now() + 60_000;
  if (expired) {
    const refreshed = await refreshGrokConsumerToken(auth);
    return refreshed ?? auth.key;
  }
  return auth.key;
}

/**
 * Format an ISO billing-period end as a compact "Mon D" reset hint
 * (e.g. "Jul 1"), matching the canonical `formatGrokResetDate` (2030-2039).
 *
 * @param {string|undefined} iso
 * @returns {string|undefined}
 */
function formatGrokResetDate(iso) {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Rename a canonical product id into the canonical display label (2098).
 * GrokBuild -> "Build", Api -> "SuperGrok", otherwise passthrough.
 *
 * @param {string} id
 * @returns {string}
 */
function renameProduct(id) {
  if (id === 'GrokBuild') return 'Build';
  if (id === 'Api') return 'SuperGrok';
  return id;
}

/**
 * Transform the canonical billing?credits + billing responses into a single
 * "credits" usage window + footer. Faithful to canonical 2085-2137.
 *
 * @param {object} creditsCfg - billing?format=credits `config`
 * @param {object|null} billingCfg - billing `config` (or null)
 * @param {boolean} hasConsumer - whether a consumer token was used
 * @param {boolean} devTokenExpired - whether the dev token is expired
 * @param {number|undefined} devExpires - dev token expires (epoch ms)
 * @returns {{ windows: object, footer: string[] }}
 */
function transformQuota(creditsCfg, billingCfg, hasConsumer, devTokenExpired, devExpires) {
  const windows = {};
  const footer = [];

  // Auth status line (canonical header content, surfaced as footer context).
  footer.push(
    devTokenExpired ? 'Auth:           consumer-only (dev token expired)' : 'Auth:           valid',
  );
  if (!devTokenExpired && typeof devExpires === 'number' && devExpires > Date.now()) {
    const secs = Math.floor((devExpires - Date.now()) / 1000);
    footer.push(`Token expires:  ${formatDuration(secs)}`);
  }
  if (!hasConsumer) {
    footer.push('SuperGrok:      run `grok login` to show credits');
  }

  // Credits window from billing?format=credits.
  const usedPct = toNumber(creditsCfg.creditUsagePercent) ?? 0;
  const remain = Math.max(0, Math.min(100, 100 - usedPct));
  const resetDate = formatGrokResetDate(creditsCfg.billingPeriodEnd);
  const detail = [
    `Credits used: ${usedPct.toFixed(2)}%${resetDate ? ` \u00b7 Resets ${resetDate}` : ''}`,
  ];

  const products = Array.isArray(creditsCfg.productUsage)
    ? creditsCfg.productUsage.filter(
        (p) => p && typeof p.product === 'string' && typeof p.usagePercent === 'number',
      )
    : [];
  if (products.length > 0) {
    detail.push(
      products
        .map((p) => `${renameProduct(String(p.product))}: ${Number(p.usagePercent).toFixed(2)}%`)
        .join(' \u00b7 '),
    );
  }

  const onDemand = toNumber(creditsCfg.onDemandUsed?.val) ?? 0;
  const onDemandCap = toNumber(creditsCfg.onDemandCap?.val) ?? 0;
  if (onDemandCap > 0) detail.push(`On-demand: ${onDemand}/${onDemandCap}`);

  const prepaid = toNumber(creditsCfg.prepaidBalance?.val) ?? 0;
  if (prepaid > 0) detail.push(`Prepaid balance: ${prepaid}`);

  // Absolute used/limit from the default billing view, appended to the SAME
  // window (same ledger, not a separate quota).
  if (billingCfg) {
    const limit = toNumber(billingCfg.monthlyLimit?.val);
    const used = toNumber(billingCfg.used?.val);
    if (typeof limit === 'number' && limit > 0 && typeof used === 'number') {
      detail.push(`Used: ${used.toLocaleString()} / ${limit.toLocaleString()} credits`);
    }
  }

  windows.credits = toUsageWindow({
    usedPercent: usedPct,
    resetAt: creditsCfg.billingPeriodEnd,
    valueLabel: hasConsumer ? 'SuperGrok credits' : 'Grok credits',
    detail,
  });

  return { windows, footer };
}

/**
 * Format a duration in seconds as the canonical short form (e.g. "1h 0m",
 * "0m"). Mirrors the canonical `formatDuration` used in the xAI card header.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const isConfigured = () => {
  const grok = parseGrokConsumerAuth();
  if (grok && grok.key) return true;
  const dev = resolveDevAuth();
  return Boolean(dev && dev.access);
};

export const fetchQuota = async () => {
  const dev = resolveDevAuth();
  const hasConsumer = parseGrokConsumerAuth() !== null;

  if (!dev && !hasConsumer) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const consumerToken = await resolveGrokConsumerToken();
  const hasConsumerToken = Boolean(consumerToken);
  const devTokenExpired = Boolean(dev?.expires && dev.expires < Date.now());

  if (devTokenExpired && !hasConsumerToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'xAI token expired. Use a Grok model in OpenCode to refresh.',
    });
  }

  const creditsToken = consumerToken ?? dev?.access;

  try {
    // 1. GET /v1/billing?format=credits — percent + per-product breakdown.
    let creditsCfg = {};
    try {
      const r = await fetchWithRetry(GROK_BILLING_CREDITS_URL, {
        headers: { Authorization: `Bearer ${creditsToken}`, Accept: 'application/json' },
        maxRetries: 2,
      });
      if (r.ok) {
        const payload = await r.json();
        creditsCfg = payload?.config && typeof payload.config === 'object' ? payload.config : {};
      }
    } catch {
      // non-fatal — keep rendering the rest of the card
    }

    // 2. GET /v1/billing — absolute used/limit (same ledger, detail line).
    let billingCfg = null;
    try {
      const billRes = await fetchWithRetry(GROK_BILLING_BASE, {
        headers: { Authorization: `Bearer ${creditsToken}`, Accept: 'application/json' },
        maxRetries: 2,
      });
      if (billRes.ok) {
        const payload = await billRes.json();
        billingCfg = payload?.config && typeof payload.config === 'object' ? payload.config : null;
      }
    } catch {
      // non-fatal
    }

    // 3. GET /v1/models — liveness reachability check. A non-ok response
    //    fails the whole card (canonical 2149-2157).
    try {
      const res = await fetchWithRetry(XAI_MODELS_URL, {
        headers: {
          Authorization: `Bearer ${creditsToken}`,
          Accept: 'application/json',
          'x-grok-source': 'opencode-allstatus',
        },
        maxRetries: 2,
      });
      if (!res.ok) {
        // 401/403 here means every resolved token is invalid; surface a re-auth hint.
        const authFailure = res.status === 401 || res.status === 403;
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: authFailure
            ? 'xAI token expired or revoked. Run `grok login` (or use a Grok model in OpenCode) to refresh.'
            : `xAI API error (${res.status})`,
        });
      }
    } catch (error) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: error instanceof Error ? error.message : 'xAI API request failed',
      });
    }

    const { windows, footer } = transformQuota(
      creditsCfg,
      billingCfg,
      hasConsumerToken,
      devTokenExpired,
      dev?.expires,
    );

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows, footer },
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};