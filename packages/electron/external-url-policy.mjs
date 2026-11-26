const EXCLUDED_APP_SCHEMES = new Set([
  'tel', 'sms', 'callto', 'cid', 'xmpp', 'irc', 'news', 'nntp', 'feed', 'webcal',
  'javascript', 'data', 'vbscript', 'blob', 'filesystem', 'about',
  'chrome', 'chrome-extension', 'devtools', 'moz-extension', 'ms-browser-extension',
  'file', 'ws', 'wss', 'ftp', 'ftps', 'intent', 'ms-msdt', 'search-ms', 'shell',
  'openchamber', 'openchamber-ui', 'capacitor',
]);

const EXPLICIT_HIERARCHICAL_HTTP_RE = /^https?:\/\/[^/?#\\]/i;
const ENCODED_CONTROL_BYTE_RE = /%([01][0-9a-f]|7f)/i;
const ALLOWED_MAILTO_QUERY_KEYS = new Set(['to', 'cc', 'bcc', 'subject', 'body', 'in-reply-to', 'references']);

const hasControlCharacters = (value, { allowLineBreaks = false } = {}) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const hasUnsafeRawCharacters = (value) => /\s/.test(value) || value.includes('\\') || value.includes('"');

const isValidMailtoUrl = (raw, parsed) => {
  if (/^mailto:\/\//i.test(raw) || hasUnsafeRawCharacters(raw)) return false;
  if (!parsed.pathname.trim() && parsed.searchParams.size === 0) return false;
  if (ENCODED_CONTROL_BYTE_RE.test(parsed.pathname) || ENCODED_CONTROL_BYTE_RE.test(parsed.hash)) return false;
  for (const [key, value] of parsed.searchParams.entries()) {
    const normalizedKey = key.toLowerCase();
    if (!ALLOWED_MAILTO_QUERY_KEYS.has(normalizedKey)) return false;
    if (hasControlCharacters(value, { allowLineBreaks: normalizedKey === 'body' })) return false;
  }
  const serialized = parsed.toString();
  return !hasControlCharacters(serialized) && !hasUnsafeRawCharacters(serialized);
};

export const parseAutoOpenableExternalUrl = (target) => {
  try {
    if (!target || hasControlCharacters(target)) return null;
    const trimmed = target.trim();
    if (!trimmed || !EXPLICIT_HIERARCHICAL_HTTP_RE.test(trimmed) || trimmed.includes('\\')) return null;
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const parseExternalUrl = (target) => {
  const parsed = new URL(target);
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme === 'http' || scheme === 'https') return parsed;
  if (scheme === 'mailto') {
    if (hasControlCharacters(target) || !isValidMailtoUrl(target.trim(), parsed)) {
      throw new Error('URL cannot be opened externally');
    }
    return parsed;
  }
  if (!/^[a-z][a-z0-9+.-]{1,31}$/.test(scheme) || EXCLUDED_APP_SCHEMES.has(scheme)) {
    throw new Error('URL scheme cannot be opened externally');
  }
  return parsed;
};
