/**
 * Redaction utilities
 *
 * Sanitize sensitive values (tokens, cookies, API keys) before logging,
 * error reporting, or display. These functions MUST never return the
 * original sensitive value.
 *
 * @module quota/credentials/redact
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
 */
export function redactCookie(cookieString: string): string {
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
 */
export function redactToken(token: string): string {
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
 */
export function redactApiKey(key: string): string {
  if (!key || typeof key !== 'string') return '****';
  const trimmed = key.trim();
  if (trimmed.length < 12) return '****';
  const first4 = trimmed.slice(0, 4);
  const last4 = trimmed.slice(-4);
  return `${first4}****${last4}`;
}

/**
 * Redact sensitive headers in a headers object.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const result: Record<string, string> = {};
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
 */
export function redactObject<T>(obj: T, sensitiveKeys: string[] = DEFAULT_SENSITIVE_KEYS): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (obj instanceof Date || obj instanceof RegExp) return obj;
  if (Array.isArray(obj)) {
    return (obj as unknown[]).map((item) => redactObject(item, sensitiveKeys)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some((k) => lowerKey.includes(k.toLowerCase()));
    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactObject(value, sensitiveKeys);
    } else {
      result[key] = value;
    }
  }
  return result as unknown as T;
}