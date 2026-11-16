import { isEnterpriseMode } from '../enterprise-mode.js';
import { pinnedRelayUrl } from '../relay/service.js';
import { relayHttpBase, resolveShareRelayBase } from './relay-client.js';

export const PUBLIC_SHARE_ORIGIN = 'https://share.openchamber.dev';

const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const LINK_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const allowedReceiveBases = (settings) => {
  if (isEnterpriseMode()) {
    const pinned = pinnedRelayUrl();
    return pinned === null ? [] : [relayHttpBase(pinned)];
  }
  return [...new Set([PUBLIC_SHARE_ORIGIN, resolveShareRelayBase(settings)])];
};

export class ShareLinkError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ShareLinkError';
    this.code = code;
  }
}

export const parseShareLink = (raw, allowedBases) => {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new ShareLinkError('This is not a share link', 'invalid_link');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search) {
    throw new ShareLinkError('This is not a share link', 'invalid_link');
  }
  const match = /^(.*)\/p\/([^/]+)$/.exec(url.pathname);
  const key = url.hash.slice(1);
  if (!match || !SHARE_ID_PATTERN.test(match[2]) || !LINK_KEY_PATTERN.test(key)) {
    throw new ShareLinkError('This is not a share link', 'invalid_link');
  }
  const base = `${url.origin}${match[1]}`.replace(/\/+$/, '');
  if (!allowedBases.includes(base)) {
    throw new ShareLinkError('Links from this address are not opened here', 'link_not_allowed');
  }
  return { base, shareId: match[2], linkKey: key, host: url.host };
};
