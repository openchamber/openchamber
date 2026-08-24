import fs from 'fs';
import net from 'net';
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
  gitea: 'https://codeberg.org',
};

// Built-in detection hostnames: remotes on these hosts are recognized as the
// provider even when the user configures nothing. Configured detectUrls extend
// them — the built-ins always apply (mirrors the client-side detection in
// packages/ui/src/lib/gitProvider.ts).
export const GIT_PROVIDER_DEFAULT_DETECT_URLS = {
  github: ['github.com'],
  gitlab: ['gitlab.com'],
  gitea: ['codeberg.org'],
};

/**
 * Check whether a URL hostname resolves to a private, loopback, or
 * link-local IP address. Returns true when the host is clearly a
 * public/DNS name (no IP parsed, or a public IP). Returns false for
 * localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x,
 * 0.0.0.0, and IPv6 loopback/link-local/ULA addresses.
 */
function isPublicHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;

  // Strip brackets from IPv6 literals: [::1] → ::1
  const raw = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // localhost aliases
  if (raw === 'localhost' || raw === '') return false;

  // Use net module for reliable IP detection (handles hex normalization,
  // IPv4-mapped IPv6, etc.)
  if (net.isIPv4(raw)) return isPublicIPv4(raw);
  if (net.isIPv6(raw)) return isPublicIPv6(raw);

  // DNS name — assume public (enterprise forge hosts, gitlab.com, etc.)
  return true;
}

function isPublicIPv4(addr) {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
  // 172.16.0.0/12, 192.168.0.0/16
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function isPublicIPv6(addr) {
  // Loopback ::1
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return false;
  // Link-local fe80::/10
  if (addr.startsWith('fe80') || addr.startsWith('fe9') || addr.startsWith('fea') || addr.startsWith('feb')) return false;
  // Unique-local fc00::/7 (includes fd00::/8)
  if (addr.startsWith('fc') || addr.startsWith('fd')) return false;
  // Unspecified ::
  if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return false;
  // IPv4-mapped: ::ffff:x.x.x.x or ::ffff:hhhh:hhhh (hex-normalized by URL parser)
  if (addr.startsWith('::ffff:')) {
    const suffix = addr.slice(7);
    // Dotted form: 127.0.0.1
    if (net.isIPv4(suffix)) return isPublicIPv4(suffix);
    // Hex-normalized form: 7f00:1 → expand last 16-bit group to IPv4
    const hexParts = suffix.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return isPublicIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
      }
    }
  }
  return true;
}

/**
 * Validate that a URL is safe to send credentials to. The URL must:
 * - Use HTTPS (no HTTP, file://, etc.)
 * - Not resolve to a private/loopback/link-local IP
 * - Have a non-empty hostname
 *
 * Returns true when safe, false otherwise. Logs the reason on rejection.
 */
export function isSafeEndpointUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    console.warn(`[git-providers] rejected non-HTTPS endpoint: ${url}`);
    return false;
  }

  if (!isPublicHostname(parsed.hostname)) {
    console.warn(`[git-providers] rejected private/loopback endpoint: ${url}`);
    return false;
  }

  return true;
}

/**
 * Normalize a user-provided API base URL. Adds `https://` when no scheme is
 * present, strips a trailing slash, preserves any subpath (e.g. `/gitlab`),
 * and returns null for anything unparseable or empty.
 *
 * Rejects non-HTTPS URLs and endpoints that resolve to private/loopback IPs
 * to prevent stored credentials from being sent to untrusted hosts.
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
  if (!isSafeEndpointUrl(parsed.href)) {
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
 * present, else the built-in default.
 */
export function getProviderApiBaseUrl(provider) {
  return readGitProvidersConfig()[provider]?.apiBaseUrl || GIT_PROVIDER_DEFAULTS[provider] || null;
}

/**
 * Effective detection hostnames for a provider: the built-in default hosts
 * plus any user-configured detectUrls, deduped. The built-ins always apply so
 * a default host (e.g. github.com) keeps classifying remotes even when custom
 * enterprise hosts are configured.
 */
export function getProviderDetectUrls(provider) {
  const configured = readGitProvidersConfig()[provider]?.detectUrls ?? [];
  return [...new Set([...(GIT_PROVIDER_DEFAULT_DETECT_URLS[provider] ?? []), ...configured])];
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
