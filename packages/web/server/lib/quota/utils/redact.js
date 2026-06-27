/**
 * Redaction utilities
 *
 * Sanitize sensitive values (tokens, cookies, API keys) before logging,
 * error reporting, or display. These functions MUST never return the
 * original sensitive value.
 *
 * @module quota/utils/redact
 */

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

const DEFAULT_SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'cookie',
];

/**
 * Redact a cookie string by replacing each value with '[REDACTED]'
 * while preserving cookie names.
 *
 * @param {string} cookieString - e.g. 'session=abc123; token=xyz789'
 * @returns {string} - e.g. 'session=[REDACTED]; token=[REDACTED]'
 */
export function redactCookie(cookieString) {
  if (!cookieString || typeof cookieString !== 'string') return '';
  return cookieString
    .split(';')
    .map((pair) => {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) return pair;
      const name = pair.slice(0, eqIndex);
      return `${name}=[REDACTED]`;
    })
    .join(';');
}

/**
 * Redact a bearer/API token, showing only the 'sk-' prefix (when present)
 * and the last 4 characters.
 *
 * @param {string} token
 * @returns {string} - e.g. 'sk-****abcd' or '****abcd'
 */
export function redactToken(token) {
  if (!token || typeof token !== 'string') return '****';
  const trimmed = token.trim();
  if (trimmed.length < 8) return '****';
  const last4 = trimmed.slice(-4);
  if (trimmed.startsWith('sk-') && trimmed.length >= 12) {
    return `sk-****${last4}`;
  }
  return `****${last4}`;
}

/**
 * Redact an API key, showing the first 4 and last 4 characters when the
 * key is long enough (>= 12 chars). Otherwise returns '****'.
 *
 * @param {string} key
 * @returns {string} - e.g. '1234****5678'
 */
export function redactApiKey(key) {
  if (!key || typeof key !== 'string') return '****';
  const trimmed = key.trim();
  if (trimmed.length < 12) return '****';
  const first4 = trimmed.slice(0, 4);
  const last4 = trimmed.slice(-4);
  return `${first4}****${last4}`;
}

/**
 * Redact sensitive headers in a headers object.
 *
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lowerKey)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Recursively redact object keys that match sensitive patterns.
 * Matching is case-insensitive substring: a key is redacted if it
 * contains any of the sensitive patterns.
 *
 * @param {*} obj
 * @param {string[]} [sensitiveKeys=DEFAULT_SENSITIVE_KEYS]
 * @returns {*} - the object with sensitive values replaced by '[REDACTED]'
 */
export function redactObject(obj, sensitiveKeys = DEFAULT_SENSITIVE_KEYS) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Date || obj instanceof RegExp) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, sensitiveKeys));
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some((k) =>
      lowerKey.includes(k.toLowerCase())
    );
    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactObject(value, sensitiveKeys);
    } else {
      result[key] = value;
    }
  }
  return result;
}
