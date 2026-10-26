/**
 * Linear through the legacy `/api/linear/*` routes, for a server that
 * predates `/api/tracker`. Such a server serves exactly Linear, in Linear's
 * own shapes; this maps them to the neutral tracker shapes the same way the
 * server's tracker adapter does (`server/lib/linear/tracker.js`). Keep
 * `BUILT_IN_LINEAR_TRACKER` identical to that module's descriptor.
 */
import { z } from 'zod';
import type {
  TrackerAPI,
  TrackerAccount,
  TrackerAuthStatus,
  TrackerDescriptor,
  TrackerItem,
  TrackerItemSummary,
  TrackerListOptions,
  TrackerPerson,
  TrackerPriority,
  TrackerProviderId,
} from '@openchamber/ui/lib/api/types';
import {
  disconnected,
  preferencesSchema,
  requestJson,
  sessionStatusResultSchema,
  type TrackerFetch,
  type TrackerRequest,
} from './trackers-schemas';
import { linearStateCategory } from '@openchamber/ui/lib/trackers/legacyLinear';

export const BUILT_IN_LINEAR_TRACKER: TrackerDescriptor = {
  id: 'linear',
  name: 'Linear',
  authMethods: ['oauth'],
  capabilities: {
    multipleAccounts: true,
    stateUpdate: true,
    children: true,
    labels: true,
    priority: true,
    filters: { people: true, priority: true },
    projectMapping: true,
    sessionComments: true,
    hostAccess: true,
  },
  stateFilters: ['open', 'all', 'backlog', 'todo', 'in-progress', 'inReview', 'done', 'canceled', 'duplicate'],
  urlPatterns: [{ host: 'linear.app', path: '^/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }],
  identifierPattern: '^[A-Za-z][A-Za-z0-9]*-\\d+$',
};

const PRIORITY_BY_VALUE: readonly TrackerPriority[] = ['none', 'urgent', 'high', 'medium', 'low'];

// Neutral filter ids to Linear's list `status`; the rest are the same word.
const LINEAR_STATUS_BY_STATE_FILTER = new Map([['in-progress', 'started'], ['done', 'completed']]);

const text = z.string().trim().min(1);
const optionalText = z.string().trim().nullish().catch(null).transform((value) => value || null);

const listOf = <T>(schema: z.ZodType<T>) => z.array(z.unknown()).catch([]).transform((values) => values.flatMap((value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? [parsed.data] : [];
}));

const linearPersonSchema = z.object({ name: optionalText, displayName: optionalText, avatarUrl: optionalText })
  .nullish()
  .catch(null)
  .transform((person): TrackerPerson | null => {
    const name = person?.displayName || person?.name || null;
    const avatarUrl = person?.avatarUrl ?? null;
    return name || avatarUrl ? { name, avatarUrl } : null;
  });

const linearStateSchema = z.object({ id: optionalText, name: optionalText, type: optionalText })
  .nullish()
  .catch(null)
  .transform((state) => (state && (state.id || state.name || state.type)
    ? { id: state.id, name: state.name ?? '', category: linearStateCategory(state.type) }
    : null));

const linearIssueFields = {
  id: text,
  identifier: text,
  title: text,
  url: text,
  state: linearStateSchema,
  assignee: linearPersonSchema,
  team: z.object({ id: text, key: optionalText, name: text }).nullish().catch(null),
  priority: z.number().int().nullish().catch(null),
  updatedAt: optionalText,
};

type LinearIssueFields = z.output<z.ZodObject<typeof linearIssueFields>>;

const summaryOf = (issue: LinearIssueFields, provider: TrackerProviderId): TrackerItemSummary => ({
  provider,
  id: issue.id,
  identifier: issue.identifier,
  title: issue.title,
  url: issue.url,
  state: issue.state,
  priority: issue.priority != null ? PRIORITY_BY_VALUE[issue.priority] ?? null : null,
  assignee: issue.assignee,
  container: issue.team ? { id: issue.team.id, key: issue.team.key, name: issue.team.name } : null,
  updatedAt: issue.updatedAt,
});

const relatedSchema = z.object(linearIssueFields);

const linearSummaryObject = z.object({
  ...linearIssueFields,
  labels: listOf(z.object({
    id: text,
    name: text,
    color: z.string().nullish().catch(null).transform((value) => {
      const hex = value?.trim().replace(/^#/, '') ?? '';
      return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
    }),
  })),
  parent: relatedSchema.nullish().catch(null),
  subIssueProgress: z.object({ total: z.number().int().positive(), done: z.number(), more: z.boolean().catch(false) }).nullish().catch(null),
});

type LinearSummary = z.output<typeof linearSummaryObject>;

const fullSummaryOf = (issue: LinearSummary, provider: TrackerProviderId): TrackerItemSummary => ({
  ...summaryOf(issue, provider),
  labels: issue.labels,
  parent: issue.parent ? summaryOf(issue.parent, provider) : null,
  progress: issue.subIssueProgress
    ? { ...issue.subIssueProgress, done: Math.min(Math.max(issue.subIssueProgress.done, 0), issue.subIssueProgress.total) }
    : null,
});

const linearIssueObject = linearSummaryObject.extend({
  description: z.string().nullish().catch(null),
  comments: listOf(z.object({ id: text, body: z.string().catch(''), createdAt: optionalText, user: linearPersonSchema })),
  subIssues: listOf(relatedSchema),
  subIssuesMore: z.boolean().catch(false),
});

const itemOf = (issue: z.output<typeof linearIssueObject>, provider: TrackerProviderId): TrackerItem => ({
  ...fullSummaryOf(issue, provider),
  description: issue.description ?? null,
  comments: issue.comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt, author: comment.user })),
  children: issue.subIssues.map((child) => summaryOf(child, provider)),
  childrenMore: issue.subIssuesMore,
});

const linearWorkspaceSchema = z.object({
  id: text,
  name: optionalText,
  current: z.boolean().catch(false),
  user: linearPersonSchema,
  authorizedAt: z.number().nullish().catch(null),
});

const authStatusSchema = z.object({
  connected: z.boolean(),
  user: linearPersonSchema,
  organization: z.object({ id: text, name: optionalText }).nullish().catch(null),
  workspaces: listOf(linearWorkspaceSchema),
}).transform((status): TrackerAuthStatus => {
  if (!status.connected) return { connected: false };
  const accounts: TrackerAccount[] = [...status.workspaces];
  // Servers from before multiple workspaces name only the organization.
  if (accounts.length === 0 && status.organization) {
    accounts.push({ id: status.organization.id, name: status.organization.name, user: status.user, current: true, authorizedAt: null });
  }
  return { connected: true, account: accounts.find((account) => account.current) ?? null, accounts };
});

const legacyListQuery = (options: TrackerListOptions | undefined): string => {
  const params = new URLSearchParams();
  const set = (key: string, value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (trimmed) params.set(key, trimmed);
  };
  const state = options?.state?.trim();
  set('query', options?.query);
  set('cursor', options?.cursor);
  set('status', state ? LINEAR_STATUS_BY_STATE_FILTER.get(state) ?? state : undefined);
  set('assignee', options?.people);
  set('teamId', options?.containerId);
  set('priority', options?.priority);
  const query = params.toString();
  return query ? `?${query}` : '';
};

/** Every tracker call but `providers`, through the legacy Linear routes. */
export const createLegacyLinearTrackerAPI = (fetch: TrackerFetch): Omit<TrackerAPI, 'providers'> => {
  const call = async <T>(provider: TrackerProviderId, path: string, request: TrackerRequest, schema: z.ZodType<T>, failure: string): Promise<T> => {
    // An older server serves no other tracker.
    if (provider !== BUILT_IN_LINEAR_TRACKER.id) throw new Error(`Unknown tracker: ${provider}`);
    return requestJson(fetch, `/api/linear${path}`, request, schema, failure);
  };

  const GET = { method: 'GET' } as const;

  const disconnectedOr = <T>(connected: z.ZodType<T>) => z.union([disconnected, connected]);

  const itemResult = (provider: TrackerProviderId) => disconnectedOr(z.object({
    connected: z.literal(true),
    issue: linearIssueObject.nullish().catch(null),
  }).transform(({ issue }) => ({ connected: true as const, item: issue ? itemOf(issue, provider) : null })));

  const mappingResult = disconnectedOr(z.object({
    connected: z.literal(true),
    defaultProjectPath: optionalText,
    teams: listOf(z.object({ id: text, key: optionalText, name: text, projectPath: optionalText })),
  }).transform(({ defaultProjectPath, teams }) => ({ connected: true as const, defaultProjectPath, containers: teams })));

  return {
    authStatus: (provider) => call(provider, '/auth/status', GET, authStatusSchema, 'Failed to load Linear status'),

    authStart: (provider, origin) => call(
      provider,
      '/auth/start',
      { method: 'POST', body: JSON.stringify({ origin }) },
      z.object({ authorizationUrl: text, expiresIn: z.number().positive() }),
      'Failed to start Linear auth',
    ),

    authDisconnect: (provider) => call(provider, '/auth', { method: 'DELETE' }, z.object({ removed: z.boolean().catch(false) }), 'Failed to disconnect Linear')
      .then(({ removed }) => ({ removed })),

    authActivate: (provider, accountId) => call(provider, '/auth/activate', { method: 'POST', body: JSON.stringify({ organizationId: accountId }) }, authStatusSchema, 'Failed to switch Linear workspace'),

    list: (provider, options) => call(provider, `/issues/list${legacyListQuery(options)}`, GET, disconnectedOr(z.object({
      connected: z.literal(true),
      issues: listOf(linearSummaryObject),
      cursor: optionalText,
      hasMore: z.boolean().catch(false),
    }).transform(({ issues, cursor, hasMore }) => ({
      connected: true as const,
      items: issues.map((issue) => fullSummaryOf(issue, provider)),
      cursor,
      hasMore,
    }))), 'Failed to load Linear issues'),

    refreshListReads: async (provider) => {
      await call(provider, '/read-cache/refresh?scope=lists', { method: 'POST' }, z.unknown(), 'Failed to refresh Linear lists');
    },

    get: (provider, id) => call(provider, `/issues/get?${new URLSearchParams({ id }).toString()}`, GET, itemResult(provider), 'Failed to load Linear issue'),

    states: (provider, containerId) => call(provider, `/issues/states?${new URLSearchParams({ teamId: containerId }).toString()}`, GET, disconnectedOr(z.object({
      connected: z.literal(true),
      states: listOf(z.object({ id: text, name: text, type: optionalText, position: z.number().catch(0) })
        .transform(({ id, name, type, position }) => ({ id, name, category: linearStateCategory(type), position }))),
    })), 'Failed to load Linear workflow states'),

    updateState: (provider, input) => call(provider, '/issues/update', { method: 'POST', body: JSON.stringify({ id: input.id, stateId: input.stateId }) }, itemResult(provider), 'Failed to update Linear issue'),

    mappingGet: (provider) => call(provider, '/mapping', GET, mappingResult, 'Failed to load Linear mapping'),

    mappingSet: (provider, mapping) => call(provider, '/mapping', {
      method: 'PUT',
      body: JSON.stringify({ defaultProjectPath: mapping.defaultProjectPath, teamProjectPaths: mapping.containerProjectPaths }),
    }, mappingResult, 'Failed to save Linear mapping'),

    sessionStatusPost: (provider, input) => call(provider, '/session-status', {
      method: 'POST',
      body: JSON.stringify({ kind: input.kind, sessionId: input.sessionId, issueIdentifier: input.identifier, sessionOrigin: input.sessionOrigin }),
    }, sessionStatusResultSchema, 'Failed to post Linear session status'),

    preferencesGet: (provider) => call(provider, '/preferences', GET, preferencesSchema, 'Failed to load Linear preferences'),

    preferencesSet: (provider, preferences) => call(provider, '/preferences', {
      method: 'PUT',
      body: JSON.stringify({ sessionComments: preferences.sessionComments }),
    }, preferencesSchema, 'Failed to save Linear preferences'),
  };
};
