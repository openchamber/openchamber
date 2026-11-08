import { readOpenCodeCredentials } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  formatMoney
} from '../utils/index.js';

export const providerId = 'deepinfra';
export const providerName = 'DeepInfra';
const aliases = ['deepinfra', 'deep-infra', 'deep_infra'];
const DEEPINFRA_ME_URL = 'https://api.deepinfra.com/v1/me?checklist=true';
const DEEPINFRA_MODELS_URL = 'https://api.deepinfra.com/v1/models';

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
// Six decimals hold a campaign price exactly ($0.00294 for a $0.006 read).
const perMillion = (value) => Math.round(value * 1e6) / 1e6;

/**
 * The price DeepInfra bills per million tokens: `metadata.pricing` with
 * `metadata.discount` taken off. `discount` is the share, so 0.51 means 51 %
 * off, which is what the pricing page shows struck through beside the campaign
 * price. A missing, zero or nonsensical discount means the list price.
 *
 * @param {{input_tokens?: number, output_tokens?: number, cache_read_tokens?: number, cache_write_tokens?: number}} pricing
 * @param {number|null|undefined} discount
 * @returns {{input: number, output: number, cache_read?: number, cache_write?: number}|null}
 */
export const discountedCost = (pricing, discount) => {
  if (!isFiniteNumber(pricing?.input_tokens) || !isFiniteNumber(pricing?.output_tokens)) return null;
  const factor = isFiniteNumber(discount) && discount > 0 && discount < 1 ? 1 - discount : 1;
  const cost = {
    input: perMillion(pricing.input_tokens * factor),
    output: perMillion(pricing.output_tokens * factor)
  };
  if (isFiniteNumber(pricing.cache_read_tokens)) cost.cache_read = perMillion(pricing.cache_read_tokens * factor);
  if (isFiniteNumber(pricing.cache_write_tokens)) cost.cache_write = perMillion(pricing.cache_write_tokens * factor);
  return cost;
};

/**
 * Prices for the models the user configured, from DeepInfra's model list
 * (`GET /v1/models`, each entry's `metadata.pricing` and `metadata.discount`).
 * Models without token pricing (image, embedding) are skipped.
 *
 * @param {object} [options]
 * @param {string[]} [options.modelIds] ids to price; anything else is ignored
 * @param {() => Promise<object>} [options.readCredentials]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Record<string, {input: number, output: number, cache_read?: number, cache_write?: number}>>}
 */
export const fetchPrices = async ({
  modelIds = [],
  readCredentials = readOpenCodeCredentials,
  fetchImpl = fetch
} = {}) => {
  if (modelIds.length === 0) return {};

  const auth = await readCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;
  if (!apiKey) return {};

  const response = await fetchImpl(DEEPINFRA_MODELS_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Accept-Encoding': 'identity'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`DeepInfra model list: ${response.status}`);

  const payload = await response.json();
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const wanted = new Set(modelIds);
  const costs = {};
  for (const item of items) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (!id || !wanted.has(id)) continue;
    const cost = discountedCost(item?.metadata?.pricing, item?.metadata?.discount);
    if (cost) costs[id] = cost;
  }
  return costs;
};

export const isConfigured = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async ({ readCredentials = readOpenCodeCredentials } = {}) => {
  const auth = await readCredentials();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

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
    const response = await fetch(DEEPINFRA_ME_URL, {
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
          ? 'Session expired — please re-authenticate with DeepInfra'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    // Documented at https://docs.deepinfra.com/api-reference/account/me:
    // checklist.stripe_balance is negative when funds are ready to spend and
    // positive when money is owed, so the spendable credit is its negation.
    const rawBalance = payload?.checklist?.stripe_balance;
    // A blank or absent balance is missing data, not a $0.00 balance.
    const stripeBalance = String(rawBalance ?? '').trim() === '' ? null : toNumber(rawBalance);

    if (stripeBalance === null) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    const availableCredits = -stripeBalance;
    const symbol = availableCredits < 0 ? '-$' : '$';
    const valueLabel = `${symbol}${formatMoney(Math.abs(availableCredits))}`;

    const windows = {
      credits_balance: toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel
      })
    };

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
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
