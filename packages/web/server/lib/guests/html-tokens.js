const RELATIVE_ASSET = /(<(?:script|link|img)\b[^>]*?\s(?:src|href)=)(["'])(?!https?:|\/\/|data:|#)([^"']+)\2/gi;

const withToken = (url, token) => {
  if (url.includes('oc_url_token=')) {
    return url;
  }
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}oc_url_token=${encodeURIComponent(token)}`;
};

const firstQueryValue = (value) => (Array.isArray(value) ? value[0] : value);

/** Query `oc_url_token` for guest HTML. Empty when the query is missing or not a token. */
export const parseGuestUrlToken = (value) => {
  const first = firstQueryValue(value);
  if (first == null || first === '') {
    return '';
  }
  return `${first}`;
};

const SCRIPT_SRC = /<script\b[^>]*?\ssrc=(["'])(?!https?:|\/\/|data:|#)([^"']+)\1/gi;

/** Relative `script src` values. Absolute, protocol-relative, data, and hash URLs are skipped. */
export const listRelativeGuestScriptHrefs = (html) => {
  if (html === '') {
    return [];
  }
  const hrefs = [];
  SCRIPT_SRC.lastIndex = 0;
  let match = SCRIPT_SRC.exec(html);
  while (match) {
    hrefs.push(match[2]);
    match = SCRIPT_SRC.exec(html);
  }
  return hrefs;
};

/** Resolve a relative href against the entry HTML path. Stays inside the package. */
export const resolveGuestHtmlRelativePath = (entry, href) => {
  const withoutHash = href.split('#')[0] ?? '';
  const raw = withoutHash.split('?')[0];
  if (raw === '' || raw.includes('\0') || raw.includes('\\')) {
    return null;
  }
  const entryDir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
  const combined = entryDir === '' ? raw : `${entryDir}/${raw}`;
  const segments = [];
  for (const part of combined.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
};

/** Copy the iframe URL token onto relative script/link/img URLs in guest HTML. */
export const injectGuestAssetTokens = (html, token) => {
  if (!token) {
    return html;
  }
  return html.replace(RELATIVE_ASSET, (_match, prefix, quote, url) => {
    return `${prefix}${quote}${withToken(url, token)}${quote}`;
  });
};
