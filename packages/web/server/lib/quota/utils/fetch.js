/**
 * Safe fetch wrapper
 *
 * Wraps the global `fetch` with timeout, retry, and exponential backoff
 * for quota provider API calls. Never includes raw request bodies or
 * headers in error messages.
 *
 * @module quota/utils/fetch
 */

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY = 1000;

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch with timeout, retry, and exponential backoff.
 *
 * Options (in addition to standard fetch options):
 * - `timeout` (default 30000ms): per-request timeout via AbortController
 * - `maxRetries` (default 2): number of retry attempts after the first failure
 * - `retryDelay` (default 1000ms): base delay; actual delay = retryDelay * 2^attempt
 *
 * Retryable status codes: 408, 429, 500, 502, 503, 504.
 * Non-retryable status codes (e.g. 400, 401, 403, 404) return the response
 * immediately.
 *
 * @param {string|URL} url
 * @param {Object & {timeout?: number, maxRetries?: number, retryDelay?: number}} [options]
 * @returns {Promise<Response>}
 * @throws {Error} on timeout, network failure, or retryable status exhaustion
 */
export async function fetchWithRetry(url, options = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelay = DEFAULT_RETRY_DELAY,
    ...fetchOptions
  } = options ?? {};

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      lastError =
        error?.name === 'AbortError'
          ? new Error(`Request timed out after ${timeout}ms`)
          : new Error('Network request failed');
      if (attempt === maxRetries) {
        throw lastError;
      }
      await sleep(retryDelay * Math.pow(2, attempt));
      continue;
    }
    clearTimeout(timeoutId);

    if (response.ok || !RETRYABLE_STATUS_CODES.has(response.status)) {
      return response;
    }

    lastError = new Error(`Request failed with status ${response.status}`);
    if (attempt === maxRetries) {
      throw lastError;
    }
    await sleep(retryDelay * Math.pow(2, attempt));
  }

  throw lastError ?? new Error('Request failed');
}
