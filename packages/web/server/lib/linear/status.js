import fs from 'fs';
import path from 'path';
import { getLinearAuth, getLinearAuthFilePath, getLinearSessionCommentsEnabled } from './auth.js';
import { createLinearIssueComment } from './issues.js';
import { isPlainObject, readTrimmedString } from './parse.js';
import { buildSessionOpenUrl, buildSessionStatusComment, isPublicSessionOrigin, readSessionOrigin } from '../trackers/session-origin.js';

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

export {
  isPublicSessionOrigin,
  readSessionOrigin,
  buildSessionOpenUrl as buildLinearSessionOpenUrl,
  buildSessionStatusComment as buildLinearSessionStatusComment,
} from '../trackers/session-origin.js';

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
  const sessionUrl = buildSessionOpenUrl(sessionId, sessionOrigin);
  const organizationId = readTrimmedString(input?.organizationId)
    || readTrimmedString(existing?.organizationId)
    || readTrimmedString(getLinearAuth()?.workspaceId);
  const body = buildSessionStatusComment({ kind, sessionUrl });
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
