const RELATIVE_ASSET = /(<(?:script|link|img)\b[^>]*?\s(?:src|href)=)(["'])(?!https?:|\/\/|data:|#)([^"']+)\2/gi;

const withToken = (url: string, token: string) => {
  if (url.includes('oc_url_token=')) {
    return url;
  }
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}oc_url_token=${encodeURIComponent(token)}`;
};

import type { QueryValue as HttpQueryValue } from '../shared/http-contracts.js';
type QueryValue = HttpQueryValue | null | undefined;

const firstQueryValue = (value: QueryValue) => (Array.isArray(value) ? value[0] : value);

export const parseGuestUrlToken = (value: QueryValue) => {
  const first = firstQueryValue(value);
  if (first == null || first === '') {
    return '';
  }
  return `${first}`;
};

const SCRIPT_SRC = /<script\b[^>]*?\ssrc=(["'])(?!https?:|\/\/|data:|#)([^"']+)\1/gi;

export const listRelativeGuestScriptHrefs = (html: string) => {
  if (html === '') {
    return [];
  }
  const hrefs = [];
  SCRIPT_SRC.lastIndex = 0;
  let match = SCRIPT_SRC.exec(html);
  while (match) {
    hrefs.push(match[2] ?? '');
    match = SCRIPT_SRC.exec(html);
  }
  return hrefs;
};

export const resolveGuestHtmlRelativePath = (entry: string, href: string) => {
  const withoutHash = href.split('#')[0] ?? '';
  const raw = withoutHash.split('?')[0] ?? '';
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

export const listRelativeGuestAssetHrefs = (html: string) => [...html.matchAll(RELATIVE_ASSET)].map((match) => match[3] ?? '');

export const injectGuestAssetTokens = (html: string, token: string) => {
  if (!token) {
    return html;
  }
  return html.replace(RELATIVE_ASSET, (_match: string, prefix: string, quote: string, url: string) => {
    return `${prefix}${quote}${withToken(url, token)}${quote}`;
  });
};
