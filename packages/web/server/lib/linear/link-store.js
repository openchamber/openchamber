import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LINEAR_LINK_STATUSES = ['started', 'completed', 'failed', 'attention'];

const MAX_LINKS = 500;

function resolveDefaultFilePath() {
  const root =
    typeof process.env.OPENCHAMBER_DATA_DIR === 'string' &&
    process.env.OPENCHAMBER_DATA_DIR.trim().length > 0
      ? path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim())
      : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(root, 'linear-session-links.json');
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const issueId = asNonEmptyString(raw.issueId);
  const sessionId = asNonEmptyString(raw.sessionId);
  if (!issueId || !sessionId) return null;
  return {
    issueId,
    issueIdentifier: asNonEmptyString(raw.issueIdentifier),
    issueTitle: asNonEmptyString(raw.issueTitle),
    issueUrl: asNonEmptyString(raw.issueUrl),
    teamId: asNonEmptyString(raw.teamId),
    teamKey: asNonEmptyString(raw.teamKey),
    sessionId,
    directory: asNonEmptyString(raw.directory),
    projectId: asNonEmptyString(raw.projectId),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    lastStatus: LINEAR_LINK_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : 'started',
    lastStatusAt: typeof raw.lastStatusAt === 'number' ? raw.lastStatusAt : null,
  };
}

/**
 * Persistence for Linear issue ↔ OpenChamber session links.
 *
 * One JSON file (no secrets) under the OpenChamber config root, written
 * atomically. The link is what connects lifecycle events on a session back to
 * the originating Linear issue, and what makes issue-triggered auto-start
 * idempotent (an already-linked issue is never started twice).
 */
export class LinearLinkStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath ? path.resolve(filePath) : resolveDefaultFilePath();
  }

  _read() {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, 'utf8').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed?.links) ? parsed.links : [];
      return rows.map((row) => normalizeLink(row)).filter(Boolean);
    } catch (error) {
      console.error('[Linear] Failed to read link file:', error?.message ?? error);
      return [];
    }
  }

  _write(links) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const bounded = links.slice(-MAX_LINKS);
    const tmpFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ links: bounded }, null, 2), 'utf8');
    fs.renameSync(tmpFile, this.filePath);
  }

  list() {
    return this._read().sort((a, b) => b.createdAt - a.createdAt);
  }

  getByIssueId(issueId) {
    const id = asNonEmptyString(issueId);
    if (!id) return null;
    return this._read().find((link) => link.issueId === id) ?? null;
  }

  getBySessionId(sessionId) {
    const id = asNonEmptyString(sessionId);
    if (!id) return null;
    return this._read().find((link) => link.sessionId === id) ?? null;
  }

  upsert(link) {
    const normalized = normalizeLink(link);
    if (!normalized) throw new Error('issueId and sessionId are required');
    const links = this._read().filter((entry) => entry.issueId !== normalized.issueId);
    links.push(normalized);
    this._write(links);
    return normalized;
  }

  /**
   * Record a lifecycle status transition. Returns the updated link when the
   * status actually changed, or `null` when the link is unknown or the status
   * is a repeat of the current one (callers use this to suppress duplicate
   * Linear comments).
   */
  transitionStatus(sessionId, status) {
    if (!LINEAR_LINK_STATUSES.includes(status)) return null;
    const id = asNonEmptyString(sessionId);
    if (!id) return null;
    const links = this._read();
    const link = links.find((entry) => entry.sessionId === id);
    if (!link) return null;
    if (link.lastStatus === status) return null;
    link.lastStatus = status;
    link.lastStatusAt = Date.now();
    this._write(links);
    return link;
  }

  remove(issueId) {
    const id = asNonEmptyString(issueId);
    if (!id) return false;
    const links = this._read();
    const next = links.filter((entry) => entry.issueId !== id);
    if (next.length === links.length) return false;
    this._write(next);
    return true;
  }
}
