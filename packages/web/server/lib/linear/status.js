import fs from 'fs';
import path from 'path';
import { getLinearAuth, getLinearAuthFilePath, getLinearSessionCommentsEnabled } from './auth.js';
import { createLinearIssueComment } from './issues.js';
import { isPlainObject, readTrimmedString } from './parse.js';

const LINEAR_SESSION_STATUS_KINDS = ['started', 'completed', 'failure'];
const MAX_SESSION_STATUS_RECORDS = 500;

export class LinearSessionStatusError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LinearSessionStatusError';
    this.code = code;
  }
}

const inflight = new Map();

function statusFile() {
  return path.join(path.dirname(getLinearAuthFilePath()), 'linear-session-status.json');
}

function writeJsonFile(filePath, payload) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

const PRIVATE_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa'];

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 is carrier-grade NAT, which Tailscale and similar overlays use.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const address = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (address === '::1' || address === '::') return true;
  // fc00::/7 (unique local) and fe80::/10 (link local).
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address);
}

/**
 * A session link is only worth writing into Linear when somebody other than the
 * person who started the session can open it. Loopback, private LAN and
 * overlay-network addresses reach nobody else, so they do not qualify.
 */
export function isPublicSessionOrigin(value) {
  const origin = readSessionOrigin(value);
  if (!origin) return false;
  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname || hostname === 'localhost') return false;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;
  if (hostname.includes(':') || hostname.startsWith('[')) return !isPrivateIpv6(hostname);
  if (/^[\d.]+$/.test(hostname)) return !isPrivateIpv4(hostname);
  // A bare single-label host is a LAN machine name, not a routable address.
  return hostname.includes('.');
}

export function readSessionOrigin(value) {
  const trimmed = readTrimmedString(value);
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    if (url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function buildLinearSessionOpenUrl(sessionId, sessionOrigin) {
  const id = readTrimmedString(sessionId);
  const origin = readSessionOrigin(sessionOrigin);
  if (!origin) return '';
  return `${origin}/?session=${encodeURIComponent(id)}`;
}

function statusWord(kind) {
  if (kind === 'started') return 'started';
  if (kind === 'completed') return 'completed';
  return 'failed';
}

export function buildLinearSessionStatusComment({ kind, sessionUrl }) {
  const url = readTrimmedString(sessionUrl);
  const label = `OpenChamber session ${statusWord(kind)}`;
  if (!url) return label;
  // The comment already lives on the issue, so it says only what happened and
  // links to the session. Issue titles routinely contain brackets ("[Bug] …"),
  // which would break this markdown link if they were repeated in the label.
  return `[${label}](${url})`;
}

function readBooleanFlag(value) {
  return value === true;
}

function readRecord(value) {
  if (!isPlainObject(value)) return null;
  const issueIdentifier = readTrimmedString(value.issueIdentifier);
  if (!issueIdentifier) return null;
  return {
    issueIdentifier,
    sessionOrigin: readSessionOrigin(value.sessionOrigin) || null,
    organizationId: readTrimmedString(value.organizationId) || null,
    started: readBooleanFlag(value.started),
    completed: readBooleanFlag(value.completed),
    failure: readBooleanFlag(value.failure),
  };
}

function readRecords() {
  const filePath = statusFile();
  if (!fs.existsSync(filePath)) {
    return {};
  }
  let parsed;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return {};
    }
    parsed = JSON.parse(trimmed);
  } catch {
    throw new LinearSessionStatusError('Linear session status file is malformed', 'MALFORMED');
  }
  if (!isPlainObject(parsed)) {
    throw new LinearSessionStatusError('Linear session status file is malformed', 'MALFORMED');
  }
  const next = {};
  for (const key of Object.keys(parsed)) {
    const sessionId = readTrimmedString(key);
    const record = readRecord(parsed[key]);
    if (sessionId && record) {
      next[sessionId] = record;
    }
  }
  return next;
}

/**
 * The file only exists to dedupe comments, so it does not need to remember
 * every session ever started. Keep the newest entries and drop the tail.
 */
export function pruneSessionStatusRecords(records, limit = MAX_SESSION_STATUS_RECORDS) {
  const keys = Object.keys(records);
  if (keys.length <= limit) {
    return records;
  }
  const kept = {};
  for (const key of keys.slice(keys.length - limit)) {
    kept[key] = records[key];
  }
  return kept;
}

function writeRecords(records) {
  writeJsonFile(statusFile(), pruneSessionStatusRecords(records));
}

async function postOnce(input) {
  const kind = readTrimmedString(input?.kind);
  const sessionId = readTrimmedString(input?.sessionId);
  if (!LINEAR_SESSION_STATUS_KINDS.includes(kind) || !sessionId) {
    throw new LinearSessionStatusError('kind and sessionId are required', 'INVALID');
  }

  // Disconnected answers first so the picker and panel keep showing their
  // "connect Linear" state whatever the comment preference says.
  if (!getLinearAuth()) {
    return { connected: false };
  }
  if (!getLinearSessionCommentsEnabled()) {
    return { connected: true, posted: false, skipped: 'disabled' };
  }

  const records = readRecords();
  const existing = records[sessionId] || null;
  if (existing?.[kind] === true) {
    return { connected: true, posted: false, skipped: 'already-posted' };
  }
  if (kind !== 'started' && existing?.started !== true) {
    return { connected: true, posted: false, skipped: 'not-started' };
  }

  const issueIdentifier = readTrimmedString(input?.issueIdentifier)
    || readTrimmedString(existing?.issueIdentifier);
  if (!issueIdentifier) {
    throw new LinearSessionStatusError('issueIdentifier is required', 'INVALID');
  }

  const sessionOrigin = readSessionOrigin(input?.sessionOrigin)
    || readTrimmedString(existing?.sessionOrigin);
  // Without an origin other people can reach, the comment would carry a link
  // only its author could open. Say nothing rather than publish a dead link.
  if (!isPublicSessionOrigin(sessionOrigin)) {
    return { connected: true, posted: false, skipped: 'origin-not-public' };
  }
  const sessionUrl = buildLinearSessionOpenUrl(sessionId, sessionOrigin);
  const organizationId = readTrimmedString(input?.organizationId)
    || readTrimmedString(existing?.organizationId)
    || readTrimmedString(getLinearAuth()?.workspaceId);
  const body = buildLinearSessionStatusComment({ kind, sessionUrl });
  const commentResult = await createLinearIssueComment({
    issueId: issueIdentifier,
    body,
    organizationId,
  });
  if (commentResult.connected === false) {
    return { connected: false };
  }
  if (!commentResult.comment) {
    return { connected: true, posted: false, skipped: 'issue-not-found' };
  }

  records[sessionId] = {
    issueIdentifier,
    sessionOrigin: sessionOrigin || null,
    organizationId: organizationId || null,
    started: existing?.started === true || kind === 'started',
    completed: existing?.completed === true || kind === 'completed',
    failure: existing?.failure === true || kind === 'failure',
  };
  writeRecords(records);
  return {
    connected: true,
    posted: true,
    commentId: commentResult.comment.id,
  };
}

export async function postLinearSessionStatus(input) {
  const kind = readTrimmedString(input?.kind);
  const sessionId = readTrimmedString(input?.sessionId);
  const key = `${sessionId}:${kind}`;
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const promise = postOnce(input).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}
