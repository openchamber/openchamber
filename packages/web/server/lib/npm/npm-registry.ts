import fs from 'fs';
import path from 'path';
import { findWebCheckoutRoot } from '../web-package-paths.js';

import { resolveNpmRegistryRequest } from './npm-registry-config.js';
import { readBoundedResponseText } from '../shared/response-body.js';
import { isString } from '../shared/object-guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

const NPM_CACHE_TTL_MS = 3_600_000;
const NPM_CACHE_MAX_ENTRIES = 500;
const NPM_FETCH_TIMEOUT_MS = 5_000;

// Full packuments for prolific packages run to megabytes; only dist-tags and
// version keys are read, so ask for the abbreviated install-v1 shape and cap
// the read at a generous 16 MiB. Mirrors that ignore the Accept value return
// the full packument and the cap still applies.
export const NPM_PACKUMENT_MAX_BYTES = 16 * 1024 * 1024;
const NPM_ACCEPT = 'application/vnd.npm.install-v1+json';

export interface NpmPackagePayload {
  ok: true;
  latest: string | null;
  versions: string[];
  distTags: Record<string, string>;
}

export interface NpmLookupError {
  ok: false;
  status: number | 'network';
  error: string;
}

export type NpmLookupResult = NpmPackagePayload | NpmLookupError;

export interface NpmInfoOptions {
  forceRefresh?: boolean;
}

interface CacheEntry {
  fetchedAt: number;
  payload: NpmLookupResult;
}

const _cache = new Map<string, CacheEntry>();

const _inFlight = new Map<string, Promise<NpmLookupResult>>();

let _userAgent: string | null = null;

const isMetadataObject = (value: JsonValue | undefined): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasMessage = (cause: unknown): cause is { message: unknown } =>
  cause !== null && (typeof cause === 'object' || typeof cause === 'function') && 'message' in cause;

function _getUserAgent() {
  if (_userAgent) return _userAgent;

  try {
    const checkoutRoot = findWebCheckoutRoot();
    if (!checkoutRoot) return (_userAgent = 'openchamber-server/dev');
    const pkg: JsonValue = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'package.json'), 'utf8'));
    if (pkg === null) return (_userAgent = 'openchamber-server/dev');
    const version = isMetadataObject(pkg) ? pkg.version : undefined;
    _userAgent = `openchamber-server/${isString(version) ? version : '0.0.0'}`;
  } catch {
    _userAgent = 'openchamber-server/dev';
  }

  return _userAgent;
}

function parseDistTags(value: JsonValue | undefined): Record<string, string> {
  if (!isMetadataObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => isString(entry[1])),
  );
}

function parseVersions(value: JsonValue | undefined) {
  if (!isMetadataObject(value)) {
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

function cacheResult(name: string, payload: NpmLookupResult) {
  if (payload.ok || payload.status === 404) {
    _cache.delete(name);
    _cache.set(name, { fetchedAt: Date.now(), payload });
    pruneCache();
  }
}

export async function lookupNpmPackage(name: string): Promise<NpmLookupResult> {
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
        versions: parseVersions(isMetadataObject(data) ? data.versions : undefined),
        distTags,
      };
    }

    if (response.status === 404) {
      return { ok: false, status: 404, error: 'Package not found' };
    }

    return { ok: false, status: response.status, error: `Registry returned ${response.status}` };
  } catch (error) {
    return { ok: false, status: 'network', error: String((hasMessage(error) ? error.message : undefined) ?? error) };
  }
}

export async function getNpmInfo(name: string, options: NpmInfoOptions = {}): Promise<NpmLookupResult> {
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
