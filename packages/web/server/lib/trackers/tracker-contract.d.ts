
export type TrackerProviderId = string;
export type TrackerStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type TrackerPerson = { name: string | null; avatarUrl: string | null };

export type TrackerItemSummary = {
  provider: TrackerProviderId;
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: { id: string | null; name: string; category: TrackerStateCategory | null } | null;
  priority?: TrackerPriority | null;
  labels?: { id: string; name: string; color: string | null }[];
  assignee?: TrackerPerson | null;
  container?: { id: string; key: string | null; name: string } | null;
  parent?: TrackerItemSummary | null;
  progress?: { total: number; done: number; more: boolean } | null;
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

export type TrackerLiveSummaryWire = TrackerLiveSummary & { state: TrackerLiveSummary['state'] & { type?: string } };

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

export type Connected<T> = { connected: false } | ({ connected: true } & T);

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

export type TrackerMappingView = {
  defaultProjectPath: string | null;
  containers: { id: string; key: string | null; name: string; projectPath: string | null }[];
};
export type TrackerMappingInput = { defaultProjectPath: string | null; containerProjectPaths: Record<string, string> };
export type TrackerPreferences = { sessionComments: boolean };
export type TrackerSessionStatusKind = 'started' | 'completed' | 'failure';
export type TrackerSessionStatusInput = { kind: TrackerSessionStatusKind; sessionId: string; identifier?: string; sessionOrigin?: string };
export type TrackerSessionStatusResult = Connected<{ posted?: boolean; skipped?: string; commentId?: string }>;

export type TrackerRuntimeEvent = {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { sessionID?: string; type?: string };
    status?: { type?: string };
    error?: { name?: string };
  };
};

export interface TrackerSessionStatusRuntime {
  processPayload(payload: TrackerRuntimeEvent): void;
  stop(): void;
}

export type TrackerAccountsView = {
  instance: string | null;
  accounts: Array<{ id: string; login: string | null; name?: string; avatarUrl?: string; connectedAt: number; status: 'valid' | 'invalid'; invalidReason?: string; method: 'oauth' | 'token' }>;
  activeAccountId: string | null;
  hasClient: boolean;
};

export interface TrackerImplementation {
  auth: {
    status(input?: { origin?: string | null }): Promise<TrackerAuthStatus>;
    start(input?: { origin?: 'desktop' | 'web'; callbackOrigin?: string | null; instance?: string }): Promise<{ authorizationUrl: string; expiresIn: number }>;
    disconnect(): Promise<{ removed: boolean }>;
    activate(accountId: string): Promise<TrackerAuthStatus | null>;
    connectToken?(input: { instance?: string; token: string; username?: string }): Promise<TrackerAccountsView>;
    setOAuthClient?(input: { instance?: string; clientId: string; clientSecret?: string }): Promise<TrackerAccountsView>;
    completeAuthorization?(input: { code: string; state: string; error: string; errorDescription: string }): Promise<TrackerAccountsView>;
  };
  list(options: TrackerListOptions): Promise<Connected<{ items: TrackerItemSummary[]; cursor: string | null; hasMore: boolean }>>;
  get(id: string): Promise<Connected<{ item: TrackerItem | null }>>;
  states(containerId: string): Promise<Connected<{ states: TrackerWorkflowState[] }>>;
  updateState(input: { id: string; stateId: string }): Promise<Connected<{ item: TrackerItem | null }>>;
  liveSummaries(identifiers: string[]): Promise<Connected<{ items: TrackerLiveSummaryWire[] }>>;
  matchUrl(url: string): string | null;
  mapping?: {
    get(): Promise<Connected<TrackerMappingView>>;
    set(input: TrackerMappingInput): Promise<Connected<TrackerMappingView>>;
  };
  preferences?: {
    get(): Promise<TrackerPreferences>;
    set(input: TrackerPreferences): Promise<TrackerPreferences>;
  };
  sessionStatus?: {
    post(input: TrackerSessionStatusInput): Promise<TrackerSessionStatusResult>;
    createRuntime(): TrackerSessionStatusRuntime;
  };
  hostAccess?: {
    apiOrigin: string;
    account(): Promise<{ connected: boolean; label: string }>;
    accessToken(): Promise<string | null>;
    start(): Promise<{ authorizationUrl: string; expiresIn: number }>;
    disconnect(): Promise<void>;
  };
}

export type TrackerEntry = {
  descriptor: TrackerDescriptor;
  load(): Promise<TrackerImplementation>;
};

export interface TrackerRegistry {
  has(id: string): boolean;
  descriptor(id: string): TrackerDescriptor | null;
  descriptors(): TrackerDescriptor[];
  list(): TrackerProviderId[];
  implementation(id: string): Promise<TrackerImplementation | null>;
}
