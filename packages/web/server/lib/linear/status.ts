import fs from 'fs';
import path from 'path';
import { getLinearAuth, getLinearAuthFilePath, getLinearSessionCommentsEnabled } from './auth.js';
import { createLinearIssueComment } from './issues.js';
import { isPlainObject, isString, readTrimmedString } from './parse.js';
import { buildSessionOpenUrl, buildSessionStatusComment, isPublicSessionOrigin, readSessionOrigin } from '../trackers/session-origin.js';
import type { TrackerSessionStatusKind, TrackerSessionStatusResult } from '../trackers/tracker-contract.js';

interface LinearSessionStatusInput {
  kind?: unknown;
  sessionId?: unknown;
  issueIdentifier?: unknown;
  sessionOrigin?: unknown;
  organizationId?: unknown;
}

interface LinearSessionStatusRecord {
  issueIdentifier: string;
  sessionOrigin: string | null;
  organizationId: string | null;
  started: boolean;
  completed: boolean;
  failure: boolean;
}

type LinearSessionStatusRecords = Record<string, LinearSessionStatusRecord>;

interface LinearRawStatusRecord extends LinearSessionStatusInput {
  started?: unknown;
  completed?: unknown;
  failure?: unknown;
}

function isSessionStatusKind(value: string): value is TrackerSessionStatusKind {
  return LINEAR_SESSION_STATUS_KINDS.includes(value);
}

const LINEAR_SESSION_STATUS_KINDS = ['started', 'completed', 'failure'];
const MAX_SESSION_STATUS_RECORDS = 500;

export class LinearSessionStatusError extends Error {
  declare code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'LinearSessionStatusError';
    this.code = code;
  }
}

const inflight = new Map<string, Promise<TrackerSessionStatusResult>>();

function statusFile() {
  return path.join(path.dirname(getLinearAuthFilePath()), 'linear-session-status.json');
}

function writeJsonFile(filePath: string, payload: Record<string, LinearSessionStatusRecord | undefined>) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    void 0;
  }
  fs.renameSync(tmpFile, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    void 0;
  }
}

export {
  isPublicSessionOrigin,
  readSessionOrigin,
  buildSessionOpenUrl as buildLinearSessionOpenUrl,
  buildSessionStatusComment as buildLinearSessionStatusComment,
} from '../trackers/session-origin.js';

function readRecord(value: LinearRawStatusRecord): LinearSessionStatusRecord | null {
  const issueIdentifier = readTrimmedString(value.issueIdentifier);
  if (!issueIdentifier) return null;
  const sessionOrigin = value.sessionOrigin;
  return {
    issueIdentifier,
    sessionOrigin: readSessionOrigin(isString(sessionOrigin) ? sessionOrigin : undefined) || null,
    organizationId: readTrimmedString(value.organizationId) || null,
    started: value.started === true,
    completed: value.completed === true,
    failure: value.failure === true,
  };
}

function readRecords() {
  const next: LinearSessionStatusRecords = {};
  const filePath = statusFile();
  if (!fs.existsSync(filePath)) {
    return next;
  }
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return next;
    }
    parsed = JSON.parse(trimmed);
  } catch {
    throw new LinearSessionStatusError('Linear session status file is malformed', 'MALFORMED');
  }
  if (!isPlainObject(parsed)) {
    throw new LinearSessionStatusError('Linear session status file is malformed', 'MALFORMED');
  }
  for (const key of Object.keys(parsed)) {
    const sessionId = readTrimmedString(key);
    const value = parsed[key];
    const record = isPlainObject(value) ? readRecord(value) : null;
    if (sessionId && record) {
      next[sessionId] = record;
    }
  }
  return next;
}

export function pruneSessionStatusRecords<Value>(records: Record<string, Value>, limit = MAX_SESSION_STATUS_RECORDS) {
  const keys = Object.keys(records);
  if (keys.length <= limit) {
    return records;
  }
  const kept: Record<string, Value | undefined> = {};
  for (const key of keys.slice(keys.length - limit)) {
    kept[key] = records[key];
  }
  return kept;
}

function writeRecords(records: Record<string, LinearSessionStatusRecord>) {
  writeJsonFile(statusFile(), pruneSessionStatusRecords(records));
}

async function postOnce(input: LinearSessionStatusInput | null | undefined): Promise<TrackerSessionStatusResult> {
  const kind = readTrimmedString(input?.kind);
  const sessionId = readTrimmedString(input?.sessionId);
  if (!isSessionStatusKind(kind) || !sessionId) {
    throw new LinearSessionStatusError('kind and sessionId are required', 'INVALID');
  }

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

  const rawSessionOrigin = input?.sessionOrigin;
  const sessionOrigin = readSessionOrigin(isString(rawSessionOrigin) ? rawSessionOrigin : undefined)
    || readTrimmedString(existing?.sessionOrigin);
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

export async function postLinearSessionStatus(input: LinearSessionStatusInput | null | undefined) {
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
