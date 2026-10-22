// The tracker contract shared by the server's tracker registry and the shared
// UI. Server JS is not type-checked, so it mirrors these in JSDoc; the UI's
// `lib/trackers/types.ts` imports or re-declares exactly these shapes.

/** Open id, `^[a-z][a-z0-9-]{0,31}$`. Never a source-control id or a reserved id (`guest`, `link`, `external`, `repository`). */
export type TrackerProviderId = string;
export type TrackerStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type TrackerPerson = { name: string | null; avatarUrl: string | null };

export type TrackerItemSummary = {
  provider: TrackerProviderId;
  /** The provider's stable id (Linear UUID); what get/update take. */
  id: string;
  /** Human key, case-insensitive (ENG-12); the identity everywhere else. */
  identifier: string;
  title: string;
  url: string;
  state: { id: string | null; name: string; category: TrackerStateCategory | null } | null;
  priority?: TrackerPriority | null;
  /** Absent means the provider was not asked (a related item). */
  labels?: { id: string; name: string; color: string | null }[];
  assignee?: TrackerPerson | null;
  /** Linear: the team. */
  container?: { id: string; key: string | null; name: string } | null;
  parent?: TrackerItemSummary | null;
  /** Linear: subIssueProgress. Only the first few are counted; `more` says there are others. */
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

/**
 * What the server's `liveSummaries` answers during the alias window: the
 * neutral summary plus the provider's raw `state.type`, which older bundled
 * phone UIs still read. Newer client schemas strip it.
 */
export type TrackerLiveSummaryWire = TrackerLiveSummary & { state: TrackerLiveSummary['state'] & { type?: string } };

export type TrackerWorkflowState = { id: string; name: string; category: TrackerStateCategory | null; position: number };

export type TrackerPeopleFilter = 'any' | 'me' | 'created';
export type TrackerPriorityFilter = 'all' | TrackerPriority;

export type TrackerListOptions = {
  query?: string;
  cursor?: string;
  /** One of the descriptor's `stateFilters`; omitted means `open`. */
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
};

export type TrackerAuthStatus =
  | { connected: false }
  | { connected: true; account?: TrackerAccount | null; accounts?: TrackerAccount[] };

export type Connected<T> = { connected: false } | ({ connected: true } & T);

export type TrackerAuthMethod = 'oauth' | 'token';

/** Plain JSON. `GET /api/tracker/providers` answers `{ providers: TrackerDescriptor[] }`. */
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
    /** Container to OpenChamber project mapping (Linear: team). */
    projectMapping: boolean;
    /** Started/completed/failure comments on the item. */
    sessionComments: boolean;
    /** An SDK guest may borrow the token. */
    hostAccess: boolean;
  };
  /** In menu order: `open`, `all`, categories, then provider extras (`inReview`, `duplicate`). */
  stateFilters: string[];
  /** `host` compared to the URL host without `www.`; `path` is a regex source tested on the pathname, group 1 = identifier. */
  urlPatterns: { host: string; path: string }[];
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

/** An OpenCode event as the server's event hub forwards it; the runtime reads only these fields. */
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

/** Server-side implementation a registry entry loads. JSON in, JSON out. */
export interface TrackerImplementation {
  auth: {
    status(): Promise<TrackerAuthStatus>;
    start(input?: { origin?: 'desktop' | 'web' }): Promise<{ authorizationUrl: string; expiresIn: number }>;
    disconnect(): Promise<{ removed: boolean }>;
    /** Null when the account is not stored. */
    activate(accountId: string): Promise<TrackerAuthStatus | null>;
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
  /** Null for an unknown id. */
  descriptor(id: string): TrackerDescriptor | null;
  /** Registration order. */
  descriptors(): TrackerDescriptor[];
  list(): TrackerProviderId[];
  /** Loaded once and cached; null for an unknown id. */
  implementation(id: string): Promise<TrackerImplementation | null>;
}
