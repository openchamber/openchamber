/**
 * NanoGPT quota provider
 *
 * Faithful port of the canonical NanoGPT query (mystatus/plugin/mystatus.ts,
 * `queryNanoGpt` / `queryNanoGptCredential`). Canonical API:
 *   - POST https://nano-gpt.com/api/check-balance   (balance: usd_balance, nano_balance)
 *   - GET  https://nano-gpt.com/api/subscription/v1/usage (subscription windows)
 *
 * Auth (canonical `resolveNanoGptCredentials`):
 *   - Multi-auth keys file `nanogpt-keys.json` under the opencode data dirs
 *     (`{ version?, keys: [{ id?, label?, key?, enabled?, cooldownUntil? }] }`).
 *   - Native `auth.json` entry under `nano-gpt` (aliases: nanogpt, nano_gpt).
 *   Duplicate keys are deduped; multi-auth entries take precedence over native.
 *
 * The balance endpoint is required (canonical throws on non-ok). The
 * subscription endpoint is best-effort: a non-ok or unparseable body is
 * treated as "no subscription" (pay-as-you-go plan).
 *
 * Subscription window mapping (canonical `nanoGptWindow`):
 *   - weeklyInputTokens  -> "Weekly input tokens" (tokens)
 *   - dailyInputTokens   -> "Daily input tokens"  (tokens)
 *   - dailyImages        -> "Daily images"        (images)
 *   For each window: used = w.used ?? 0, remaining = w.remaining ?? 0,
 *   total = limit > 0 ? limit : used + remaining. remainPct = total > 0
 *   ? round(remaining/total*100) : (percentUsed ? round(100 - percentUsed*100) : 100).
 *
 * Multi-account: when more than one credential is resolved, every account
 * is emitted into `usage.accounts[]` (ProviderAccountUsage). The FIRST
 * account's data is also placed at the top-level `usage` (windows/subtitle).
 *
 * @module quota/providers/nanogpt
 */

import * as fs from 'fs';
import path from 'path';

import * as authModule from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toTimestamp
} from '../utils/index.js';

export const providerId = 'nano-gpt';
export const providerName = 'NanoGPT';
const aliases = ['nano-gpt', 'nanogpt', 'nano_gpt'];

const NANOGPT_BASE_URL = 'https://nano-gpt.com';
const NANOGPT_BALANCE_URL = `${NANOGPT_BASE_URL}/api/check-balance`;
const NANOGPT_SUBSCRIPTION_URL = `${NANOGPT_BASE_URL}/api/subscription/v1/usage`;
const NANOGPT_USER_AGENT = 'OpenCode-AllStatus/1.0';

const DAILY_WINDOW_SECONDS = 86400;

/**
 * Resolve the nanogpt-keys.json path by searching the opencode data dirs
 * (candidateDataDirs). Mirrors the canonical
 * `nanoGptMultiAuthKeysPath` -> `findReadable("nanogpt-keys.json", "data")`.
 *
 * @returns {string|null}
 */
function nanoGptKeysFilePath() {
  for (const dir of authModule.candidateDataDirs()) {
    const candidate = path.join(dir, 'nanogpt-keys.json');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Load multi-auth credentials from nanogpt-keys.json. Mirrors the canonical
 * `loadNanoGptMultiAuthCredentials`.
 *
 * @returns {Array<{ source: 'multi-auth', label?: string, key: string, cooldownUntil?: number }>}
 */
function loadMultiAuthCredentials() {
  const filePath = nanoGptKeysFilePath();
  if (!filePath) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return [];
    const keys = data.keys;
    if (!Array.isArray(keys)) return [];
    const out = [];
    for (const stored of keys) {
      if (!stored || typeof stored !== 'object') continue;
      if (stored.enabled === false) continue;
      const key = typeof stored.key === 'string' ? stored.key.trim() : '';
      if (!key) continue;
      out.push({
        source: 'multi-auth',
        label: typeof stored.label === 'string' ? stored.label : stored.id,
        key,
        cooldownUntil: typeof stored.cooldownUntil === 'number' ? stored.cooldownUntil : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Resolve all configured NanoGPT credentials, deduped by key. Multi-auth
 * entries take precedence over the native auth.json entry. Mirrors the
 * canonical `resolveNanoGptCredentials`.
 *
 * @returns {Array<{ source: 'native'|'multi-auth', label?: string, key: string, cooldownUntil?: number }>}
 */
function resolveCredentials() {
  const credentials = [];
  const seen = new Set();
  const add = (credential) => {
    const key = credential.key.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    credentials.push({ ...credential, key });
  };

  for (const credential of loadMultiAuthCredentials()) add(credential);

  const auth = authModule.readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  if (entry?.key || entry?.token) {
    add({ source: 'native', label: 'Native auth', key: entry.key ?? entry.token });
  }

  return credentials;
}

/**
 * Format a count for display (canonical `humanCount`).
 *
 * @param {number} n
 * @returns {string}
 */
function humanCount(n) {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  const trim = (v, dp) => v.toFixed(dp).replace(/\.0$/, '');
  if (abs >= 1e9) return trim(n / 1e9, abs >= 1e10 ? 0 : 1) + 'B';
  if (abs >= 1e6) return trim(n / 1e6, abs >= 1e7 ? 0 : 1) + 'M';
  if (abs >= 1e3) return trim(n / 1e3, abs >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}

/**
 * Build a usage window for a NanoGPT subscription sub-window. Mirrors the
 * canonical `nanoGptWindow`.
 *
 * @param {string} label
 * @param {object|null|undefined} w - { used?, remaining?, percentUsed?, resetAt? }
 * @param {number|null|undefined} limit
 * @param {'tokens'|'images'} unit
 * @param {string} trendKey
 * @returns {object|null}
 */
function nanoGptWindow(label, w, limit, unit, trendKey) {
  if (!w) return null;
  const used = typeof w.used === 'number' ? w.used : 0;
  const remaining = typeof w.remaining === 'number' ? w.remaining : 0;
  const total = typeof limit === 'number' && limit > 0 ? limit : used + remaining;

  let usedPercent;
  if (total > 0) {
    usedPercent = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
  } else if (typeof w.percentUsed === 'number') {
    usedPercent = Math.max(0, Math.min(100, Math.round(w.percentUsed * 100)));
  } else {
    usedPercent = 0;
  }

  const resetAt = toTimestamp(w.resetAt);
  const fmt = unit === 'tokens' ? humanCount : (x) => String(x);
  const detail = total > 0 ? [`Used: ${fmt(used)} / ${fmt(total)}`] : [`Used: ${fmt(used)}`];
  const windowSeconds = unit === 'images' ? DAILY_WINDOW_SECONDS : null;

  return toUsageWindow({
    usedPercent,
    windowSeconds,
    resetAt,
    valueLabel: label,
    suffix: unit === 'images' ? 'daily' : null,
    detail,
    trendKey,
  });
}

/**
 * Query a single NanoGPT credential: balance (required) + subscription
 * (best-effort). Mirrors the canonical `queryNanoGptCredential`.
 *
 * @param {{ source: string, label?: string, key: string, cooldownUntil?: number }} credential
 * @param {string|undefined} subtitle
 * @returns {Promise<{ ok: true, usage: { windows: object, subtitle: string, note?: string, footer?: string[] } }|{ ok: false, error: string }>}
 */
async function queryCredential(credential, subtitle) {
  const headers = {
    'x-api-key': credential.key,
    'Content-Type': 'application/json',
    'User-Agent': NANOGPT_USER_AGENT,
  };

  const [balRes, subRes] = await Promise.all([
    fetch(NANOGPT_BALANCE_URL, { method: 'POST', headers }),
    fetch(NANOGPT_SUBSCRIPTION_URL, { method: 'GET', headers }),
  ]);

  if (!balRes.ok) {
    const body = await balRes.text().catch(() => '');
    throw new Error(`NanoGPT balance API error (${balRes.status}): ${body.slice(0, 200)}`);
  }
  const bal = await balRes.json();

  const header = [`Auth source:     ${credential.source === 'multi-auth' ? 'NanoGPT multi-auth' : 'OpenCode native auth'}`];
  const usd = Number(bal?.usd_balance ?? '0');
  header.push(`Balance:        $${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`);
  const nano = Number(bal?.nano_balance ?? '0');
  if (Number.isFinite(nano) && nano > 0) header.push(`Nano (XNO):     ${nano.toFixed(4)}`);

  let sub = null;
  if (subRes.ok) {
    try {
      sub = await subRes.json();
    } catch {
      // no subscription body
    }
  }

  const windows = {};
  const footer = [];

  if (credential.cooldownUntil && credential.cooldownUntil > Date.now()) {
    const secs = Math.ceil((credential.cooldownUntil - Date.now()) / 1000);
    footer.push(`Pool cooldown:  ${secs}s`);
  }

  if (sub?.active) {
    header.push(`Plan:           Subscription${sub.provider ? ` (${sub.provider})` : ''}`);
    const built = [
      nanoGptWindow('Weekly input tokens', sub.weeklyInputTokens, sub.limits?.weeklyInputTokens, 'tokens', 'nano-gpt:weekly-input'),
      nanoGptWindow('Daily input tokens', sub.dailyInputTokens, sub.limits?.dailyInputTokens, 'tokens', 'nano-gpt:daily-input'),
      nanoGptWindow('Daily images', sub.dailyImages, sub.limits?.dailyImages, 'images', 'nano-gpt:daily-images'),
    ];
    for (const w of built) {
      if (!w) continue;
      const key = w.trendKey ?? w.valueLabel ?? `w${Object.keys(windows).length}`;
      windows[key] = w;
    }
    const end = sub.period?.currentPeriodEnd;
    if (end) footer.push(`${sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'}:         ${end}`);
  } else {
    header.push('Plan:           Pay-as-you-go');
  }

  const usage = { windows, subtitle: subtitle ?? 'NanoGPT', header, footer: footer.length ? footer : undefined };
  return { ok: true, usage };
}

export const isConfigured = () => {
  return resolveCredentials().length > 0;
};

export const fetchQuota = async () => {
  const credentials = resolveCredentials();

  if (credentials.length === 0) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const multi = credentials.length > 1;

  const results = await Promise.all(
    credentials.map(async (credential) => {
      const subtitle = multi ? (credential.label?.trim() || (credential.source === 'native' ? 'Native auth' : 'Multi-auth key')) : undefined;
      try {
        return { ok: true, usage: (await queryCredential(credential, subtitle)).usage, accountKey: credential.key };
      } catch (err) {
        const label = subtitle ?? 'NanoGPT';
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `${label}: ${message}`, accountKey: credential.key };
      }
    }),
  );

  const accountUsages = [];
  const errors = [];
  for (const r of results) {
    if (r.ok) {
      accountUsages.push(r);
    } else {
      errors.push(r.error);
    }
  }

  if (accountUsages.length === 0) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: errors.length > 0 ? errors.join('\n\n') : 'No account data returned',
    });
  }

  const first = accountUsages[0].usage;
  const usage = {
    windows: first.windows,
    subtitle: first.subtitle,
    ...(first.header ? { header: first.header } : {}),
    ...(first.footer ? { footer: first.footer } : {}),
  };

  // Multi-account: emit accounts[] so the UI can render per-account
  // sub-cards. Single account -> top-level usage only (no accounts[]).
  if (multi) {
    usage.accounts = accountUsages.map((r) => {
      const u = r.usage;
      return {
        accountKey: r.accountKey,
        subtitle: u.subtitle,
        windows: u.windows,
        ...(u.header ? { header: u.header } : {}),
        ...(u.footer ? { footer: u.footer } : {}),
      };
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage,
  });
};