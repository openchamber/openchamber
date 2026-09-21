import type {
  LinearAPI,
  LinearAuthOrigin,
  LinearAuthStart,
  LinearAuthStatus,
  LinearIssue,
  LinearIssueAssignee,
  LinearIssueComment,
  LinearIssueLabel,
  LinearIssuePriority,
  LinearIssueGetResult,
  LinearIssueState,
  LinearIssueStatesResult,
  LinearIssueUpdateInput,
  LinearIssueUpdateResult,
  LinearIssueSummary,
  LinearIssueTeam,
  LinearIssuesListOptions,
  LinearIssuesListResult,
  LinearMappingResult,
  LinearMappingWrite,
  LinearOrganizationSummary,
  LinearPreferences,
  LinearSessionStatusPostInput,
  LinearSessionStatusPostResult,
  LinearTeamMapping,
  LinearWorkflowState,
  LinearUserSummary,
  LinearWorkspaceSummary,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

type LinearJson = {
  connected?: boolean;
  user?: LinearUserSummary | null;
  organization?: LinearOrganizationSummary | null;
  scope?: string;
  workspaces?: LinearWorkspaceSummary[];
  authorizationUrl?: string;
  expiresIn?: number;
  removed?: boolean;
  error?: string;
  issues?: LinearIssueSummary[];
  cursor?: string | null;
  hasMore?: boolean;
  issue?: LinearIssue | null;
  states?: LinearWorkflowState[];
  defaultProjectPath?: string | null;
  teams?: LinearTeamMapping[];
  posted?: boolean;
  skipped?: string;
  commentId?: string | null;
  sessionComments?: boolean;
};

async function readLinearJson(response: Response): Promise<LinearJson | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readErrorMessage(payload: LinearJson | null, fallback: string): string {
  const error = payload?.error?.trim();
  return error || fallback;
}

function readFiniteNumber(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? (value ?? null) : null;
}

function readRawString(value: string | null | undefined): string | null {
  return Object.prototype.toString.call(value) === '[object String]' ? `${value}` : null;
}

function parseUser(payload: LinearUserSummary | null | undefined): LinearUserSummary | null {
  const id = payload?.id?.trim();
  if (!id) return null;
  return {
    id,
    name: payload?.name?.trim() || null,
    displayName: payload?.displayName?.trim() || null,
    email: payload?.email?.trim() || null,
    avatarUrl: payload?.avatarUrl?.trim() || null,
  };
}

function parseOrganization(payload: LinearOrganizationSummary | null | undefined): LinearOrganizationSummary | null {
  const id = payload?.id?.trim();
  const name = payload?.name?.trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    urlKey: payload?.urlKey?.trim() || null,
  };
}

function parseWorkspace(payload: LinearWorkspaceSummary | null | undefined): LinearWorkspaceSummary | null {
  const id = payload?.id?.trim();
  if (!id) return null;
  const authorizedAt = payload?.authorizedAt;
  return {
    id,
    name: payload?.name?.trim() || null,
    urlKey: payload?.urlKey?.trim() || null,
    current: payload?.current === true,
    user: parseUser(payload?.user),
    authorizedAt: readFiniteNumber(authorizedAt),
  };
}

function toAuthStatus(payload: LinearJson | null): LinearAuthStatus | null {
  if (payload?.connected !== true && payload?.connected !== false) {
    return null;
  }
  const workspaces = Array.isArray(payload.workspaces)
    ? payload.workspaces.map(parseWorkspace).filter((entry): entry is LinearWorkspaceSummary => entry != null)
    : [];
  return {
    connected: payload.connected,
    user: parseUser(payload.user),
    organization: parseOrganization(payload.organization),
    scope: payload.scope?.trim() || undefined,
    workspaces: payload.connected ? workspaces : undefined,
  };
}

function toAuthStart(payload: LinearJson | null): LinearAuthStart | null {
  const authorizationUrl = payload?.authorizationUrl?.trim();
  const expiresIn = payload?.expiresIn;
  const scope = payload?.scope?.trim();
  if (!authorizationUrl || !Number.isFinite(expiresIn) || expiresIn == null || !scope) {
    return null;
  }
  return { authorizationUrl, expiresIn, scope };
}

function parseState(payload: LinearIssueState | null | undefined): LinearIssueState | null {
  const id = payload?.id?.trim() || null;
  const name = payload?.name?.trim() || null;
  const type = payload?.type?.trim() || null;
  if (!id && !name && !type) return null;
  return { id, name, type };
}

function parseWorkflowState(payload: LinearWorkflowState | null | undefined): LinearWorkflowState | null {
  const id = payload?.id?.trim();
  const name = payload?.name?.trim();
  if (!id || !name) return null;
  const position = payload?.position;
  return {
    id,
    name,
    type: payload?.type?.trim() || null,
    position: readFiniteNumber(position) ?? 0,
  };
}

function parseAssignee(payload: LinearIssueAssignee | null | undefined): LinearIssueAssignee | null {
  const name = payload?.name?.trim() || null;
  const displayName = payload?.displayName?.trim() || null;
  const avatarUrl = payload?.avatarUrl?.trim() || null;
  if (!name && !displayName && !avatarUrl) return null;
  return { name, displayName, avatarUrl };
}

function parseTeam(payload: LinearIssueTeam | null | undefined): LinearIssueTeam | null {
  const id = payload?.id?.trim();
  const key = payload?.key?.trim();
  const name = payload?.name?.trim();
  if (!id || !key || !name) return null;
  return { id, key, name };
}

function parsePriority(value: LinearIssueSummary['priority']): LinearIssuePriority | null {
  if (value !== 0 && value !== 1 && value !== 2 && value !== 3 && value !== 4) {
    return null;
  }
  return value;
}

function parseLabelColor(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

function parseLabel(payload: LinearIssueLabel | null | undefined): LinearIssueLabel | null {
  if (!payload) return null;
  const id = payload?.id?.trim();
  const name = payload?.name?.trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    color: parseLabelColor(payload.color),
  };
}

function parseLabels(payload: LinearIssueSummary['labels']): LinearIssueLabel[] {
  if (!Array.isArray(payload)) return [];
  return payload.map(parseLabel).filter((label): label is LinearIssueLabel => label != null);
}

function parseIssueSummary(payload: LinearIssueSummary | null | undefined): LinearIssueSummary | null {
  if (!payload) return null;
  const id = payload?.id?.trim();
  const identifier = payload?.identifier?.trim();
  const title = payload?.title?.trim();
  const url = payload?.url?.trim();
  if (!id || !identifier || !title || !url) return null;
  return {
    id,
    identifier,
    title,
    url,
    state: parseState(payload.state),
    assignee: parseAssignee(payload.assignee),
    team: parseTeam(payload.team),
    priority: parsePriority(payload.priority),
    labels: parseLabels(payload.labels),
  };
}

function parseComment(payload: LinearIssueComment | null | undefined): LinearIssueComment | null {
  const id = payload?.id?.trim();
  if (!id) return null;
  const body = payload?.body;
  return {
    id,
    body: readRawString(body) ?? '',
    createdAt: payload?.createdAt?.trim() || null,
    user: payload?.user
      ? {
        name: payload.user.name?.trim() || null,
        displayName: payload.user.displayName?.trim() || null,
        avatarUrl: payload.user.avatarUrl?.trim() || null,
      }
      : null,
  };
}

function parseIssue(payload: LinearIssue | null | undefined): LinearIssue | null {
  const summary = parseIssueSummary(payload);
  if (!summary) return null;
  const comments = Array.isArray(payload?.comments)
    ? payload.comments.map(parseComment).filter((comment): comment is LinearIssueComment => comment != null)
    : [];
  const description = payload?.description;
  return {
    ...summary,
    description: readRawString(description),
    comments,
  };
}

function toIssuesList(payload: LinearJson | null): LinearIssuesListResult | null {
  if (payload?.connected !== true && payload?.connected !== false) {
    return null;
  }
  if (payload.connected === false) {
    return { connected: false };
  }
  const issues = Array.isArray(payload.issues)
    ? payload.issues.map(parseIssueSummary).filter((issue): issue is LinearIssueSummary => issue != null)
    : [];
  return {
    connected: true,
    issues,
    cursor: payload.cursor?.trim() || null,
    hasMore: payload.hasMore === true,
  };
}

function toIssueGet(payload: LinearJson | null): LinearIssueGetResult | null {
  if (payload?.connected !== true && payload?.connected !== false) {
    return null;
  }
  if (payload.connected === false) {
    return { connected: false };
  }
  return {
    connected: true,
    issue: parseIssue(payload.issue),
  };
}

function toIssueStates(payload: LinearJson | null): LinearIssueStatesResult | null {
  if (payload?.connected !== true && payload?.connected !== false) {
    return null;
  }
  if (payload.connected === false) {
    return { connected: false };
  }
  const states = Array.isArray(payload.states)
    ? payload.states.map(parseWorkflowState).filter((state): state is LinearWorkflowState => state != null)
    : [];
  return { connected: true, states };
}

function toIssueUpdate(payload: LinearJson | null): LinearIssueUpdateResult | null {
  if (payload?.connected !== true && payload?.connected !== false) {
    return null;
  }
  if (payload.connected === false) {
    return { connected: false };
  }
  return {
    connected: true,
    issue: parseIssue(payload.issue),
  };
}

function parseTeamMapping(payload: LinearTeamMapping | null | undefined): LinearTeamMapping | null {
  const id = payload?.id?.trim();
  const key = payload?.key?.trim();
  const name = payload?.name?.trim();
  if (!id || !key || !name) return null;
  const projectPath = payload?.projectPath?.trim() || null;
  return { id, key, name, projectPath };
}

function toMapping(payload: LinearJson | null): LinearMappingResult | null {
  if (payload?.connected !== true && payload?.connected !== false) {
    return null;
  }
  if (payload.connected === false) {
    return { connected: false };
  }
  const teams = Array.isArray(payload.teams)
    ? payload.teams.map(parseTeamMapping).filter((team): team is LinearTeamMapping => team != null)
    : [];
  return {
    connected: true,
    defaultProjectPath: payload.defaultProjectPath?.trim() || null,
    teams,
  };
}

type LinearSessionStatusSkipped = Extract<
  LinearSessionStatusPostResult,
  { posted: false }
>['skipped'];

const SESSION_STATUS_SKIPPED: readonly LinearSessionStatusSkipped[] = [
  'already-posted',
  'issue-not-found',
  'not-started',
  'disabled',
  'origin-not-public',
];

function parseSkipped(value: string | undefined): LinearSessionStatusSkipped | null {
  return SESSION_STATUS_SKIPPED.find((entry) => entry === value) ?? null;
}

function toPreferences(payload: LinearJson | null): LinearPreferences | null {
  if (payload?.sessionComments !== true && payload?.sessionComments !== false) {
    return null;
  }
  return { sessionComments: payload.sessionComments };
}

function toSessionStatusPost(payload: LinearJson | null): LinearSessionStatusPostResult | null {
  if (payload?.connected !== true && payload?.connected !== false) {
    return null;
  }
  if (payload.connected === false) {
    return { connected: false };
  }
  if (payload.posted === true) {
    return {
      connected: true,
      posted: true,
      commentId: payload.commentId?.trim() || null,
    };
  }
  const skipped = parseSkipped(payload.skipped);
  if (payload.posted === false && skipped) {
    return { connected: true, posted: false, skipped };
  }
  return null;
}

export const createWebLinearAPI = (): LinearAPI => ({
  async authStatus(): Promise<LinearAuthStatus> {
    const response = await runtimeFetch('/api/linear/auth/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readLinearJson(response);
    const status = toAuthStatus(payload);
    if (!response.ok || !status) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to load Linear status'));
    }
    return status;
  },

  async authStart(origin?: LinearAuthOrigin): Promise<LinearAuthStart> {
    const response = await runtimeFetch('/api/linear/auth/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(origin ? { origin } : {}),
    });
    const payload = await readLinearJson(response);
    const started = toAuthStart(payload);
    if (!response.ok || !started) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to start Linear auth'));
    }
    return started;
  },

  async authDisconnect(): Promise<{ removed: boolean }> {
    const response = await runtimeFetch('/api/linear/auth', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    const payload = await readLinearJson(response);
    if (!response.ok) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to disconnect Linear'));
    }
    return { removed: payload?.removed === true };
  },

  async authActivate(organizationId: string): Promise<LinearAuthStatus> {
    const response = await runtimeFetch('/api/linear/auth/activate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ organizationId }),
    });
    const payload = await readLinearJson(response);
    const status = toAuthStatus(payload);
    if (!response.ok || !status) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to switch Linear workspace'));
    }
    return status;
  },

  async issuesList(options?: LinearIssuesListOptions): Promise<LinearIssuesListResult> {
    const params = new URLSearchParams();
    const query = options?.query?.trim();
    const cursor = options?.cursor?.trim();
    const status = options?.status?.trim();
    const assignee = options?.assignee?.trim();
    const teamId = options?.teamId?.trim();
    const priority = options?.priority?.trim();
    if (query) params.set('query', query);
    if (cursor) params.set('cursor', cursor);
    if (status) params.set('status', status);
    if (assignee) params.set('assignee', assignee);
    if (teamId) params.set('teamId', teamId);
    if (priority) params.set('priority', priority);
    const queryString = params.toString();
    const suffix = queryString ? `?${queryString}` : '';
    const response = await runtimeFetch(`/api/linear/issues/list${suffix}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readLinearJson(response);
    const result = toIssuesList(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to load Linear issues'));
    }
    return result;
  },

  async issueGet(id: string): Promise<LinearIssueGetResult> {
    const params = new URLSearchParams({ id });
    const response = await runtimeFetch(`/api/linear/issues/get?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readLinearJson(response);
    const result = toIssueGet(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to load Linear issue'));
    }
    return result;
  },

  async issueStates(teamId: string): Promise<LinearIssueStatesResult> {
    const params = new URLSearchParams({ teamId });
    const response = await runtimeFetch(`/api/linear/issues/states?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readLinearJson(response);
    const result = toIssueStates(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to load Linear workflow states'));
    }
    return result;
  },

  async issueUpdate(input: LinearIssueUpdateInput): Promise<LinearIssueUpdateResult> {
    const response = await runtimeFetch('/api/linear/issues/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        id: input.id,
        stateId: input.stateId,
      }),
    });
    const payload = await readLinearJson(response);
    const result = toIssueUpdate(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to update Linear issue'));
    }
    return result;
  },

  async mappingGet(): Promise<LinearMappingResult> {
    const response = await runtimeFetch('/api/linear/mapping', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readLinearJson(response);
    const result = toMapping(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to load Linear mapping'));
    }
    return result;
  },

  async mappingSet(mapping: LinearMappingWrite): Promise<LinearMappingResult> {
    const response = await runtimeFetch('/api/linear/mapping', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        defaultProjectPath: mapping.defaultProjectPath,
        teamProjectPaths: mapping.teamProjectPaths,
      }),
    });
    const payload = await readLinearJson(response);
    const result = toMapping(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to save Linear mapping'));
    }
    return result;
  },

  async sessionStatusPost(input: LinearSessionStatusPostInput): Promise<LinearSessionStatusPostResult> {
    const response = await runtimeFetch('/api/linear/session-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        kind: input.kind,
        sessionId: input.sessionId,
        issueIdentifier: input.issueIdentifier,
        sessionOrigin: input.sessionOrigin,
      }),
    });
    const payload = await readLinearJson(response);
    const result = toSessionStatusPost(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to post Linear session status'));
    }
    return result;
  },

  async preferencesGet(): Promise<LinearPreferences> {
    const response = await runtimeFetch('/api/linear/preferences', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readLinearJson(response);
    const result = toPreferences(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to load Linear preferences'));
    }
    return result;
  },

  async preferencesSet(preferences: LinearPreferences): Promise<LinearPreferences> {
    const response = await runtimeFetch('/api/linear/preferences', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ sessionComments: preferences.sessionComments }),
    });
    const payload = await readLinearJson(response);
    const result = toPreferences(payload);
    if (!response.ok || !result) {
      throw new Error(readErrorMessage(payload, response.statusText || 'Failed to save Linear preferences'));
    }
    return result;
  },
});
