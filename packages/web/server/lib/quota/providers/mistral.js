/**
 * Mistral AI quota — key-validity class.
 *
 * Mistral exposes no usage or balance read to a standard API key:
 * `GET /v1/usage` and `GET /v1/billing` return 404, and the Admin usage
 * API (`/v1/admin/usage`, `/v1/admin/analytics/vibe`) is Enterprise-plan
 * only behind a separate Admin API key the fleet does not hold
 * (openchamber#1619, probed 2026-11-04). The Vibe plan's usage has the
 * same property: the Vibe credential answers plan identity
 * (`GET https://console.mistral.ai/api/vibe/whoami` — plan EDU, probed
 * 2026-11-04 after the `vibe --setup` sign-in) but no consumption figure
 * exists on any probed surface (API host, console host, Le Chat tRPC).
 * API credits are console-session-only (`/api/billing/credits` refuses
 * API keys with 401); the browser-dependent read for those is
 * openchamber#1630.
 *
 * So this provider tracks the one thing this credential class can
 * prove: the key itself. `GET /v1/models` with the enrolled OpenCode
 * `mistral` credential: 200 → the key is live, and usage carries empty
 * windows plus the `usageAvailability: 'console-only'` marker so the
 * board renders "tracked, console-only" instead of missing data;
 * 401/403 → the unauthorized class; a 200 without the documented
 * `data` array → the malformed class; transport failure → the error
 * class. No usage or balance figures are ever emitted — absence of
 * data is represented honestly, not as zero.
 */

import { readQuotaJson } from '../utils/response-body.js';
import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'mistral';
export const providerName = 'Mistral AI';
export const aliases = ['mistral'];

const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models';

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token) ?? asNonEmptyString(entry?.access));
};

const fetchQuotaForEntry = async (entry) => {
  const apiKey = asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token) ?? asNonEmptyString(entry?.access);

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(MISTRAL_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401 || response.status === 403
          ? 'Invalid or revoked API key — Mistral rejected the enrolled credential'
          : `API error: ${response.status}`
      });
    }

    const payload = await readQuotaJson(response);

    if (!Array.isArray(payload?.data)) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: {
        windows: {},
        usageAvailability: 'console-only'
      }
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && (
      error.name === 'TimeoutError' || (error.name === 'AbortError' && timeoutSignal.aborted)
    );
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials } = {}) => {
  const auth = await readAuth();
  return fetchQuotaForEntry(normalizeAuthEntry(getAuthEntry(auth, aliases)));
};

/** Quota for one stored credential row, fetched with that row's own key. */
export const fetchQuotaForCredential = async (credential) => (
  fetchQuotaForEntry(normalizeAuthEntry(credential?.value))
);
