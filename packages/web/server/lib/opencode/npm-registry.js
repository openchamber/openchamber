import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveNpmRegistryRequest } from './npm-registry-config.js';
import { readBoundedResponseText } from '../shared/response-body.js';

const NPM_CACHE_TTL_MS = 3_600_000;
const NPM_CACHE_MAX_ENTRIES = 500;
const NPM_FETCH_TIMEOUT_MS = 5_000;

// Full packuments for prolific packages run to megabytes; only dist-tags and
// version keys are read, so ask for the abbreviated install-v1 shape and cap
// the read at a generous 16 MiB. Mirrors that ignore the Accept value return
// the full packument and the cap still applies.
export const NPM_PACKUMENT_MAX_BYTES = 16 * 1024 * 1024;
const NPM_ACCEPT = 'application/vnd.npm.install-v1+json';

/**
 * @typedef {Object} NpmPackagePayload
 * @property {true} ok
 * @property {string|null} latest
 * @property {string[]} versions
 * @property {Record<string, string>} distTags
 *
 * @typedef {Object} NpmLookupError
 * @property {false} ok
 * @property {number|'network'} status
 * @property {string} error
 *
 * @typedef {NpmPackagePayload | NpmLookupError} NpmLookupResult
 * @typedef {{ forceRefresh?: boolean }} NpmInfoOptions
 * @typedef {{ fetchedAt: number, payload: NpmLookupResult }} CacheEntry
 */

/** @type {Map<string, CacheEntry>} */
const _cache = new Map();

/** @type {Map<string, Promise<NpmLookupResult>>} */
const _inFlight = new Map();

/** @type {string | null} */
let _userAgent = null;

function _getPackageJsonPath() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'package.json');
}

function _getUserAgent() {
  if (_userAgent) return _userAgent;

  try {
    const pkg = JSON.parse(fs.readFileSync(_getPackageJsonPath(), 'utf8'));
    _userAgent = `openchamber-server/${typeof pkg.version === 'string' ? pkg.version : '0.0.0'}`;
  } catch {
    _userAgent = 'openchamber-server/dev';
  }

  return _userAgent;
}

function parseDistTags(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => typeof entry[1] === 'string'),
  );
}

function parseVersions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  return Object.keys(value);
}

function pruneCache(now = Date.now()) {
  for (const [name, entry] of _cache) {
    if (now - entry.fetchedAt >= NPM_CACHE_TTL_MS) {
      _cache.delete(name);
    }
  }
  while (_cache.size > NPM_CACHE_MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest === undefined) break;
    _cache.delete(oldest);
  }
}

function cacheResult(name, payload) {
  if (payload.ok || payload.status === 404) {
    _cache.delete(name);
    _cache.set(name, { fetchedAt: Date.now(), payload });
    pruneCache();
  }
}

/**
 * Fetch package metadata directly from the npm registry.
 *
 * @param {string} name npm package name
 * @returns {Promise<NpmLookupResult>}
 */
export async function lookupNpmPackage(name) {
  try {
    const request = resolveNpmRegistryRequest(name);
    const response = await fetch(request.url, {
      headers: {
        'User-Agent': _getUserAgent(),
        Accept: NPM_ACCEPT,
        ...request.headers,
      },
      signal: AbortSignal.timeout(NPM_FETCH_TIMEOUT_MS),
    });

    if (response.ok) {
      const bounded = await readBoundedResponseText(response, NPM_PACKUMENT_MAX_BYTES);
      if (bounded.tooLarge) {
        return { ok: false, status: 'network', error: 'Registry response exceeded size limit' };
      }
      let data;
      try {
        data = JSON.parse(bounded.text);
      } catch {
        return { ok: false, status: 'network', error: 'Registry returned invalid JSON' };
      }
      const distTags = parseDistTags(data?.['dist-tags']);
      return {
        ok: true,
        latest: distTags.latest ?? null,
        versions: parseVersions(data?.versions),
        distTags,
      };
    }

    if (response.status === 404) {
      return { ok: false, status: 404, error: 'Package not found' };
    }

    return { ok: false, status: response.status, error: `Registry returned ${response.status}` };
  } catch (error) {
    return { ok: false, status: 'network', error: String(error?.message ?? error) };
  }
}

/**
 * Fetch package metadata with TTL cache and in-flight request deduplication.
 *
 * @param {string} name npm package name
 * @param {NpmInfoOptions} [options]
 * @returns {Promise<NpmLookupResult>}
 */
export async function getNpmInfo(name, options = {}) {
  const { forceRefresh = false } = options;
  pruneCache();
  const cached = _cache.get(name);
  if (cached && !forceRefresh && Date.now() - cached.fetchedAt < NPM_CACHE_TTL_MS) {
    return cached.payload;
  }

  const existing = _inFlight.get(name);
  if (existing && !forceRefresh) {
    return existing;
  }

  const lookup = (async () => {
    const result = await lookupNpmPackage(name);
    cacheResult(name, result);
    return result;
  })();

  _inFlight.set(name, lookup);
  try {
    return await lookup;
  } finally {
    if (_inFlight.get(name) === lookup) {
      _inFlight.delete(name);
    }
  }
}

export function clearCache() {
  _cache.clear();
  _inFlight.clear();
}
