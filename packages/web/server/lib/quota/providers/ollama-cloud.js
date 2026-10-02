/**
 * Ollama Cloud subscription quota.
 *
 * Reads the account usage from `GET https://ollama.com/api/usage` using the
 * same Ollama Cloud API key as the chat requests, so the tracker follows the
 * account OpenCode has active with no extra credential to paste. This used to
 * scrape `ollama.com/settings` with a browser session cookie, which broke
 * whenever the user signed out and had to be re-copied by hand.
 *
 * @module quota/providers/ollama-cloud
 */

import { readOpenCodeCredentials } from '../../opencode/auth.js';
import { deleteLegacyOllamaCloudCredential } from '../credentials/store.js';
import { asNonEmptyString, asObject, buildResult, getAuthEntry, normalizeAuthEntry, toUsageWindow } from '../utils/index.js';

export const providerId = 'ollama-cloud';
export const providerName = 'Ollama Cloud';
export const aliases = ['ollama-cloud', 'ollamacloud'];

const USAGE_URL = 'https://ollama.com/api/usage';

/**
 * `normalizeAuthEntry` hands back whatever the credential entry happened to
 * hold, so the key is read as a trimmed non-empty string and nothing else. A
 * number, an object or a blank string is not a usable key.
 */
const getApiKey = (auth) => {
  const entry = asObject(normalizeAuthEntry(getAuthEntry(auth, aliases)));
  if (!entry) return null;
  return asNonEmptyString(entry.key) ?? asNonEmptyString(entry.token);
};

/**
 * One bucket's `usage`, as a fraction of the allowance. The endpoint is
 * undocumented, so a value that is not a real number is not guessed at and not
 * coerced: a numeric string is rejected rather than read, because a plan
 * reported as `"0.5"` is a shape change, not a number.
 */
const toUsageFraction = (bucket) => {
  const usage = asObject(bucket)?.usage;
  return typeof usage === 'number' && Number.isFinite(usage) ? usage : null;
};

/**
 * Map every usable bucket onto a window, under the name the API used, so a plan
 * is never relabelled into a window the plan does not have. `usage` is a
 * fraction of the allowance (0..1), clamped because a plan at or over its cap
 * must read as 100 and never above.
 *
 * Each bucket is checked on its own, because the endpoint has changed shape
 * repeatedly: separate `session` and `weekly` buckets, then a single `monthly`
 * one, then back again. A bucket we do not recognise must cost the user only
 * that bucket, never the whole tracker.
 *
 * Takes an already-parsed payload; a body that is not a usage response is
 * rejected by the caller rather than quietly read as "no usage".
 */
export const toUsageWindows = (payload) => {
  const windows = {};
  const limits = asObject(asObject(payload)?.limits);
  // `asObject` accepts an array, whose entries are indices, so an array-shaped
  // `limits` would render as windows named `0`, `1`, ... The VS Code twin
  // rejects anything that is not a plain object, and the two must agree.
  if (!limits || Array.isArray(limits)) return windows;
  for (const [name, raw] of Object.entries(limits)) {
    const usage = toUsageFraction(raw);
    if (!name || usage === null) continue;
    windows[name] = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, usage * 100)),
      windowSeconds: null,
      resetAt: null,
    });
  }
  return windows;
};

export const isConfigured = (auth) => Boolean(getApiKey(auth));

export const fetchOllamaCloudUsage = async (apiKey, fetchImpl = fetch) => {
  const response = await fetchImpl(USAGE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Ollama Cloud authentication failed');
  }
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);

  // Three distinct failures, kept distinct: an unreadable body throws from
  // `json()` (transport), a body that is not a usage response is a shape we do
  // not understand, and a valid body with no buckets carries no usage data.
  const windows = toUsageWindows(await response.json());
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};

export const fetchQuota = async () => {
  try {
    const apiKey = getApiKey(await readOpenCodeCredentials());
    if (!apiKey) {
      return buildResult({ providerId, providerName, ok: false, configured: false, error: 'Not configured' });
    }

    // The cookie this provider used to store is obsolete the first time we reach
    // for the key instead, mirroring the OpenCode Go cleanup. It waits for the
    // key: a refresh that could not read one has proved nothing.
    deleteLegacyOllamaCloudCredential();

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows: await fetchOllamaCloudUsage(apiKey) },
    });
  } catch (error) {
    // A credential read that threw means OpenCode could not be asked, which is
    // not the same as the user having no key. The reason travels out instead of
    // an empty answer wearing the shape of one, as `auth.js` insists.
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed',
    });
  }
};
