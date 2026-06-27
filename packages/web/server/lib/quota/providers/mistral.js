/**
 * Mistral quota provider
 *
 * Cookie-based manual-auth provider for the Mistral Vibe plan, ported
 * faithfully from the canonical console.mistral.ai tRPC batch API
 * (source of truth: mystatus/plugin/mystatus.ts, `queryMistralAccount`).
 *
 * Canonical API:
 *   GET https://console.mistral.ai/api-ui/trpc/user.me,vibe.getApiKey,billing.vibeUsage?batch=1&input=...
 *
 * Auth shape (from credentials/schemas.js):
 *   - `cookie` (required): must contain `csrftoken=`. The csrf token is
 *     extracted and echoed back as the `x-csrftoken` header.
 *   - `accounts` (optional): array of `{ alias?, cookie }` for multi-account.
 *     When present, every account is queried in parallel. When absent, the
 *     single top-level `cookie` is treated as one account.
 *
 * The canonical parser reads the response body as text and extracts
 * `usage_percentage`, `reset_at`, and `email` via regex (the tRPC batch
 * envelope is not strictly JSON-parsed because the body can be JSONL when
 * `trpc-accept: application/jsonl` is set). This port mirrors that.
 *
 * Multi-account mapping: the FIRST account's data is placed at the top-level
 * `usage` (windows/subtitle/note) AND every account (including the first) is
 * emitted as an entry in `usage.accounts[]` so the UI can render per-account
 * sub-cards. `usedPercent = 100 - remaining` where `remaining = 100 -
 * usage_percentage`.
 *
 * On retryable failures (429/5xx after retry exhaustion, network errors,
 * timeouts) the provider falls back to the last successful result marked
 * `isStale: true`. Auth failures (401/403) and parse errors do NOT trigger
 * cache fallback — a stale snapshot cannot confirm whether the credential is
 * still valid.
 *
 * Cookies and csrf tokens are never included in error messages.
 *
 * @module quota/providers/mistral
 */

import { loadCredentials } from '../credentials/store.js';
import { fetchWithRetry, buildResult, toUsageWindow } from '../utils/index.js';

export const providerId = 'mistral';
export const providerName = 'Mistral';

const MISTRAL_TRPC_URL =
  'https://console.mistral.ai/api-ui/trpc/user.me,vibe.getApiKey,billing.vibeUsage?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%2C%221%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%2C%222%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D';

const MISTRAL_USER_AGENT = 'OpenCode-AllStatus/1.0';
const MISTRAL_TIMEOUT_MS = 10000;

/**
 * In-memory cache of the last successful result, keyed by accountKey.
 * Used for stale fallback on transient failures.
 */
const resultCache = new Map();

/**
 * Extract the `csrftoken` value from a cookie header string.
 * Mirrors the canonical `extractCsrfToken`.
 *
 * @param {string} cookieHeader
 * @returns {string|null}
 */
function extractCsrfToken(cookieHeader) {
  const match = cookieHeader.match(/(?:^|;\s*)(?:csrftoken|csrf_token_[^=;]+)=([^;]+)/);
  return match ? match[1] : null;
}

function invalidCookieHeaderValue(cookie) {
  return [...cookie].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f || code > 0xff;
  });
}

function cookieHeaderValidationError(cookie) {
  if (!invalidCookieHeaderValue(cookie)) return null;
  return 'Cookie contains invalid characters; paste literal cookie values without ellipses or placeholders';
}

/**
 * Resolve all configured accounts from the credential store.
 *
 * Mirrors the canonical `loadMistralCookies` shape handling:
 *   - `{ cookie }`                       -> single account
 *   - `{ alias, cookie }`                -> single account with alias
 *   - `{ accounts: [{ alias?, cookie }] }`-> multi-account
 *
 * Each resolved account gets a stable `accountKey` (alias or cookie-derived
 * hash) for cache keying and `usage.accounts[].accountKey`.
 *
 * @returns {{ accounts: Array<{ cookie: string, alias?: string, accountKey: string }>, records: object[] }}
 */
function resolveCredential() {
  const records = loadCredentials().filter((record) => record.providerId === providerId);
  const out = [];

  const pushIfValid = (entry, fallbackKey, record) => {
    if (!entry || typeof entry !== 'object') return;
    const cookie = typeof entry.cookie === 'string' ? entry.cookie : null;
    if (!cookie) return;
    if (!extractCsrfToken(cookie)) return;
    const alias =
      typeof entry.alias === 'string' && entry.alias.length > 0
        ? entry.alias
        : typeof record?.label === 'string' && record.label.length > 0
          ? record.label
          : undefined;
    out.push({
      cookie,
      alias,
      accountKey: record?.id ?? alias ?? fallbackKey ?? cookie.slice(0, 16),
    });
  };

  records.forEach((record, recordIndex) => {
    const cred = record.credential;
    if (Array.isArray(cred?.accounts) && cred.accounts.length > 0) {
      cred.accounts.forEach((acct, idx) =>
        pushIfValid(acct, `Account ${recordIndex + 1}.${idx + 1}`, record),
      );
    } else {
      pushIfValid(cred, `Account ${recordIndex + 1}`, record);
    }
  });

  return { accounts: out, records };
}

function findMalformedCredential(records) {
  for (const record of records) {
    const cred = record.credential;
    if (cred && typeof cred.cookie === 'string' && !extractCsrfToken(cred.cookie)) {
      return true;
    }
    if (Array.isArray(cred?.accounts)) {
      for (const account of cred.accounts) {
        if (account && typeof account.cookie === 'string' && !extractCsrfToken(account.cookie)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Build the canonical Mistral tRPC request headers (verbatim from the
 * console.mistral.ai web client).
 *
 * @param {string} cookie
 * @returns {Record<string, string>|null} - null when csrftoken cannot be extracted
 */
function mistralHeaders(cookie) {
  const csrfToken = extractCsrfToken(cookie);
  if (!csrfToken) return null;
  return {
    Cookie: cookie,
    'x-csrftoken': csrfToken,
    'trpc-accept': 'application/jsonl',
    'User-Agent': MISTRAL_USER_AGENT,
  };
}

/**
 * Parse the canonical Mistral tRPC batch response text into the fields the
 * canonical `queryMistralAccount` extracts: `usage_percentage`, `reset_at`,
 * and `email`. Mirrors the regex-based parsing exactly.
 *
 * @param {string} text
 * @returns {{ usagePercentage: number|null, resetAt: string|null, email: string|null }}
 */
function parseTrpcBatch(text) {
  let usagePercentage = null;
  let resetAt = null;
  let email = null;

  const pctMatch = text.match(/"usage_percentage"\s*:\s*(\d+(?:\.\d+)?)/);
  if (pctMatch) usagePercentage = parseFloat(pctMatch[1]);
  const resetMatch = text.match(/"reset_at"\s*:\s*"([^"]+)"/);
  if (resetMatch) resetAt = resetMatch[1];
  const emailMatch = text.match(/"email"\s*:\s*"([^"]+)"/);
  if (emailMatch) email = emailMatch[1];

  return { usagePercentage, resetAt, email };
}

/**
 * Transform one account's parsed tRPC fields into an OpenChamber usage
 * window set + identity metadata. Mirrors the canonical field mapping:
 *   - `usedPercent = usagePercentage` (canonical `remaining = 100 - usage`)
 *   - `remainingPercent = 100 - usagePercentage`
 *   - `valueLabel = "Vibe Usage"`
 *   - `sectionHeader` = email (or alias when they differ)
 *   - `trendKey = "Vibe Usage · <identity>"`
 *
 * @param {{ usagePercentage: number|null, resetAt: string|null, email: string|null }} parsed
 * @param {{ cookie: string, alias?: string, accountKey: string }} account
 * @param {string} fallbackLabel
 * @returns {{ windows: object, subtitle: string, note?: string }|null} - null when usage_percentage is missing
 */
function transformAccount(parsed, account, fallbackLabel) {
  if (parsed.usagePercentage === null) return null;

  const usedPercent = parsed.usagePercentage;
  const identity = parsed.email ?? account.alias ?? fallbackLabel;
  const sectionHeader =
    account.alias && parsed.email && account.alias !== parsed.email
      ? `${parsed.email} (${account.alias})`
      : identity;

  const windows = {
    '1d': toUsageWindow({
      usedPercent,
      windowSeconds: 86400,
      resetAt: parsed.resetAt ?? undefined,
      valueLabel: 'Vibe Usage',
      sectionHeader,
      trendKey: `Vibe Usage · ${identity}`,
    }),
  };

  return { windows, subtitle: identity };
}

/**
 * Query a single Mistral account via the canonical tRPC batch endpoint.
 *
 * @param {{ cookie: string, alias?: string, accountKey: string }} account
 * @param {string} fallbackLabel
 * @returns {Promise<{ ok: true, usage: { windows: object, subtitle: string } }|{ ok: false, status?: number, error: string }>}
 */
async function queryMistralAccount(account, fallbackLabel) {
  const headerError = cookieHeaderValidationError(account.cookie);
  if (headerError) {
    return { ok: false, error: `${fallbackLabel}: ${headerError}` };
  }

  const headers = mistralHeaders(account.cookie);
  if (!headers) {
    return {
      ok: false,
      error: `Could not extract csrftoken from cookie for ${fallbackLabel}`,
    };
  }

  let response;
  try {
    response = await fetchWithRetry(MISTRAL_TRPC_URL, {
      method: 'GET',
      headers,
      timeout: MISTRAL_TIMEOUT_MS,
      maxRetries: 0,
      retryDelay: 1000,
    });
  } catch (err) {
    // Transient (network/timeout/retry-exhausted) — rethrow so the caller
    // can decide on stale-cache fallback.
    throw err;
  }

  if (!response.ok) {
    // 401/403/4xx — auth or request errors. No cache fallback: a stale
    // snapshot cannot confirm whether the credential is still valid.
    return { ok: false, status: response.status, error: `API error: ${response.status}` };
  }

  let text;
  try {
    text = await response.text();
  } catch {
    return { ok: false, error: 'Invalid response from provider' };
  }

  const parsed = parseTrpcBatch(text);
  const transformed = transformAccount(parsed, account, fallbackLabel);
  if (!transformed) {
    return { ok: false, error: `${fallbackLabel}: failed to parse usage_percentage from response` };
  }

  return { ok: true, usage: transformed };
}

export const isConfigured = () => {
  const { accounts } = resolveCredential();
  return accounts.length > 0;
};

export const fetchQuota = async () => {
  const { accounts, records } = resolveCredential();

  if (accounts.length === 0) {
    if (findMalformedCredential(records)) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: false,
        error: 'Malformed credential: cookie must contain csrftoken= or csrf_token_<id>=',
      });
    }
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured',
    });
  }

  const cacheKey = accounts.map((a) => a.accountKey).join('|');

  try {
    const results = await Promise.all(
      accounts.map((acct, idx) =>
        queryMistralAccount(acct, acct.alias ?? `Account ${idx + 1}`).catch((err) => ({
          ok: false,
          thrown: true,
          error: err instanceof Error ? err.message : 'Request failed',
        })),
      ),
    );

    // Separate successful transforms from failures. A thrown fetch (transient)
    // is distinguished from a non-ok response (auth/parse).
    const accountUsages = [];
    const failedAccounts = [];
    const errors = [];
    let hadThrown = false;
    for (const [idx, r] of results.entries()) {
      const account = accounts[idx];
      if (r.thrown) {
        hadThrown = true;
        errors.push(r.error);
        failedAccounts.push({ account, error: r.error });
      } else if (r.ok) {
        accountUsages.push({ account, usage: r.usage });
      } else if (typeof r.status === 'number') {
        // Non-ok HTTP (401/403/4xx) — surface as a hard error, no cache fallback.
        errors.push(r.error);
        failedAccounts.push({ account, error: r.error });
      } else {
        errors.push(r.error);
        failedAccounts.push({ account, error: r.error });
      }
    }

    // If every account failed with a hard (non-transient) error, return the
    // error directly — no stale fallback for auth/parse failures.
    if (accountUsages.length === 0) {
      if (hadThrown) {
        // At least one transient failure: fall through to cache fallback.
        throw new Error(errors.join('; ') || 'Request failed');
      }
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: errors.length > 0 ? errors.join('; ') : 'No account data returned',
      });
    }

    // Build the multi-account usage shape. The FIRST successful account's
    // data is placed at the top level AND every account (including the
    // first) is emitted into usage.accounts[].
    const accountsOut = accountUsages.map(({ account, usage }) => {
      return {
        accountKey: account.accountKey,
        label: account.alias ?? undefined,
        subtitle: usage.subtitle,
        windows: usage.windows,
      };
    });
    for (const { account, error } of failedAccounts) {
      accountsOut.push({
        accountKey: account.accountKey,
        label: account.alias ?? undefined,
        subtitle: 'Failed to refresh usage data',
        note: error,
      });
    }

    const first = accountUsages[0].usage;
    const usage = {
      windows: first.windows,
      subtitle: first.subtitle,
      accounts: accountsOut,
    };

    const result = buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage,
    });

    resultCache.set(cacheKey, { ...result, cachedAt: Date.now() });
    return result;
  } catch (error) {
    // Retryable failure (429/5xx exhausted, network error, timeout).
    // Fall back to cached result if available.
    const cached = resultCache.get(cacheKey);
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
