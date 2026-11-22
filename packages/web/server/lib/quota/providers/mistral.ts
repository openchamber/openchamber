import { readOpenCodeCredentials } from '../../opencode/auth.js';
import type { LegacyAuthFile } from '../../opencode/auth.js';
import { asAuthFields } from './fields.js';
import { asNonEmptyString, buildResult, getAuthEntry, normalizeAuthEntry } from '../utils/index.js';
import { readQuotaJson } from '../utils/response-body.js';
import { fetchMistralUsage } from './mistral-billing.js';

export const providerId = 'mistral';
export const providerName = 'Mistral AI';
export const aliases = ['mistral'];

const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models';

const apiKeyOfEntry = <Entry>(value: Entry) => {
  const entry = asAuthFields(normalizeAuthEntry(value));
  return asNonEmptyString(entry?.key) ?? asNonEmptyString(entry?.token) ?? asNonEmptyString(entry?.access);
};

const apiKeyOf = (auth: LegacyAuthFile) => apiKeyOfEntry(getAuthEntry(auth, aliases));

export const isConfigured = (auth: LegacyAuthFile) => Boolean(apiKeyOf(auth));

const errorMessage = <Failure>(error: Failure) => (error instanceof Error ? error.message : 'Request failed');

/**
 * A standard API key on a plan without a billing allowance answers the
 * budget read with 404 (openchamber#1619, probed 2026-11-04): no usage
 * figure exists for it on any surface. The one thing that key proves is
 * itself, so `GET /v1/models` decides live (empty windows and the
 * `console-only` marker, which the usage page renders as "tracked,
 * console-only") or rejected. No usage or balance figure is ever invented.
 */
const fetchKeyValidity = async (apiKey: string) => {
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(MISTRAL_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Accept-Encoding': 'identity' },
      signal
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
      return buildResult({ providerId, providerName, ok: false, configured: true, error: 'No quota data in response' });
    }
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: {}, usageAvailability: 'console-only' }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: signal.aborted ? 'Request timed out' : error instanceof SyntaxError ? 'Invalid response from provider' : errorMessage(error)
    });
  }
};

const fetchQuotaForKey = async (apiKey: string | null) => {
  if (!apiKey) {
    return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
  }

  try {
    const { windows, planLabel } = await fetchMistralUsage(apiKey);
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: { windows }, planLabel });
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) {
      return fetchKeyValidity(apiKey);
    }
    return buildResult({ providerId, providerName, ok: false, configured: true, error: errorMessage(error) });
  }
};

export const fetchQuota = async ({ readAuth = readOpenCodeCredentials }: { readAuth?: () => Promise<LegacyAuthFile> } = {}) => (
  fetchQuotaForKey(apiKeyOf(await readAuth()))
);

/** Quota for one stored credential row, fetched with that row's own key. */
export const fetchQuotaForCredential = async (credential: { value?: unknown } | null | undefined) => (
  fetchQuotaForKey(apiKeyOfEntry(credential?.value))
);
