/**
 * The work-item tracker contract, as the server's tracker registry serves it
 * (`packages/web/server/lib/trackers/tracker-contract.d.ts` holds the same
 * shapes). Every tracker (Linear today) answers in these neutral shapes; what
 * is the provider's own stays in its server module.
 */

/** Open id, `^[a-z][a-z0-9-]{0,31}$`, in the namespace tracker and source-control ids share. */
export type TrackerProviderId = string;
export type TrackerStateCategory = 'triage' | 'backlog' | 'todo' | 'in-progress' | 'done' | 'canceled';
export type TrackerPriority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

export type TrackerPerson = { name: string | null; avatarUrl: string | null };

export type TrackerItemState = { id: string | null; name: string; category: TrackerStateCategory | null };

export type TrackerContainer = { id: string; key: string | null; name: string };

export type TrackerLabel = { id: string; name: string; color: string | null };

/** Only the first few children are counted; `more` says there are others. */
export type TrackerProgress = { total: number; done: number; more: boolean };

export type TrackerItemSummary = {
  provider: TrackerProviderId;
  /** The provider's stable id (Linear UUID); what get and update take. */
  id: string;
  /** Human key, case-insensitive (ENG-12); the identity everywhere else. */
  identifier: string;
  title: string;
  url: string;
  state: TrackerItemState | null;
  priority?: TrackerPriority | null;
  /** Absent on a related item (a parent, a child): the provider is not asked for them there. */
  labels?: TrackerLabel[];
  assignee?: TrackerPerson | null;
  /** Linear: the team. */
  container?: TrackerContainer | null;
  parent?: TrackerItemSummary | null;
  progress?: TrackerProgress | null;
  updatedAt?: string | null;
};

export type TrackerComment = { id: string; body: string; createdAt: string | null; author: TrackerPerson | null };

export type TrackerItem = TrackerItemSummary & {
  description?: string | null;
  comments?: TrackerComment[];
  /** In the provider's order; the first page only, `childrenMore` says there are others. */
  children?: TrackerItemSummary[];
  childrenMore?: boolean;
};

/** Live state of a linked work item, refreshed in batches for list surfaces. */
export type TrackerLiveSummary = { identifier: string; title: string; state: { name: string; category: TrackerStateCategory } };

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
  /** One container's items (a Linear team); every container's when absent. */
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

export type TrackerAuthOrigin = 'desktop' | 'web';
export type TrackerAuthStart = { authorizationUrl: string; expiresIn: number };

type Connected<T> = { connected: false } | ({ connected: true } & T);

export type TrackerListResult = Connected<{ items: TrackerItemSummary[]; cursor: string | null; hasMore: boolean }>;
export type TrackerItemResult = Connected<{ item: TrackerItem | null }>;
export type TrackerStatesResult = Connected<{ states: TrackerWorkflowState[] }>;
export type TrackerStateUpdateInput = { id: string; stateId: string };

export type TrackerAuthMethod = 'oauth' | 'token';

/**
 * Plain JSON, as `GET /api/tracker/providers` answers. No icon and no
 * translated text: the UI adds those per id (`presentation.ts`).
 */
export type TrackerDescriptor = {
  id: TrackerProviderId;
  /** Product name, shown untranslated. */
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

export type TrackerContainerMapping = TrackerContainer & { projectPath: string | null };
export type TrackerMappingResult = Connected<{ defaultProjectPath: string | null; containers: TrackerContainerMapping[] }>;
export type TrackerMappingWrite = { defaultProjectPath: string | null; containerProjectPaths: { [containerId: string]: string } };

export type TrackerPreferences = {
  /** Status comments are off until the user opts in. */
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

/**
 * Work-item trackers the connected server serves. Every call names the
 * tracker; an action a tracker's capabilities leave out rejects.
 */
export interface TrackerAPI {
  /** The server's trackers; Linear on a server that predates the route. Rejects on failure, never answers empty for it. */
  providers(): Promise<TrackerDescriptor[]>;
  authStatus(provider: TrackerProviderId): Promise<TrackerAuthStatus>;
  authStart(provider: TrackerProviderId, origin?: TrackerAuthOrigin): Promise<TrackerAuthStart>;
  authDisconnect(provider: TrackerProviderId): Promise<{ removed: boolean }>;
  authActivate(provider: TrackerProviderId, accountId: string): Promise<TrackerAuthStatus>;
  list(provider: TrackerProviderId, options?: TrackerListOptions): Promise<TrackerListResult>;
  /** Forgets the server's short-lived lists of this tracker, so the next list read asks it: the board's list refresh. */
  refreshListReads(provider: TrackerProviderId): Promise<void>;
  get(provider: TrackerProviderId, id: string): Promise<TrackerItemResult>;
  states(provider: TrackerProviderId, containerId: string): Promise<TrackerStatesResult>;
  updateState(provider: TrackerProviderId, input: TrackerStateUpdateInput): Promise<TrackerItemResult>;
  mappingGet(provider: TrackerProviderId): Promise<TrackerMappingResult>;
  mappingSet(provider: TrackerProviderId, mapping: TrackerMappingWrite): Promise<TrackerMappingResult>;
  sessionStatusPost(provider: TrackerProviderId, input: TrackerSessionStatusPostInput): Promise<TrackerSessionStatusPostResult>;
  preferencesGet(provider: TrackerProviderId): Promise<TrackerPreferences>;
  preferencesSet(provider: TrackerProviderId, preferences: TrackerPreferences): Promise<TrackerPreferences>;
}
