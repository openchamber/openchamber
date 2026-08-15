import fs from 'fs';
import os from 'os';
import path from 'path';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const SETTINGS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'settings.json');

// Built-in defaults are applied at read time by getters; they are never
// persisted (sanitizeGitProviders only stores user-provided overrides).
const GIT_PROVIDER_KEYS = ['github', 'gitlab', 'gitea'];
export const GIT_PROVIDER_DEFAULTS = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com',
  gitea: null,
};

/**
 * Normalize a user-provided API base URL. Adds `https://` when no scheme is
 * present, strips a trailing slash, preserves any subpath (e.g. `/gitlab`),
 * and returns null for anything unparseable or empty.
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  let value = raw.trim();
  if (!value) {
    return null;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = `https://${value}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!parsed.hostname) {
    return null;
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/+$/, '');
}

const normalizeHost = (host) =>
  String(host || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');

/**
 * Extract the bare lowercase hostname from any git remote / URL form:
 * `https://host/...`, `ssh://git@host/...`, scp-like `git@host:path`,
 * `host:path`, and bracketed or unbracketed IPv6. Returns null for empty or
 * unparseable input.
 */
export function normalizeDetectionHost(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }

  // scp-like form: [user@]host:path — never applies once a scheme is present.
  if (!value.includes('://')) {
    const authority = value.slice(value.lastIndexOf('@') + 1);
    // Bracketed IPv6, e.g. `[2001:db8::1]` or `[2001:db8::1]:owner/repo.git`.
    if (authority.startsWith('[')) {
      const close = authority.indexOf(']');
      if (close > 0 && authority.slice(1, close).includes(':')) {
        return normalizeHost(authority.slice(1, close));
      }
      // Malformed brackets fall through to URL parsing, which rejects them.
    } else {
      const colon = authority.indexOf(':');
      if (colon > 0) {
        const candidate = authority.slice(0, colon);
        // A single-segment pre-colon value without a dot is not a host — the
        // guard rejects Windows paths like `C:\foo`. Hosts with a numeric
        // port (`localhost:3000`) still resolve via the URL branch.
        if (!candidate.includes('/') && candidate.includes('.')) {
          return normalizeHost(candidate);
        }
      }
      // Unbracketed IPv6 (e.g. `2001:db8::1`): parse as a bracketed host.
      if (authority.includes(':') && !authority.includes('/') && authority.length > 2) {
        try {
          return normalizeHost(new URL(`ssh://[${authority}]`).hostname);
        } catch {
          // Not IPv6; fall through to generic URL parsing.
        }
      }
    }
  }

  try {
    const parsed = new URL(value.includes('://') ? value : `ssh://${value}`);
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

const sanitizeDetectionHosts = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const hosts = [];
  for (const raw of value) {
    const host = normalizeDetectionHost(raw);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
};

/**
 * Validate and normalize a `gitProviders` settings value. Only the known
 * provider keys (github|gitlab|gitea) survive; per provider, `apiBaseUrl` is
 * normalized via normalizeBaseUrl and `detectUrls` becomes a deduped array of
 * bare hostnames. Empty/absent values are dropped. Returns undefined when
 * nothing valid remains, otherwise the normalized partial object.
 */
export function sanitizeGitProviders(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const result = {};
  for (const provider of GIT_PROVIDER_KEYS) {
    const entry = payload[provider];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const normalized = {};
    if (entry.apiBaseUrl !== undefined && entry.apiBaseUrl !== null) {
      const baseUrl = normalizeBaseUrl(entry.apiBaseUrl);
      if (baseUrl) normalized.apiBaseUrl = baseUrl;
    }
    if (entry.detectUrls !== undefined && entry.detectUrls !== null) {
      const hosts = sanitizeDetectionHosts(entry.detectUrls);
      if (hosts.length > 0) normalized.detectUrls = hosts;
    }
    if (Object.keys(normalized).length > 0) {
      result[provider] = normalized;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Read the `gitProviders` section of the user settings file
 * (`~/.config/openchamber/settings.json`, overridable via
 * OPENCHAMBER_DATA_DIR). Never throws; returns {} on missing/invalid data.
 */
export function readGitProvidersConfig() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
      return sanitizeGitProviders(parsed.gitProviders) ?? {};
    }
  } catch {
    // ignore
  }
  return {};
}

/**
 * Effective API base URL for a provider: the configured settings.json value if
 * present, else the built-in default (null for gitea, which has none).
 */
export function getProviderApiBaseUrl(provider) {
  return readGitProvidersConfig()[provider]?.apiBaseUrl || GIT_PROVIDER_DEFAULTS[provider] || null;
}

/**
 * Derive the GitHub web origin from an API base URL. The public API host
 * (`https://api.github.com`) maps to `https://github.com`; an Enterprise API
 * base (`https://host/api/v3` or `https://host/api`) maps to `https://host`
 * (trailing `/api[/v3]` path segments are stripped, so subpath installs like
 * `https://host/ghe/api/v3` keep their prefix). Anything else yields the
 * origin of the URL. Never throws; falls back to `https://github.com`.
 */
export function githubWebOriginFromApiBase(apiBase) {
  try {
    const url = new URL(apiBase);
    if (!url.hostname) {
      return 'https://github.com';
    }
    if (url.hostname === 'api.github.com') {
      return 'https://github.com';
    }
    const pathname = url.pathname.replace(/\/+$/, '');
    const stripped = pathname.replace(/\/api\/v3$/, '').replace(/\/api$/, '');
    return `${url.protocol}//${url.host}${stripped}`;
  } catch {
    return 'https://github.com';
  }
}
