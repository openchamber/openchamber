/**
 * Ollama Cloud subscription quota, read from `GET https://ollama.com/api/usage`
 * with the same API key as the chat requests.
 *
 * Mirrors `packages/web/server/lib/quota/providers/ollama-cloud.js`. This used
 * to scrape `ollama.com/settings` with a browser session cookie, which broke
 * whenever the user signed out.
 */

type OllamaWindow = { usedPercent: number | null };
type OllamaFetch = (url: string, init: RequestInit) => Promise<Response>;

const USAGE_URL = 'https://ollama.com/api/usage';

/**
 * A JSON value as it arrives from the response body. This is the boundary where
 * the payload becomes trusted, so the guards below are the only place a raw
 * value is narrowed.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const isJsonObject = (value: JsonValue | null | undefined): value is { [key: string]: JsonValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: JsonValue | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * One bucket's `usage`, as a fraction of the allowance. The endpoint is
 * undocumented, so a value that is not a real number is neither guessed at nor
 * coerced: a numeric string is rejected, because a plan reported as `"0.5"` is
 * a shape change rather than a number.
 */
const toUsageFraction = (bucket: JsonValue | null | undefined): number | null => {
  if (!isJsonObject(bucket)) return null;
  const usage: JsonValue = bucket.usage;
  return isFiniteNumber(usage) ? usage : null;
};

/**
 * Map every usable bucket onto a window, by the name the API used, so a plan
 * is never relabelled into a window the plan does not have. `usage` is clamped
 * because a plan at or over its cap must read as 100, never above. Each bucket
 * is checked on its own, so an unfamiliar one costs only itself.
 */
// Not exported: the cases that pin this mapping (clamping, an unfamiliar
// bucket costing only itself, a fraction that is not a number) are asserted
// through `fetchOllamaCloudQuota`, which is how the web twin's suite pins
// `toUsageWindows` there.
const toOllamaUsageWindows = (payload: JsonValue | null | undefined) => {
  const windows: Record<string, OllamaWindow> = {};
  if (!isJsonObject(payload) || !isJsonObject(payload.limits)) return windows;
  for (const [name, raw] of Object.entries(payload.limits)) {
    const usage = toUsageFraction(raw);
    if (!name || usage === null) continue;
    windows[name] = { usedPercent: Math.min(100, Math.max(0, usage * 100)) };
  }
  return windows;
};

export const fetchOllamaCloudUsage = async (
  apiKey: string,
  fetchImpl: OllamaFetch = fetch,
): Promise<Record<string, OllamaWindow>> => {
  const response = await fetchImpl(USAGE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Ollama Cloud authentication failed');
  if (!response.ok) throw new Error(`Ollama Cloud returned HTTP ${response.status}`);

  // Three distinct failures, kept distinct: an unreadable body throws from
  // `json()` (transport), a body that is not a usage response is a shape we do
  // not understand, and a valid body with no buckets is no usage data.
  //
  // SAFETY: `json()` resolves with a value built by the JSON parser, whose only
  // outputs are strings, numbers, booleans, null, arrays and plain objects —
  // exactly the `JsonValue` union. `toOllamaUsageWindows` is the boundary that
  // narrows it from there.
  const body = (await response.json()) as JsonValue;
  const windows = toOllamaUsageWindows(body);
  if (Object.keys(windows).length === 0) throw new Error('Ollama Cloud usage data could not be parsed');
  return windows;
};
