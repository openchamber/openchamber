import path from 'path';
import { asNonEmptyString, isString } from '../shared/guards.js';
import { appendComment, LocalIssueError, readIssue, splitComments, writeIssue } from './files.js';
import { createLocalScanner, issuesDirOf } from './scanner.js';
import { readLocalPreferences, writeLocalPreferences } from './preferences.js';
import { createLocalSessionStatusRuntime } from './status-runtime.js';

/**
 * The local markdown-file tracker: its descriptor and the adapter that turns
 * the local scanner's shapes into the neutral tracker contract
 * (`../trackers/tracker-contract.d.ts`). Data lives in each project's
 * `.issues/` directory; there is no account, credential, or remote service.
 *
 * Identifiers restart at `LOCAL-1` in every project, so `id` equals the
 * identifier and the container (project) is what makes an issue unique.
 */

/** @typedef {import('../trackers/tracker-contract').TrackerDescriptor} TrackerDescriptor */
/** @typedef {import('../trackers/tracker-contract').TrackerItemSummary} TrackerItemSummary */
/** @typedef {import('../trackers/tracker-contract').TrackerItem} TrackerItem */
/** @typedef {import('../trackers/tracker-contract').TrackerImplementation} TrackerImplementation */

const LOCAL_TRACKER_ID = 'local';

const SESSION_STATUS_KINDS = new Set(['started', 'completed', 'failure']);
// How many session links and posted-status markers the in-memory maps keep;
// mirrors Linear's `MAX_SESSION_STATUS_RECORDS`. Comments persist on the issue
// file itself, so dropping old entries only loses the ability to dedupe or
// complete very old sessions, never data.
const MAX_SESSION_STATUS_MEMORY = 500;
// The comment heading names the session; a full OpenCode session id is long,
// so the heading keeps a prefix that still separates concurrent sessions.
const SESSION_ID_SHORT_LENGTH = 12;

const statusWord = (kind) => (kind === 'failure' ? 'failed' : kind);

const shortSessionId = (sessionId) => (sessionId.length <= SESSION_ID_SHORT_LENGTH ? sessionId : sessionId.slice(0, SESSION_ID_SHORT_LENGTH));

const nowIso = () => new Date().toISOString();

/** The issue URL the neutral `url` field and `matchUrl` agree on. */
const itemUrl = (identifier) => `https://openchamber.local/tracker/local/${identifier}`;

/** @type {TrackerDescriptor} */
export const LOCAL_TRACKER_DESCRIPTOR = Object.freeze({
  id: LOCAL_TRACKER_ID,
  name: 'Local',
  authMethods: Object.freeze([]),
  capabilities: Object.freeze({
    multipleAccounts: false,
    stateUpdate: true,
    children: false,
    labels: true,
    priority: true,
    filters: Object.freeze({ people: false, priority: true }),
    projectMapping: false,
    sessionComments: true,
    hostAccess: false,
    create: true,
    edit: true,
  }),
  stateFilters: Object.freeze(['open', 'all', 'triage', 'backlog', 'todo', 'in-progress', 'done', 'canceled']),
  urlPatterns: Object.freeze([
    Object.freeze({ host: 'openchamber.local', path: '^/tracker/local/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }),
  ]),
  identifierPattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$',
});

const URL_PATTERNS = LOCAL_TRACKER_DESCRIPTOR.urlPatterns.map((pattern) => ({
  host: pattern.host,
  path: new RegExp(pattern.path),
}));

/**
 * The identifier a local issue link names; null for anything else. Same rule
 * as the descriptor's `urlPatterns`: an http(s) URL whose host (without
 * `www.`) is the pattern's host and whose path matches.
 */
export function matchLocalUrl(value) {
  const raw = isString(value) ? value.trim() : '';
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  for (const pattern of URL_PATTERNS) {
    if (pattern.host !== host) continue;
    const match = pattern.path.exec(url.pathname);
    if (match) return decodeURIComponent(match[1]) ?? null;
  }
  return null;
}

const toContainer = (container) => (container ? { id: container.id, key: null, name: container.name } : null);

/**
 * One scanner issue in the neutral summary shape. `container` comes from the
 * caller: the scanner's `containerByIssue` (keyed by `containerId`) for list
 * results, a project lookup for single-issue results.
 * @returns {TrackerItemSummary}
 */
function toTrackerItemSummary(issue, container) {
  /** @type {TrackerItemSummary} */
  return {
    provider: LOCAL_TRACKER_ID,
    id: issue.identifier,
    identifier: issue.identifier,
    title: issue.title,
    url: itemUrl(issue.identifier),
    state: { id: issue.state, name: issue.state, category: issue.state },
    priority: issue.priority ?? 'none',
    labels: issue.labels.map((name, index) => ({ id: `label-${index}`, name, color: null })),
    assignee: null,
    container: toContainer(container),
    updatedAt: issue.updatedAt ?? null,
  };
}

/**
 * Summary plus the detail fields: the description is the body without the
 * Comments section, and comments map from the parsed `## Comments` entries.
 * @returns {TrackerItem}
 */
function toTrackerItem(issue, container) {
  const { head, comments } = splitComments(issue.body);
  return {
    ...toTrackerItemSummary(issue, container),
    description: head.trim() || null,
    comments: comments.map((comment, index) => ({
      id: `comment-${index}`,
      body: comment.text,
      createdAt: comment.iso,
      author: null,
    })),
  };
}

/**
 * The local tracker over the local scanner, injected so tests can pass fakes.
 * @returns {TrackerImplementation}
 */
export function createLocalTracker({ listProjects }) {
  const scanner = createLocalScanner({ listProjects });

  // Single-issue results (create/edit/updateState) need the issue's container;
  // the scanner owns the container naming, so resolve it through the scanner.
  const containerOfIssue = async (issue) => {
    const found = (await scanner.containers()).find((candidate) => candidate.id === issue.containerId);
    return found ? { id: found.id, key: null, name: found.name } : null;
  };

  // Session id → the issue a `started` post linked it to (identifier plus the
  // origin the UI posted). The runtime's later events carry only the session
  // id, like Linear's, so the link is recovered here instead of from a records
  // file. In memory only: the `started` comment on the issue file already
  // records the link for humans, and the map refills on the next `started`.
  const sessionLinks = new Map();
  // One comment per session and kind, whatever produced it (runtime event or
  // direct post): OpenCode reports `idle` after every turn, and without this
  // guard every turn would append another "completed" comment.
  const postedStatuses = new Set();

  const rememberSessionLink = (sessionId, link) => {
    sessionLinks.delete(sessionId); // re-insert so eviction drops the oldest
    sessionLinks.set(sessionId, link);
    if (sessionLinks.size > MAX_SESSION_STATUS_MEMORY) {
      sessionLinks.delete(sessionLinks.keys().next().value);
    }
  };

  const postSessionStatus = async (input) => {
    const sessionId = asNonEmptyString(input?.sessionId);
    const kind = asNonEmptyString(input?.kind);
    if (!sessionId || !SESSION_STATUS_KINDS.has(kind)) {
      return { connected: true, posted: false, skipped: 'no-identifier' };
    }

    const link = sessionLinks.get(sessionId) ?? null;
    const identifier = asNonEmptyString(input.identifier) ?? link?.identifier ?? null;
    if (!identifier) {
      return { connected: true, posted: false, skipped: 'no-identifier' };
    }

    // A session origin is only knowable from the post that carried it (the
    // UI's `started` call); OpenCode events never carry one.
    const sessionOrigin = asNonEmptyString(input.sessionOrigin) ?? link?.sessionOrigin ?? null;
    if (asNonEmptyString(input.identifier)) {
      rememberSessionLink(sessionId, { identifier, sessionOrigin });
    }

    if (!readLocalPreferences().sessionComments) {
      return { connected: true, posted: false, skipped: 'no-identifier' };
    }
    const dedupeKey = `${sessionId}:${kind}`;
    if (postedStatuses.has(dedupeKey)) {
      return { connected: true, posted: false, skipped: 'already-posted' };
    }

    const found = await scanner.get(identifier);
    if (!found) {
      return { connected: true, posted: false, skipped: 'no-identifier' };
    }

    // Re-read the parsed issue from disk before writing (the view the scanner
    // returns carries no frontmatter fields), append the comment, and write
    // through the same tmp+rename `writeIssue` the scanner persists with. The
    // next scan re-stats the file and re-reads it, so the scanner cache stays
    // coherent with an outside writer by its own mtime design.
    const project = (await listProjects()).find((candidate) => candidate.id === found.issue.containerId);
    if (!project) {
      return { connected: true, posted: false, skipped: 'no-identifier' };
    }
    const dirPath = path.join(project.path, issuesDirOf(project));
    const parsed = readIssue(dirPath, found.issue.fileName);
    if (!parsed) {
      return { connected: true, posted: false, skipped: 'no-identifier' };
    }

    writeIssue(dirPath, appendComment(parsed, {
      iso: nowIso(),
      source: `session ${shortSessionId(sessionId)}`,
      text: sessionOrigin
        ? `Session ${statusWord(kind)} — ${sessionOrigin}`
        : `Session ${statusWord(kind)}`,
    }));
    postedStatuses.add(dedupeKey);
    return { connected: true, posted: true };
  };

  return {
    auth: {
      status: async () => ({ connected: true, account: { id: 'local', name: 'Local', user: null, current: true } }),
      start: async () => {
        throw new LocalIssueError('Not supported');
      },
      disconnect: async () => {
        throw new LocalIssueError('Not supported');
      },
      activate: async () => {
        throw new LocalIssueError('Not supported');
      },
    },

    list: async (options) => {
      const result = await scanner.list(options);
      return {
        connected: true,
        items: result.issues.map((issue) => toTrackerItemSummary(issue, result.containerByIssue.get(issue.containerId))),
        cursor: result.cursor,
        hasMore: result.hasMore,
      };
    },

    get: async (id) => {
      const found = await scanner.get(id);
      return { connected: true, item: found ? toTrackerItem(found.issue, found.container) : null };
    },

    states: async () => ({ connected: true, states: await scanner.states() }),

    updateState: async ({ id, stateId }) => {
      const issue = await scanner.updateState(id, stateId);
      return { connected: true, item: toTrackerItemSummary(issue, await containerOfIssue(issue)) };
    },

    create: async ({ containerId, title, description, priority, labels }) => {
      const issue = await scanner.create(containerId, { title, description, priority, labels });
      return { connected: true, item: toTrackerItemSummary(issue, await containerOfIssue(issue)) };
    },

    edit: async ({ id, title, description, priority, labels }) => {
      const issue = await scanner.edit(id, { title, description, priority, labels });
      return { connected: true, item: toTrackerItemSummary(issue, await containerOfIssue(issue)) };
    },

    liveSummaries: async (identifiers) => ({ connected: true, items: await scanner.liveSummaries(identifiers) }),

    matchUrl: matchLocalUrl,

    preferences: {
      get: readLocalPreferences,
      set: writeLocalPreferences,
    },

    sessionStatus: {
      post: postSessionStatus,
      createRuntime: () => createLocalSessionStatusRuntime({ post: postSessionStatus }),
    },
  };
}
