/**
 * Model prices a provider reports next to its quota.
 *
 * DeepInfra runs discount campaigns (51 % off DeepSeek-V4.1-Flash-1017 at the
 * time of writing) and bills the reduced price, while OpenCode's price list
 * comes from models.dev and carries the provider's list price. The usage panel
 * reads the provider every few minutes anyway, so that same read asks for the
 * price list too: one refresh answers the credit balance and the prices.
 *
 * The prices land in OpenChamber's own OpenCode config layer
 * (`opencode.managed.json`), which OpenCode watches and applies while it runs,
 * so the model card and the cost of a running session show what the provider
 * actually charges. Only the models the user configured for that provider are
 * written: OpenCode reads a `models` entry as a model to offer, so a whole
 * provider catalogue would flood the model picker.
 *
 * A refresh that fails, times out or finds no campaign price changes nothing:
 * the quota answer never depends on it.
 *
 * @module quota/model-prices
 */

import { readConfigLayers } from '../opencode/shared.js';
import { isRecord, toProviderEntity } from '../opencode/config-v2.js';
import { fetchPrices as fetchDeepInfraPrices } from './providers/deepinfra.js';

/** A campaign price changes rarely; half an hour keeps the extra reads cheap. */
const PRICE_TTL_MS = 30 * 60 * 1000;

/** Providers that report prices beside their quota, keyed by quota provider id. */
const PRICE_SOURCES = new Map([
  ['deepinfra', fetchDeepInfraPrices],
]);

let sink = null;
const lastRefreshAt = new Map();
const inFlight = new Map();

/**
 * The server that writes prices into the OpenCode config layer (`index.js`).
 * Without a sink the prices are read and dropped.
 *
 * @param {((providerId: string, costs: Record<string, {input: number, output: number, cache_read?: number, cache_write?: number}>) => Promise<boolean>)|null} nextSink
 */
export const registerModelPriceSink = (nextSink) => {
  sink = typeof nextSink === 'function' ? nextSink : null;
};

/** The quota providers whose answer carries prices. */
export const modelPriceProviders = () => [...PRICE_SOURCES.keys()];

/** Forget the TTL and in-flight marks. The tests use it; the server does not. */
export const resetModelPriceCache = () => {
  lastRefreshAt.clear();
  inFlight.clear();
};

/**
 * The model ids the user configured for a provider, read from every config
 * layer (v2 `providers` and the legacy v1 `provider`).
 *
 * @param {string} providerId
 * @returns {string[]}
 */
const configuredModelIds = (providerId) => {
  try {
    const { mergedConfig } = readConfigLayers();
    const ids = new Set();
    for (const sectionKey of ['providers', 'provider']) {
      const section = mergedConfig?.[sectionKey];
      if (!isRecord(section)) continue;
      const entry = toProviderEntity(section[providerId]);
      for (const id of Object.keys(entry?.models ?? {})) ids.add(id);
    }
    return [...ids];
  } catch {
    // An unreadable config means no models to price, not a failed quota read.
    return [];
  }
};

/**
 * Read a provider's prices and hand them to the config layer.
 *
 * One read per `ttlMs` and provider; identical reads in flight share one
 * request.
 *
 * @param {string} providerId
 * @param {object} [options]
 * @param {number} [options.now] clock, for tests
 * @param {boolean} [options.force] ignore the TTL
 * @param {number} [options.ttlMs]
 * @param {(providerId: string) => string[]} [options.readModelIds]
 * @param {Map<string, Function>} [options.sources]
 * @param {(providerId: string, costs: object) => Promise<boolean>} [options.notify]
 * @returns {Promise<{updated: boolean, reason: string, error?: Error}>}
 */
export const refreshProviderPrices = async (providerId, {
  now = Date.now(),
  force = false,
  ttlMs = PRICE_TTL_MS,
  readModelIds = configuredModelIds,
  sources = PRICE_SOURCES,
  notify = (nextProviderId, costs) => (sink ? sink(nextProviderId, costs) : Promise.resolve(false)),
} = {}) => {
  const fetchPrices = sources.get(providerId);
  if (!fetchPrices) return { updated: false, reason: 'no-price-source' };

  const modelIds = readModelIds(providerId);
  if (modelIds.length === 0) return { updated: false, reason: 'no-configured-models' };

  const last = lastRefreshAt.get(providerId) ?? 0;
  if (!force && last > 0 && now - last < ttlMs) return { updated: false, reason: 'fresh' };

  const running = inFlight.get(providerId);
  if (running) return running;

  const run = (async () => {
    try {
      const costs = await fetchPrices({ modelIds });
      lastRefreshAt.set(providerId, now);
      if (!isRecord(costs) || Object.keys(costs).length === 0) return { updated: false, reason: 'no-prices' };
      const applied = await notify(providerId, costs);
      return applied ? { updated: true, reason: 'applied' } : { updated: false, reason: 'not-applied' };
    } catch (error) {
      return { updated: false, reason: 'failed', error };
    } finally {
      inFlight.delete(providerId);
    }
  })();
  inFlight.set(providerId, run);
  return run;
};
