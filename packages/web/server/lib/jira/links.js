import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCHAMBER_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber');

const LINKS_FILE = path.join(OPENCHAMBER_DATA_DIR, 'jira-session-links.json');

const MAX_LINKS = 500;
const MAX_ATTEMPTS = 1_000;

function ensureStorageDir() {
  if (!fs.existsSync(OPENCHAMBER_DATA_DIR)) {
    fs.mkdirSync(OPENCHAMBER_DATA_DIR, { recursive: true });
  }
}

function normalizeLink(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const issueKey = typeof entry.issueKey === 'string' && entry.issueKey ? entry.issueKey : null;
  const sessionId = typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : null;
  if (!issueKey || !sessionId) return null;
  return {
    issueKey,
    issueUrl: typeof entry.issueUrl === 'string' ? entry.issueUrl : null,
    issueSummary: typeof entry.issueSummary === 'string' ? entry.issueSummary : null,
    sessionId,
    directory: typeof entry.directory === 'string' ? entry.directory : null,
    source: entry.source === 'listener' ? 'listener' : 'api',
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
  };
}

function normalizeAttempt(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const outcome = entry.outcome === 'started' || entry.outcome === 'failed' ? entry.outcome : null;
  const lastAttemptAt = typeof entry.lastAttemptAt === 'number' ? entry.lastAttemptAt : null;
  if (!outcome || !lastAttemptAt) return null;
  return {
    outcome,
    lastAttemptAt,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
    error: typeof entry.error === 'string' ? entry.error : null,
  };
}

function readStore() {
  if (!fs.existsSync(LINKS_FILE)) {
    return { links: [], attempts: {} };
  }
  try {
    const raw = fs.readFileSync(LINKS_FILE, 'utf8').trim();
    if (!raw) return { links: [], attempts: {} };
    const parsed = JSON.parse(raw);
    const links = (Array.isArray(parsed?.links) ? parsed.links : [])
      .map(normalizeLink)
      .filter(Boolean);
    const attempts = {};
    if (parsed?.attempts && typeof parsed.attempts === 'object') {
      for (const [issueKey, value] of Object.entries(parsed.attempts)) {
        const normalized = normalizeAttempt(value);
        if (normalized) attempts[issueKey] = normalized;
      }
    }
    return { links, attempts };
  } catch (error) {
    console.error('Failed to read Jira session links file:', error);
    return { links: [], attempts: {} };
  }
}

function writeStore(store) {
  ensureStorageDir();
  const tmpFile = `${LINKS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }
  fs.renameSync(tmpFile, LINKS_FILE);
  try {
    fs.chmodSync(LINKS_FILE, 0o600);
  } catch {
    // best-effort
  }
}

export function recordJiraSessionLink(link) {
  const normalized = normalizeLink({ ...link, createdAt: Date.now() });
  if (!normalized) {
    throw new Error('Invalid Jira session link: issueKey and sessionId are required');
  }
  const store = readStore();
  store.links.push(normalized);
  if (store.links.length > MAX_LINKS) {
    store.links.splice(0, store.links.length - MAX_LINKS);
  }
  writeStore(store);
  return normalized;
}

export function listJiraSessionLinks() {
  return readStore().links;
}

export function findJiraLinksByIssueKey(issueKey) {
  if (typeof issueKey !== 'string' || !issueKey) return [];
  return readStore().links.filter((link) => link.issueKey === issueKey);
}

export function findJiraLinkBySessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const matches = readStore().links.filter((link) => link.sessionId === sessionId);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * Listener attempt bookkeeping. A `started` attempt permanently marks the
 * issue as handled (the listener also removes the trigger label when it can).
 * A `failed` attempt is retried once the issue changes after the attempt —
 * see `shouldRetryJiraIssue`.
 */
export function recordJiraListenerAttempt(issueKey, attempt) {
  if (typeof issueKey !== 'string' || !issueKey) {
    throw new Error('issueKey is required');
  }
  const normalized = normalizeAttempt({ ...attempt, lastAttemptAt: Date.now() });
  if (!normalized) {
    throw new Error('Invalid Jira listener attempt: outcome is required');
  }
  const store = readStore();
  store.attempts[issueKey] = normalized;
  const keys = Object.keys(store.attempts);
  if (keys.length > MAX_ATTEMPTS) {
    const sorted = keys.sort((a, b) => (store.attempts[a].lastAttemptAt || 0) - (store.attempts[b].lastAttemptAt || 0));
    for (const key of sorted.slice(0, keys.length - MAX_ATTEMPTS)) {
      delete store.attempts[key];
    }
  }
  writeStore(store);
  return normalized;
}

export function getJiraListenerAttempt(issueKey) {
  if (typeof issueKey !== 'string' || !issueKey) return null;
  return readStore().attempts[issueKey] || null;
}

// The listener's own failure comment bumps the issue's `updated` timestamp
// moments after the attempt; the grace window keeps that write (and other
// immediate automation) from re-triggering the same failure in a loop.
const RETRY_GRACE_MS = 60_000;

export function shouldRetryJiraIssue(attempt, issueUpdatedMs) {
  if (!attempt) return true;
  if (attempt.outcome === 'started') return false;
  if (!Number.isFinite(issueUpdatedMs)) return false;
  return issueUpdatedMs > attempt.lastAttemptAt + RETRY_GRACE_MS;
}

export const JIRA_LINKS_FILE = LINKS_FILE;
