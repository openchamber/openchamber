import { disconnectCurrentLinearWorkspace, readLinearAuthStatus } from './auth-status.js';
import { isPlainObject, readTrimmedString } from './parse.js';

/**
 * Linear as a work item tracker: its descriptor and the adapter that turns
 * Linear's shapes into the neutral tracker contract
 * (`../trackers/tracker-contract.d.ts`). The legacy `/api/linear/*` routes keep
 * answering in Linear's own shapes; this module does not change them.
 *
 * Only cheap modules are imported statically. The Linear libraries load the
 * first time the tracker registry asks for the implementation.
 */

/** @typedef {import('../trackers/tracker-contract').TrackerDescriptor} TrackerDescriptor */
/** @typedef {import('../trackers/tracker-contract').TrackerStateCategory} TrackerStateCategory */
/** @typedef {import('../trackers/tracker-contract').TrackerPriority} TrackerPriority */
/** @typedef {import('../trackers/tracker-contract').TrackerItemSummary} TrackerItemSummary */
/** @typedef {import('../trackers/tracker-contract').TrackerItem} TrackerItem */
/** @typedef {import('../trackers/tracker-contract').TrackerWorkflowState} TrackerWorkflowState */
/** @typedef {import('../trackers/tracker-contract').TrackerAuthStatus} TrackerAuthStatus */
/** @typedef {import('../trackers/tracker-contract').TrackerImplementation} TrackerImplementation */

const LINEAR_TRACKER_ID = 'linear';

/** @type {TrackerDescriptor} */
export const LINEAR_TRACKER_DESCRIPTOR = Object.freeze({
  id: LINEAR_TRACKER_ID,
  name: 'Linear',
  authMethods: Object.freeze(['oauth']),
  capabilities: Object.freeze({
    multipleAccounts: true,
    stateUpdate: true,
    children: true,
    labels: true,
    priority: true,
    filters: Object.freeze({ people: true, priority: true }),
    projectMapping: true,
    sessionComments: true,
    hostAccess: true,
  }),
  // The order is the filter menu's. `inReview` and `duplicate` are Linear's
  // own name-based filters; Linear has no triage list filter.
  stateFilters: Object.freeze(['open', 'all', 'backlog', 'todo', 'in-progress', 'inReview', 'done', 'canceled', 'duplicate']),
  urlPatterns: Object.freeze([
    Object.freeze({ host: 'linear.app', path: '^/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }),
  ]),
  identifierPattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$',
});

const STATE_CATEGORY_BY_TYPE = {
  triage: 'triage',
  backlog: 'backlog',
  unstarted: 'todo',
  started: 'in-progress',
  completed: 'done',
  canceled: 'canceled',
  // Linear reports a duplicate as its own type on some workspaces; it is a
  // canceled item for everything category-based (look, cadence, progress).
  duplicate: 'canceled',
};

// What a live summary reports for a state type Linear added after this build.
const UNMAPPED_STATE_CATEGORY = 'todo';

/** @returns {TrackerStateCategory | null} */
export function linearStateCategory(type) {
  return Object.hasOwn(STATE_CATEGORY_BY_TYPE, type) ? STATE_CATEGORY_BY_TYPE[type] : null;
}

const PRIORITY_BY_VALUE = ['none', 'urgent', 'high', 'medium', 'low'];

/** Linear's 0 (none) to 4 (low); null for anything else. @returns {TrackerPriority | null} */
export function linearPriority(value) {
  return Number.isInteger(value) && value >= 0 && value < PRIORITY_BY_VALUE.length ? PRIORITY_BY_VALUE[value] : null;
}

// Neutral filter ids to the `status` values `listLinearIssues` takes.
const LINEAR_STATUS_BY_STATE_FILTER = {
  open: 'open',
  all: 'all',
  backlog: 'backlog',
  todo: 'todo',
  'in-progress': 'started',
  inReview: 'inReview',
  done: 'completed',
  canceled: 'canceled',
  duplicate: 'duplicate',
};

/** The Linear list `status` for a neutral state filter id; null when Linear has no such filter. */
export function linearStatusOfStateFilter(state) {
  return Object.hasOwn(LINEAR_STATUS_BY_STATE_FILTER, state) ? LINEAR_STATUS_BY_STATE_FILTER[state] : null;
}

const URL_PATTERNS = LINEAR_TRACKER_DESCRIPTOR.urlPatterns.map((pattern) => ({
  host: pattern.host,
  path: new RegExp(pattern.path),
}));

/**
 * The identifier a Linear issue link names, upper-cased; null for anything
 * else. Same rule as the descriptor's `urlPatterns`: an http(s) URL whose host
 * (without `www.`) is the pattern's host and whose path matches.
 */
export function matchLinearUrl(value) {
  const raw = readTrimmedString(value);
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  for (const pattern of URL_PATTERNS) {
    if (pattern.host !== host) continue;
    const match = pattern.path.exec(url.pathname);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

const personOf = (value) => {
  if (!isPlainObject(value)) return null;
  const name = value.displayName || value.name || null;
  const avatarUrl = value.avatarUrl || null;
  return name || avatarUrl ? { name, avatarUrl } : null;
};

const stateOf = (state) => (state
  ? { id: state.id ?? null, name: state.name ?? '', category: linearStateCategory(state.type) }
  : null);

/**
 * One Linear issue (as `issues.js` reads it) in the neutral summary shape.
 * A related issue (a parent, a sub-issue) has no labels or progress of its
 * own there, so those fields stay absent rather than empty.
 * @returns {TrackerItemSummary}
 */
function toTrackerItemSummary(issue) {
  /** @type {TrackerItemSummary} */
  const summary = {
    provider: LINEAR_TRACKER_ID,
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    state: stateOf(issue.state),
    priority: linearPriority(issue.priority),
    assignee: personOf(issue.assignee),
    container: issue.team ? { id: issue.team.id, key: issue.team.key ?? null, name: issue.team.name } : null,
    updatedAt: issue.updatedAt ?? null,
  };
  if (Array.isArray(issue.labels)) {
    summary.labels = issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color ?? null }));
  }
  if ('parent' in issue) {
    summary.parent = issue.parent ? toTrackerItemSummary(issue.parent) : null;
  }
  if ('subIssueProgress' in issue) {
    summary.progress = issue.subIssueProgress
      ? { total: issue.subIssueProgress.total, done: issue.subIssueProgress.done, more: issue.subIssueProgress.more }
      : null;
  }
  return summary;
}

/** @returns {TrackerItem} */
function toTrackerItem(issue) {
  return {
    ...toTrackerItemSummary(issue),
    description: issue.description ?? null,
    comments: (issue.comments ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt ?? null,
      author: personOf(comment.user),
    })),
    children: (issue.subIssues ?? []).map(toTrackerItemSummary),
    childrenMore: issue.subIssuesMore === true,
  };
}

/** @returns {TrackerWorkflowState} */
function toTrackerWorkflowState(state) {
  return { id: state.id, name: state.name, category: linearStateCategory(state.type), position: state.position };
}

const userError = (message) => Object.assign(new Error(message), { code: 'INVALID', userError: true });

const accountOf = (workspace) => ({
  id: workspace.id,
  name: workspace.name ?? null,
  user: personOf(workspace.user),
  current: workspace.current === true,
  authorizedAt: Number.isFinite(workspace.authorizedAt) ? workspace.authorizedAt : null,
});

/** Linear's public status (workspaces) as tracker accounts. @returns {TrackerAuthStatus} */
export function toTrackerAuthStatus(status) {
  if (!status?.connected) return { connected: false };
  const accounts = (status.workspaces ?? []).map(accountOf);
  return { connected: true, account: accounts.find((account) => account.current) ?? null, accounts };
}

const linearAccountLabel = (auth) => (
  readTrimmedString(auth?.user?.displayName)
  || readTrimmedString(auth?.user?.name)
  || readTrimmedString(auth?.organization?.name)
);

/**
 * The Linear tracker over Linear's libraries (`linearLibraries` from `./index.js` plus
 * `createLinearSessionStatusRuntime` and the SDK's `HOST_LINEAR_API_ORIGIN`),
 * injected so tests can pass fakes.
 * @returns {TrackerImplementation}
 */
export function createLinearTracker(libraries) {
  const {
    activateLinearAuth,
    clearLinearAuth,
    getLinearAuth,
    getLinearAuthWorkspaces,
    getLinearIssue,
    getLinearIssueSummaries,
    getLinearSessionCommentsEnabled,
    getValidLinearAccessToken,
    listLinearIssueStates,
    listLinearIssues,
    listLinearTeams,
    mergeLinearMappingView,
    postLinearSessionStatus,
    readStoredLinearMapping,
    revokeToken,
    setLinearSessionCommentsEnabled,
    setStoredLinearMapping,
    startAuthorization,
    toLinearPublicStatus,
    updateLinearIssue,
    createLinearSessionStatusRuntime,
    HOST_LINEAR_API_ORIGIN,
  } = libraries;

  const start = async (origin) => {
    try {
      const { authorizationUrl, expiresIn } = await startAuthorization({ origin: origin === 'desktop' ? 'desktop' : 'web' });
      return { authorizationUrl, expiresIn };
    } catch (error) {
      if (error?.code === 'LINEAR_CLIENT_ID_MISSING') throw userError(error.message);
      throw error;
    }
  };

  const mappingView = (stored, teams) => {
    const view = mergeLinearMappingView(stored, teams);
    return { connected: true, defaultProjectPath: view.defaultProjectPath, containers: view.teams };
  };

  return {
    auth: {
      status: async () => toTrackerAuthStatus(await readLinearAuthStatus(libraries)),
      start: ({ origin } = {}) => start(origin),
      disconnect: async () => ({ removed: await disconnectCurrentLinearWorkspace(libraries) }),
      activate: async (accountId) => {
        if (!activateLinearAuth(accountId)) return null;
        const auth = getLinearAuth();
        return toTrackerAuthStatus(auth ? toLinearPublicStatus(auth, getLinearAuthWorkspaces()) : null);
      },
    },

    list: async ({ query, cursor, state, people, priority, containerId } = {}) => {
      const status = linearStatusOfStateFilter(state ?? 'open');
      if (!status) throw userError(`Unknown state filter: ${state}`);
      const result = await listLinearIssues({
        query,
        cursor,
        status,
        assignee: people,
        teamId: containerId ?? undefined,
        priority,
      });
      if (result.connected === false) return { connected: false };
      return {
        connected: true,
        items: (result.issues ?? []).map(toTrackerItemSummary),
        cursor: result.cursor ?? null,
        hasMore: result.hasMore === true,
      };
    },

    get: async (id) => {
      const result = await getLinearIssue(id);
      if (result.connected === false) return { connected: false };
      return { connected: true, item: result.issue ? toTrackerItem(result.issue) : null };
    },

    states: async (containerId) => {
      const result = await listLinearIssueStates(containerId);
      if (result.connected === false) return { connected: false };
      return { connected: true, states: (result.states ?? []).map(toTrackerWorkflowState) };
    },

    updateState: async ({ id, stateId }) => {
      const result = await updateLinearIssue({ id, stateId });
      if (result.connected === false) return { connected: false };
      return { connected: true, item: result.issue ? toTrackerItem(result.issue) : null };
    },

    // `state.type` rides along while bundled phone UIs that read it still
    // talk to this server; newer schemas strip it. A state type this build
    // does not map (one Linear adds later) reads as `todo`, an open category
    // the live-summary schema accepts, so the item keeps its badge and the
    // open cadence instead of dropping out as "no longer answered".
    liveSummaries: async (identifiers) => {
      const result = await getLinearIssueSummaries(identifiers);
      if (result.connected === false) return { connected: false };
      return {
        connected: true,
        items: (result.issues ?? []).flatMap((issue) => {
          const type = readTrimmedString(issue.state?.type);
          if (!type) return [];
          return [{
            identifier: issue.identifier,
            title: issue.title,
            state: { name: issue.state.name ?? '', category: linearStateCategory(type) ?? UNMAPPED_STATE_CATEGORY, type },
          }];
        }),
      };
    },

    matchUrl: matchLinearUrl,

    mapping: {
      get: async () => {
        const teams = await listLinearTeams();
        if (teams.connected === false) return { connected: false };
        return mappingView(readStoredLinearMapping(), teams.teams);
      },
      set: async (input) => {
        if (!(await getValidLinearAccessToken())) return { connected: false };
        const stored = setStoredLinearMapping({
          defaultProjectPath: input?.defaultProjectPath,
          teamProjectPaths: input?.containerProjectPaths,
        });
        const teams = await listLinearTeams();
        return mappingView(stored, teams.connected === false ? [] : teams.teams);
      },
    },

    preferences: {
      get: async () => ({ sessionComments: getLinearSessionCommentsEnabled() }),
      set: async ({ sessionComments }) => ({ sessionComments: setLinearSessionCommentsEnabled(sessionComments) }),
    },

    sessionStatus: {
      post: ({ kind, sessionId, identifier, sessionOrigin }) => postLinearSessionStatus({
        kind,
        sessionId,
        issueIdentifier: identifier,
        sessionOrigin,
      }),
      createRuntime: () => createLinearSessionStatusRuntime(),
    },

    // What a host-Linear SDK guest borrows. The guest proxy keeps the token
    // on `apiOrigin`; nothing here returns it to a client.
    hostAccess: {
      apiOrigin: HOST_LINEAR_API_ORIGIN,
      account: async () => {
        const auth = getLinearAuth();
        return { connected: Boolean(auth?.accessToken), label: linearAccountLabel(auth) };
      },
      accessToken: async () => {
        try {
          return await getValidLinearAccessToken();
        } catch {
          return null;
        }
      },
      start: () => startAuthorization({ origin: 'web' }),
      disconnect: async () => {
        const auth = getLinearAuth();
        if (auth?.refreshToken) {
          await revokeToken(auth.refreshToken, 'refresh_token').catch(() => undefined);
        } else if (auth?.accessToken) {
          await revokeToken(auth.accessToken, 'access_token').catch(() => undefined);
        }
        clearLinearAuth(auth?.workspaceId);
      },
    },
  };
}

/** The tracker registry entry: the static descriptor and a lazy loader. */
export const linearTracker = Object.freeze({
  descriptor: LINEAR_TRACKER_DESCRIPTOR,
  load: async () => {
    const [{ linearLibraries }, { createLinearSessionStatusRuntime }, { HOST_LINEAR_API_ORIGIN }] = await Promise.all([
      import('./index.js'),
      import('./status-runtime.js'),
      import('@openchamber/sdk'),
    ]);
    return createLinearTracker({ ...linearLibraries, createLinearSessionStatusRuntime, HOST_LINEAR_API_ORIGIN });
  },
});
