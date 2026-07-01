/**
 * Ollama Cloud quota provider
 *
 * Cookie-based manual-auth provider for Ollama Cloud. Credentials are stored
 * via the credential registry (`getCredential`) and the canonical settings
 * pages are scraped with the faithful SSR scrapers ported verbatim from
 * mystatus/plugin/mystatus.ts.
 *
 * Canonical endpoints (source of truth: mystatus/plugin/mystatus.ts):
 *   GET https://ollama.com/settings         (SSR HTML — usage windows)
 *   GET https://ollama.com/settings/billing  (SSR HTML — subscription renewal)
 *
 * Auth shape (from credentials/schemas.js):
 *   - `cookie` (required): must contain `__Secure-session=`
 *
 * On retryable failures (429/5xx after retry exhaustion, network errors,
 * timeouts) the provider falls back to the last successful result marked
 * `isStale: true`. Auth failures (401/403) and parse errors do NOT trigger
 * cache fallback — a stale snapshot cannot confirm whether the credential
 * is still valid.
 *
 * Cookies are never included in error messages.
 *
 * @module quota/providers/ollama-cloud
 */

import { getCredential } from '../credentials/store.js';
import { fetchWithRetry, buildResult, toUsageWindow } from '../utils/index.js';

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';

const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const OLLAMA_BILLING_URL = 'https://ollama.com/settings/billing';
const OLLAMA_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:151.0) Gecko/20100101 Firefox/151.0';

/**
 * In-memory cache of the last successful result, keyed by accountHint.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Resolve the cookie from the credential registry.
 *
 * @returns {{ cookie: string|null, accountKey: string|null }}
 */
function resolveCredential() {
  const record = getCredential(providerId);
  if (!record?.credential) return { cookie: null, accountKey: null };
  const cookie = typeof record.credential.cookie === 'string' ? record.credential.cookie : null;
  return { cookie, accountKey: record.accountHint ?? null };
}

/**
 * Build the canonical Ollama request headers (verbatim from the
 * ollama.com settings page fetch).
 *
 * @param {string} cookie
 * @returns {Record<string, string>}
 */
function ollamaHeaders(cookie) {
  return {
    Cookie: cookie,
    Accept: 'text/html',
    'User-Agent': OLLAMA_USER_AGENT,
  };
}

/**
 * Parse a single Session/Weekly usage block from the settings SSR HTML.
 * Regexes transcribed verbatim from mystatus/plugin/mystatus.ts
 * `parseOllamaUsageBlock`.
 *
 * @param {string} html
 * @param {'Session'|'Weekly'} kind
 * @returns {{ usedPct: number, resetAt?: string, models: { model: string, requests: number }[] }|null}
 */
function parseOllamaUsageBlock(html, kind) {
  const usedMatch = html.match(new RegExp(`aria-label="${kind} usage ([\\d.]+)% used"`));
  if (!usedMatch) return null;

  const anchor = html.indexOf(`aria-label="${kind} usage`);
  const sliceStart = anchor >= 0 ? anchor : 0;
  const weeklyIdx = html.indexOf('Weekly usage');
  const sliceEnd =
    kind === 'Session' && weeklyIdx > sliceStart ? weeklyIdx : html.length;
  const block = html.slice(sliceStart, sliceEnd);

  const resetMatch = block.match(/data-time="([^"]+)"/);
  const models = [...block.matchAll(/data-model="([^"]+)"\s+data-requests="(\d+)"/g)].map((m) => ({
    model: m[1],
    requests: Number(m[2]),
  }));

  return {
    usedPct: parseFloat(usedMatch[1]),
    resetAt: resetMatch?.[1],
    models,
  };
}

/**
 * Parse the settings SSR HTML into account metadata + usage windows.
 * Regexes transcribed verbatim from mystatus/plugin/mystatus.ts
 * `parseOllamaSettingsHtml`.
 *
 * @param {string} html
 * @returns {{ email?: string, plan?: string, extraBalanceUsd?: string, windows: { label: 'Session'|'Weekly', usedPct: number, resetAt?: string, models: { model: string, requests: number }[] }[] }|null}
 */
function parseOllamaSettingsHtml(html) {
  if (!html.includes('Cloud usage')) return null;

  const email = html.match(/class="text-sm text-neutral-500 break-words">([^<]+)/)?.[1]?.trim();
  const plan = html.match(/Cloud usage<\/span>\s*<span[^>]*>\s*(\w+)\s*<\/span>/s)?.[1]?.trim();
  const extraBalanceUsd = html
    .match(/Balance remaining<\/div>\s*<div[^>]*>\$([^<]+)/)?.[1]
    ?.trim();

  const windows = [];
  const session = parseOllamaUsageBlock(html, 'Session');
  const weekly = parseOllamaUsageBlock(html, 'Weekly');
  if (session) windows.push({ label: 'Session', ...session });
  if (weekly) windows.push({ label: 'Weekly', ...weekly });
  if (!windows.length) return null;

  return { email, plan, extraBalanceUsd, windows };
}

/**
 * Parse the subscription renewal date from the billing SSR HTML.
 * Regex transcribed verbatim from mystatus/plugin/mystatus.ts
 * `parseOllamaBillingRenewal`.
 *
 * @param {string} html
 * @returns {string|undefined}
 */
function parseOllamaBillingRenewal(html) {
  return html.match(/subscription renews on\s*<span[^>]*>([^<]+)<\/span>/i)?.[1]?.trim();
}

/**
 * Transform the canonical parsed settings + renewal into OpenChamber usage
 * windows + footer. Mirrors the canonical `queryOllama` transform.
 *
 * @param {{ email?: string, plan?: string, extraBalanceUsd?: string, windows: { label: 'Session'|'Weekly', usedPct: number, resetAt?: string, models: { model: string, requests: number }[] }[] }} parsed
 * @param {string|undefined} renewal
 * @returns {{ windows: object, footer?: string[] }}
 */
function transformQuota(parsed, renewal) {
  const header = [];
  if (parsed.email) header.push(`Account:        ${parsed.email}`);
  if (parsed.plan) header.push(`Plan:           Ollama ${parsed.plan}`);

  const windows = {};
  for (const w of parsed.windows) {
    const key = w.label.toLowerCase();
    windows[key] = toUsageWindow({
      usedPercent: w.usedPct,
      windowSeconds: null,
      resetAt: w.resetAt,
      detail: [`Used: ${w.usedPct}%`],
    });
  }

  const footer = [...header];

  if (renewal) footer.push(`Subscription renews: ${renewal}`);
  if (parsed.extraBalanceUsd !== undefined) {
    footer.push(`Extra usage balance: $${parsed.extraBalanceUsd}`);
  }

  const session = parsed.windows.find((w) => w.label === 'Session');
  const weekly = parsed.windows.find((w) => w.label === 'Weekly');
  if (session?.models.length || weekly?.models.length) {
    footer.push('');
    if (session?.models.length) {
      footer.push('Session models:');
      for (const m of session.models.slice(0, 6)) {
        footer.push(`  ${m.model}: ${m.requests} request${m.requests === 1 ? '' : 's'}`);
      }
    }
    if (weekly?.models.length) {
      footer.push('Weekly models:');
      for (const m of weekly.models.slice(0, 8)) {
        footer.push(`  ${m.model}: ${m.requests} request${m.requests === 1 ? '' : 's'}`);
      }
    }
  }

  return { windows, footer: footer.length ? footer : undefined };
}

export const isConfigured = () => {
  const { cookie } = resolveCredential();
  return Boolean(cookie && cookie.includes('__Secure-session='));
};

export const fetchQuota = async () => {
  const { cookie, accountKey } = resolveCredential();

  if (!cookie) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  // Defensive structural check — mirrors schema validation at fetch time.
  if (!cookie.includes('__Secure-session=')) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Malformed credential: cookie must contain __Secure-session=',
    });
  }

  try {
    // 1. GET /settings — canonical SSR HTML with usage windows.
    const settingsResponse = await fetchWithRetry(OLLAMA_SETTINGS_URL, {
      headers: ollamaHeaders(cookie),
      maxRetries: 2,
      retryDelay: 1000,
    });

    if (!settingsResponse.ok) {
      // 401/403/4xx — auth or request errors. No cache fallback: a stale
      // snapshot cannot confirm whether the credential is still valid.
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: `API error: ${settingsResponse.status}`,
      });
    }

    const settingsHtml = await settingsResponse.text();
    const parsed = parseOllamaSettingsHtml(settingsHtml);
    if (!parsed) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error:
          'Ollama session invalid or settings page layout changed. ' +
          'Re-login at https://ollama.com and refresh the ollama-cloud credential.',
      });
    }

    // 2. GET /settings/billing — subscription renewal (best-effort, never fatal).
    let renewal;
    try {
      const billingResponse = await fetchWithRetry(OLLAMA_BILLING_URL, {
        headers: ollamaHeaders(cookie),
        maxRetries: 2,
        retryDelay: 1000,
      });
      if (billingResponse.ok) {
        const billingHtml = await billingResponse.text();
        renewal = parseOllamaBillingRenewal(billingHtml);
      }
    } catch {
      // tolerate — billing is enrichment only.
    }

    const usage = transformQuota(parsed, renewal);

    const result = buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
    });

    resultCache.set(accountKey, { ...result, cachedAt: Date.now() });
    return result;
  } catch (error) {
    // Retryable failure (429/5xx exhausted, network error, timeout).
    // Fall back to cached result if available.
    const cached = resultCache.get(accountKey);
    if (cached) {
      return {
        ...cached,
        ok: true,
        isStale: true,
        fetchedAt: Date.now(),
      };
    }
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};