import { disconnectCurrentLinearWorkspace, readLinearAuthStatus } from './auth-status.js';
import { isPlainObject, readTrimmedString } from './parse.js';
import type { TrackerDescriptor, TrackerStateCategory, TrackerPriority, TrackerItemSummary, TrackerItem, TrackerWorkflowState, TrackerAuthStatus, TrackerImplementation } from '../trackers/tracker-contract.js';
import type { linearLibraries } from './index.js';
import type { createLinearSessionStatusRuntime } from './status-runtime.js';
import type { HOST_LINEAR_API_ORIGIN } from '@openchamber/sdk';
import type { LinearIssue, LinearIssueSummary, LinearWorkflowState } from './issue-contracts.js';
import type { LinearTeam } from './teams.js';
import type { LinearAuth, getLinearAuthWorkspaces } from './auth.js';

const LINEAR_TRACKER_ID = 'linear';

export const LINEAR_TRACKER_DESCRIPTOR: TrackerDescriptor = Object.freeze({
  id: LINEAR_TRACKER_ID,
  name: 'Linear',
  authMethods: Object.freeze(['oauth'] as const),
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
  duplicate: 'canceled',
} satisfies Record<string, TrackerStateCategory>;

const UNMAPPED_STATE_CATEGORY = 'todo';

function isStateType(type: string | null): type is keyof typeof STATE_CATEGORY_BY_TYPE {
  return Object.hasOwn(STATE_CATEGORY_BY_TYPE, type ?? 'null');
}

export function linearStateCategory(type: string | null) {
  return isStateType(type) ? STATE_CATEGORY_BY_TYPE[type] : null;
}

const PRIORITY_BY_VALUE = ['none', 'urgent', 'high', 'medium', 'low'] as const satisfies readonly TrackerPriority[];

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isPriorityNumber(value: number | null): value is 0 | 1 | 2 | 3 | 4 {
  return isInteger(value) && value >= 0 && value < PRIORITY_BY_VALUE.length;
}

export function linearPriority(value: number | null) {
  return isPriorityNumber(value) ? PRIORITY_BY_VALUE[value] : null;
}

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

function isStateFilter(state: string): state is keyof typeof LINEAR_STATUS_BY_STATE_FILTER {
  return Object.hasOwn(LINEAR_STATUS_BY_STATE_FILTER, state);
}

export function linearStatusOfStateFilter(state: string) {
  return isStateFilter(state) ? LINEAR_STATUS_BY_STATE_FILTER[state] : null;
}

const URL_PATTERNS = LINEAR_TRACKER_DESCRIPTOR.urlPatterns.map((pattern) => ({
  host: pattern.host,
  path: new RegExp(pattern.path),
}));

export function matchLinearUrl(value: Parameters<typeof readTrimmedString>[0]) {
  const raw = readTrimmedString(value);
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  for (const pattern of URL_PATTERNS) {
    if (pattern.host !== host) continue;
    const match = pattern.path.exec(url.pathname);
    if (match?.[1] !== undefined) return match[1].toUpperCase();
  }
  return null;
}

const personOf = (value: { displayName: string | null; name: string | null; avatarUrl: string | null } | null) => {
  if (!isPlainObject(value)) return null;
  const name = value?.name || value?.displayName || null;
  const avatarUrl = value?.avatarUrl || null;
  return name || avatarUrl ? { name, avatarUrl } : null;
};

const stateOf = (state: LinearIssueSummary['state']) => (state
  ? { id: state.id ?? null, name: state.name ?? '', category: linearStateCategory(state.type) }
  : null);

type RelatedIssue = NonNullable<LinearIssueSummary['parent']>;
type SummaryInput = RelatedIssue & Partial<Pick<LinearIssueSummary, 'labels' | 'parent' | 'subIssueProgress'>>;

function toTrackerItemSummary(issue: SummaryInput): TrackerItemSummary {
  const summary: TrackerItemSummary = {
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
    summary.labels = issue.labels.map((label: LinearIssueSummary['labels'][number]) => ({ id: label.id, name: label.name, color: label.color ?? null }));
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

function toTrackerItem(issue: LinearIssue): TrackerItem {
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

function toTrackerWorkflowState(state: LinearWorkflowState): TrackerWorkflowState {
  return { id: state.id, name: state.name, category: linearStateCategory(state.type), position: state.position };
}

const userError = (message: string | undefined) => Object.assign(new Error(message), { code: 'INVALID', userError: true });

const accountOf = (workspace: ReturnType<typeof getLinearAuthWorkspaces>[number]) => ({
  id: workspace.id,
  name: workspace.name ?? null,
  user: personOf(workspace.user),
  current: workspace.current === true,
  authorizedAt: Number.isFinite(workspace.authorizedAt) ? workspace.authorizedAt : null,
});

export function toTrackerAuthStatus(status: Awaited<ReturnType<typeof readLinearAuthStatus>> | null): TrackerAuthStatus {
  if (!status?.connected) return { connected: false };
  const accounts = (status.workspaces ?? []).map(accountOf);
  return { connected: true, account: accounts.find((account) => account.current) ?? null, accounts };
}

const linearAccountLabel = (auth: LinearAuth | null) => (
  readTrimmedString(auth?.user?.name)
  || readTrimmedString(auth?.user?.displayName)
  || readTrimmedString(auth?.organization?.name)
);

type TrackerLibraries = typeof linearLibraries & {
  createLinearSessionStatusRuntime: typeof createLinearSessionStatusRuntime;
  HOST_LINEAR_API_ORIGIN: typeof HOST_LINEAR_API_ORIGIN;
};

function isMissingClientError(cause: unknown): cause is { message?: unknown } {
  return canReadErrorCode(cause) && cause.code === 'LINEAR_CLIENT_ID_MISSING';
}

function canReadErrorCode(cause: unknown): cause is { code?: unknown } {
  return cause != null;
}

export function createLinearTracker(libraries: TrackerLibraries): TrackerImplementation {
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

  const start = async (origin?: 'desktop' | 'web') => {
    try {
      const { authorizationUrl, expiresIn } = await startAuthorization({ origin: origin === 'desktop' ? 'desktop' : 'web' });
      return { authorizationUrl, expiresIn };
    } catch (error) {
      if (isMissingClientError(error)) {
        const message = error.message;
        throw userError(message === undefined ? undefined : `${message}`);
      }
      throw error;
    }
  };

  const mappingView = (stored: ReturnType<TrackerLibraries['readStoredLinearMapping']>, teams: readonly LinearTeam[]) => {
    const view = mergeLinearMappingView(stored, teams);
    return { connected: true as const, defaultProjectPath: view.defaultProjectPath, containers: view.teams };
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
