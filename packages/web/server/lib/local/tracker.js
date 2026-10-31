import { isString } from '../shared/guards.js';
import { LocalIssueError, splitComments } from './files.js';
import { createLocalScanner } from './scanner.js';

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
 * `preferences` and `sessionStatus` are placeholders until their modules land.
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

  const notImplemented = async () => {
    throw new LocalIssueError('Not implemented yet');
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
      get: notImplemented,
      set: notImplemented,
    },

    sessionStatus: {
      post: notImplemented,
      createRuntime: () => {
        throw new LocalIssueError('Not implemented yet');
      },
    },
  };
}
