
export type TrackerProviderId = string;
export type TrackerStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type TrackerPerson = { name: string | null; avatarUrl: string | null };

export type TrackerItemState = { id: string | null; name: string; category: TrackerStateCategory | null };

export type TrackerContainer = { id: string; key: string | null; name: string };

export type TrackerLabel = { id: string; name: string; color: string | null };

export type TrackerProgress = { total: number; done: number; more: boolean };

export type TrackerItemSummary = {
  provider: TrackerProviderId;
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: TrackerItemState | null;
  priority?: TrackerPriority | null;
  labels?: TrackerLabel[];
  assignee?: TrackerPerson | null;
  container?: TrackerContainer | null;
  parent?: TrackerItemSummary | null;
  progress?: TrackerProgress | null;
  updatedAt?: string | null;
};

export type TrackerComment = { id: string; body: string; createdAt: string | null; author: TrackerPerson | null };

export type TrackerItem = TrackerItemSummary & {
  description?: string | null;
  comments?: TrackerComment[];
  children?: TrackerItemSummary[];
  childrenMore?: boolean;
};

export type TrackerLiveSummary = { identifier: string; title: string; state: { name: string; category: TrackerStateCategory } };

export type TrackerWorkflowState = { id: string; name: string; category: TrackerStateCategory | null; position: number };

export type TrackerPeopleFilter = 'any' | 'me' | 'created';
export type TrackerPriorityFilter = 'all' | TrackerPriority;

export type TrackerListOptions = {
  query?: string;
  cursor?: string;
  state?: string;
  people?: TrackerPeopleFilter;
  priority?: TrackerPriorityFilter;
  containerId?: string | null;
};

export type TrackerAccount = {
  id: string;
  name: string | null;
  user?: TrackerPerson | null;
  current: boolean;
  authorizedAt?: number | null;
  status?: 'valid' | 'invalid';
  invalidReason?: string;
  method?: 'oauth' | 'token';
};

export type TrackerConnectInfo = {
  instance: string | null;
  instances: { kind: 'fixed'; origin: string } | { kind: 'user'; label: string; placeholder?: string };
  hasClient: boolean;
  redirectUri: string | null;
};

export type TrackerAuthStatus =
  | { connected: false; accounts?: TrackerAccount[]; connect?: TrackerConnectInfo }
  | { connected: true; account?: TrackerAccount | null; accounts?: TrackerAccount[]; connect?: TrackerConnectInfo };

export type TrackerConnectFailureCode =
  | 'UNSUPPORTED'
  | 'INSTANCE_REQUIRED'
  | 'INSTANCE_MISMATCH'
  | 'UNSUPPORTED_INSTANCE'
  | 'TOKEN_REQUIRED'
  | 'TOKEN_REFUSED'
  | 'USERNAME_REQUIRED'
  | 'USERNAME_INVALID'
  | 'CLIENT_MISSING'
  | 'CONNECT_SUPERSEDED'
  | 'TRACKER_UNAVAILABLE'
  | 'failed';

export type TrackerConnectResult = { ok: true } | { ok: false; code: TrackerConnectFailureCode; message: string | null };

export type TrackerAuthOrigin = 'desktop' | 'web';

export type TrackerConnectTokenInput = { instance?: string; token: string; username?: string };

export type TrackerOAuthClientInput = { instance?: string; clientId: string; clientSecret?: string };
export type TrackerAuthStart = { authorizationUrl: string; expiresIn: number };

type Connected<T> = { connected: false } | ({ connected: true } & T);

export type TrackerListResult = Connected<{ items: TrackerItemSummary[]; cursor: string | null; hasMore: boolean }>;
export type TrackerItemResult = Connected<{ item: TrackerItem | null }>;
export type TrackerStatesResult = Connected<{ states: TrackerWorkflowState[] }>;
export type TrackerStateUpdateInput = { id: string; stateId: string };

export type TrackerAuthMethod = 'oauth' | 'token';

export type TrackerDescriptor = {
  id: TrackerProviderId;
  name: string;
  authMethods: TrackerAuthMethod[];
  capabilities: {
    multipleAccounts: boolean;
    stateUpdate: boolean;
    children: boolean;
    labels: boolean;
    priority: boolean;
    filters: { people: boolean; priority: boolean };
    projectMapping: boolean;
    sessionComments: boolean;
    hostAccess: boolean;
  };
  stateFilters: string[];
  urlPatterns: { host: string; path: string; query?: { name: string } }[];
  identifierPattern: string;
};

export type TrackerContainerMapping = TrackerContainer & { projectPath: string | null };
export type TrackerMappingResult = Connected<{ defaultProjectPath: string | null; containers: TrackerContainerMapping[] }>;
export type TrackerMappingWrite = { defaultProjectPath: string | null; containerProjectPaths: { [containerId: string]: string } };

export type TrackerPreferences = {
  sessionComments: boolean;
};

export type TrackerSessionStatusKind = 'started' | 'completed' | 'failure';

export type TrackerSessionStatusPostInput = {
  kind: TrackerSessionStatusKind;
  sessionId: string;
  identifier?: string;
  sessionOrigin?: string;
};

export type TrackerSessionStatusPostResult =
  | { connected: false }
  | { connected: true; posted: true; commentId: string | null }
  | {
    connected: true;
    posted: false;
    skipped: 'already-posted' | 'issue-not-found' | 'not-started' | 'disabled' | 'origin-not-public';
  };

export interface TrackerAPI {
  providers(): Promise<TrackerDescriptor[]>;
  authStatus(provider: TrackerProviderId): Promise<TrackerAuthStatus>;
  authStart(provider: TrackerProviderId, origin?: TrackerAuthOrigin, options?: { instance?: string }): Promise<TrackerAuthStart>;
  authConnectToken(provider: TrackerProviderId, input: TrackerConnectTokenInput): Promise<TrackerConnectResult>;
  authSaveOAuthClient(provider: TrackerProviderId, input: TrackerOAuthClientInput): Promise<TrackerConnectResult>;
  authDisconnect(provider: TrackerProviderId): Promise<{ removed: boolean }>;
  authActivate(provider: TrackerProviderId, accountId: string): Promise<TrackerAuthStatus>;
  list(provider: TrackerProviderId, options?: TrackerListOptions): Promise<TrackerListResult>;
  refreshListReads(provider: TrackerProviderId): Promise<void>;
  refreshItemReads(provider: TrackerProviderId, identifier: string): Promise<void>;
  get(provider: TrackerProviderId, id: string): Promise<TrackerItemResult>;
  states(provider: TrackerProviderId, containerId: string): Promise<TrackerStatesResult>;
  updateState(provider: TrackerProviderId, input: TrackerStateUpdateInput): Promise<TrackerItemResult>;
  mappingGet(provider: TrackerProviderId): Promise<TrackerMappingResult>;
  mappingSet(provider: TrackerProviderId, mapping: TrackerMappingWrite): Promise<TrackerMappingResult>;
  sessionStatusPost(provider: TrackerProviderId, input: TrackerSessionStatusPostInput): Promise<TrackerSessionStatusPostResult>;
  preferencesGet(provider: TrackerProviderId): Promise<TrackerPreferences>;
  preferencesSet(provider: TrackerProviderId, preferences: TrackerPreferences): Promise<TrackerPreferences>;
}
