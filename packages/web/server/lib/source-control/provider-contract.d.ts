/**
 * The source-control provider contract: static descriptors, the JSON-in /
 * JSON-out implementation the route shell drives, and the descriptor the
 * server publishes to clients. Types only; the server modules are JavaScript.
 */

/** `^[a-z][a-z0-9-]{0,31}$`, persisted verbatim; `github` and `gitlab` are never renamed; `ext-` names an extension's provider. */
export type ProviderId = string;

/** `change`: a host that reviews one commit at a time (Gerrit); its reviews are votes, its merge is submit. */
export type ChangeRequestTerm = 'pullRequest' | 'mergeRequest' | 'change';
/** What a provider calls the automation on a change request; English model-facing text picks its noun by it. */
type CiTerm = 'checks' | 'pipeline';
/** `username` is not secret; `http-password` is the secret a Basic-auth host pairs with it. */
export type SettingsFieldKind = 'instance-url' | 'personal-access-token' | 'username' | 'http-password';
/** `submit` merges the way the host's project is set up; when present it is the only method. */
export type MergeMethod = 'merge' | 'squash' | 'rebase' | 'submit';
/** `verdict`: approve / request changes. `votes`: integer votes on labels the change's context lists. */
export type ReviewModel = 'verdict' | 'votes';

export interface ProviderCapabilities {
  projects: boolean;
  issues: boolean;
  changeRequests: boolean;
  draftChangeRequests: boolean;
  merge: false | { methods: MergeMethod[] };
  ci: boolean;
  comments: boolean;
  reviews: boolean;
  state: boolean;
  labels: boolean;
  reviewers: boolean;
  reviewThreads: { start: boolean; reply: boolean; resolve: boolean };
  uploads: boolean;
  stacks: boolean;
  changeRequestPatch: boolean;
  liveSummaries: boolean;
  referencePicker: boolean;
  multipleAccounts: boolean;
  /** Absent means `verdict`: `/pr/review` takes `{ verdict, body? }`. `votes` takes `{ votes, body? }` instead. */
  reviewModel?: ReviewModel;
  /** The host keeps every uploaded revision of a change; reads may name one by its 40-hex SHA. */
  revisions?: boolean;
  /** Absent means `api` (`/pr/create`). `push`: a change is created by pushing to `refs/for/<branch>`. */
  createVia?: 'api' | 'push';
}

/** Synchronous and SDK-free: the Git layer, bindings and tracked items read it directly. */
export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  terminology: { changeRequest: ChangeRequestTerm; ci: CiTerm };
  referencePrefix: { changeRequest: string; issue: string };
  iconId: string;
  instance: {
    /** `host`: a bare lowercase hostname (github.com). `origin`: a normalized origin (https://gitlab.com). */
    form: 'host' | 'origin';
    defaultInstances: string[];
    /** The canonical spelling; throws a readable error for anything else. */
    normalize(raw: string): string;
    /** The HTTPS (or loopback HTTP) origin of a normalized instance. */
    origin(instance: string): URL;
  };
  /**
   * `path`: projects are any path, with or without an owner segment (Gerrit's
   * `demo`, `team/app/sub`). A selector keeps `{ owner, name }`, split on the
   * last slash (`project-path.js`), and `owner` may be the empty string.
   */
  repositoryPath: 'owner/name' | 'namespace/name' | 'path';
  /**
   * The project path a remote's URL path names, when the host adds to it (a
   * Gerrit HTTP remote may carry its `/a/` authentication prefix). Without
   * it the path is the URL path less a trailing `.git`.
   */
  projectPathOfRemote?(remote: { protocol: 'https' | 'http' | 'ssh'; path: string }): string;
  capabilities: ProviderCapabilities;
  authMethods: { device: boolean; pat: boolean; cli: false | { tool: string } };
  transport: {
    httpsUsername: { kind: 'fixed'; value: string } | { kind: 'login' };
    /** `default-only`: managed Git transport reaches the default instances only. */
    managedHttpsInstances: 'default-only' | 'any';
    appendDotGitToHttpsClone: boolean;
  };
  urls: { thread: { hosts: string[] | 'any'; pattern: RegExp } };
  trackedItems: { nestedOwners: boolean; defaultInstance: string | null; batchLimit: number };
  limits: { commentMaxLength: number; reviewerId: RegExp; labelsMax: number; reviewersMax: number };
  identity: { noReplyEmail: ((user: { id: number; login: string }) => string | null) | null };
  settings: Array<{ key: string; type: SettingsFieldKind; secret: boolean; scope: 'global' | 'instance' }>;
  instances: { legacyFlow: { instance: string; kind: 'github-com-device' } | null };
  /** What only the client draws; published, never used by the server. */
  presentation: {
    sharedNumberSpace: boolean;
    abbreviation: string;
    promptNoun: string;
    icon: { sprite?: string; filledSprite?: string; path?: string };
    instances: { multiple: boolean; allowLoopbackHttp: boolean; allowPort: boolean; reserved: string[]; placeholder: string };
    cliTransport: boolean;
    token?: { scopes: string[]; createPath?: string };
    urls: { changeRequest: string[]; issue: string[] };
    features: {
      referenceSearch: boolean; referenceDetail: boolean; listStatuses: boolean; referencesAcross: boolean;
      startThread: boolean; authorCanReview: boolean; projectUploads: boolean; issueCloseReason: boolean;
      changeRequestTemplates: string[];
      /** False when a change request's head is a revision ref, not a branch (no stack-on-top, no branch row). Absent means true. */
      branchHeads?: boolean;
      /** The context carries `submitRequirements`, and `mergeable` follows them. */
      submitRequirements?: boolean;
    };
  };
  /** GitHub only, declarative: the `/api/github` aliases its routes keep. */
  routeAliases?: {
    authAliasPrefix: string;
    retiredGet: string[];
    retiredPost: string[];
    extraAuthAliases: Record<string, string>;
  };
  /**
   * Extension providers only (`ext-<guestId>`, `extension-descriptor.js`): the
   * guest that serves it and how the outbound proxy sends its token.
   * Server-only; clients see `PublicProviderDescriptor.extension`.
   */
  extension?: {
    guestId: string;
    name: string;
    version: string;
    token: { header: 'authorization' | 'private-token'; scheme: 'bearer' | 'token' | 'none' };
  };
}

/** `GET /api/source-control/providers` → `{ providers: PublicProviderDescriptor[] }`. */
export interface PublicProviderDescriptor {
  id: ProviderId;
  label: string;
  order: number;
  terminology: {
    changeRequest: ChangeRequestTerm;
    changeRequestPrefix: string;
    issuePrefix: string;
    sharedNumberSpace: boolean;
    abbreviation: string;
    promptNoun: string;
    ci: CiTerm;
  };
  icon: { sprite?: string; filledSprite?: string; path?: string };
  /** `pathStyle: 'path'` only for a `repositoryPath: 'path'` provider (absent otherwise, so built-ins publish as before). */
  repository: { nestedNamespaces: boolean; pathStyle?: 'path' };
  instances: {
    format: 'host' | 'origin';
    defaultInstance: string | null;
    multiple: boolean;
    allowLoopbackHttp: boolean;
    allowPort: boolean;
    reserved: string[];
    placeholder: string;
    legacyFlow?: { instance: string; kind: 'github-com-device' };
  };
  auth: {
    methods: Array<'device' | 'pat' | 'cli'>;
    cliName?: string;
    cliTransport: boolean;
    token?: { scopes: string[]; createPath?: string };
  };
  settings: { fields: Array<{ id: string; kind: SettingsFieldKind; secret: boolean }> };
  urls: { changeRequest: string[]; issue: string[] };
  /**
   * The presentation features, plus the capability-derived ones a change
   * host declares (`reviewModel`, `revisions`, `createByPush`).
   * Each is published only when declared, so a host that declares none
   * publishes exactly what it did before.
   */
  features: ProviderDescriptor['presentation']['features'] & {
    /** `capabilities.reviewModel`. */
    reviewModel?: ReviewModel;
    /** `capabilities.revisions`. */
    revisions?: boolean;
    /** `capabilities.createVia === 'push'`. */
    createByPush?: boolean;
  };
  /** Present when an installed extension serves the provider. */
  extension?: { guestId: string; name: string; version: string };
}

export interface AccountIdentity { provider: ProviderId; instance: string; accountId: string }

/**
 * The exact account a request acts as, frozen. Its secret is not a field: the
 * provider keeps it (or the client built from it) in a module `WeakMap` keyed
 * by this object, so logging or serializing a session never carries a token.
 */
export interface ProviderSession {
  instance: string;
  accountId: string;
  credentialRevision: number | null;
  providerUserId: string;
  secretKind: 'oauth' | 'pat' | 'cli';
  /** False for a CLI login: there is no stored record to mark invalid. */
  persisted: boolean;
}

/** What Git transport and bindings read for an exact credential reference. */
export interface TransportCredential {
  credentialId: string;
  credentialRevision: number;
  /** `<instance>#<numeric user id>` on every provider. */
  providerUserId: string;
  status: 'valid' | 'invalid';
  source: 'oauth' | 'pat' | 'cli';
  user: { id: number; login?: string; username?: string; name?: string; email?: string; avatarUrl?: string };
  secret: string;
}

export interface ConnectedAccount {
  account: AccountIdentity;
  user: TransportCredential['user'];
  credential: { credentialRevision: number; providerUserId: string };
}

/** Lifecycle reports a provider makes; listeners run in order and are awaited. */
export interface AccountEvents {
  connected(payload: ConnectedAccount & { renews: AccountIdentity[] }): Promise<void>;
  invalidated(identity: AccountIdentity): Promise<void>;
  removed(identity: AccountIdentity): Promise<void>;
  subscribe(listener: Partial<Omit<AccountEvents, 'subscribe'>>): () => void;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** `context` is the validated read context the shell checked before resolving the account. */
type ReadInput = { session: ProviderSession; context: Json; directory: string; remote: string };
type ProjectSelector = { owner: string; name: string };

/**
 * An answer the shell sends as is: errors may carry `sourceControlResponse:
 * { status, body }`. Other errors carry the provider's HTTP status (`status`,
 * or the SDK's `response.status`) and `sourceControlIdentity` /
 * `sourceControlPersistedAccount` for the shell's 401 handling.
 */
export interface ProviderImplementation {
  descriptor: ProviderDescriptor;
  /** `unreachable`, `temporarily-unavailable`, `invalid-token`, `provider-error`, ... */
  classifyFailure?(error: Error): string;
  auth: {
    capabilities?(input: { instance: string }): Promise<{ authentication: boolean; authenticationMethods: Json }>;
    status?(input: { instance: string }): Promise<Json>;
    accounts?(input: { instance: string }): Promise<Json[]>;
    startDeviceFlow?(input: { instance: string }): Promise<{
      flow: { deviceCode: string; clientId: string; expiresIn: number };
      result: { userCode: string; verificationUri: string; expiresIn: number; interval: number; verificationUriComplete?: string };
    }>;
    /** Calls `consume()` once the flow reached a terminal answer. */
    completeDeviceFlow?(input: { instance: string; deviceCode: string; clientId: string }, control: { consume(): void }): Promise<{ pending: boolean; body: Json }>;
    /** `username` only for a provider whose settings declare a `username` field (Basic auth). */
    connectToken?(input: { instance: string; token: string; username?: string }): Promise<Json>;
    activate?(input: { instance: string; accountId: string }): Promise<Json>;
    setCliDisabled?(input: { instance: string; disabled: boolean }): Promise<{ available: boolean; disabled: boolean }>;
    /** Reports `removed` before the provider changes its store. */
    remove?(input: { instance: string; accountId: string }): Promise<{ removed: boolean }>;
    /**
     * The exact account, or the instance's current one when `accountId` is
     * empty. With `orCurrent` (live summaries only) a provider may answer
     * with the current account when the named one no longer resolves.
     */
    resolveAccount?(input: { instance: string; accountId?: string; orCurrent?: boolean }): Promise<ProviderSession>;
    /** Trades an OAuth refresh token; the auth store calls it before a stored token lapses. */
    refreshOAuthToken?(input: { instance: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>;
    /** Renews when it can; otherwise reports `invalidated`, then marks the stored account invalid. True when renewed. */
    invalidateAccount?(input: { instance: string; accountId: string; persisted?: boolean; renew?: boolean }): Promise<boolean>;
    readCurrentAccountId(input: { instance: string }): Promise<string | null>;
    listInstances(): Promise<string[]>;
    listConnectedAccounts(): Promise<ConnectedAccount[]>;
    /** `port` is the remote's web port when the remote is an HTTP(S) URL; absent for an SSH remote. */
    ownsHost(input: { host: string; port?: number; knownInstances: string[] }): string | null;
  };
  transport: {
    readCredential(input: { instance: string; credentialId: string; credentialRevision?: number }): Promise<TransportCredential | null>;
  };
  resources: {
    /** `force` asks past the provider's own short-lived caches. */
    changeRequestStatus?(input: ReadInput & { branch: string; force: boolean }): Promise<Json>;
    listChangeRequests?(input: ReadInput & { page: number; query?: string; state: string; people: string }): Promise<Json>;
    changeRequestContext?(input: ReadInput & {
      number: number; project?: ProjectSelector; includeDiff: boolean; includeCIDetails: boolean; includeTimeline: boolean;
      /** Only with `capabilities.revisions`: files and diff of that revision (40-hex). */
      revision?: string;
    }): Promise<Json>;
    listIssues?(input: ReadInput & { page: number; query?: string; state: string; people: string }): Promise<Json>;
    getIssue?(input: ReadInput & { number: number; project?: ProjectSelector }): Promise<Json>;
    issueComments?(input: ReadInput & { number: number; project?: ProjectSelector }): Promise<Json>;
    projectUpstream?(input: ReadInput): Promise<Json>;
    projectBranches?(input: ReadInput & { project: ProjectSelector }): Promise<Json>;
    listLabels?(input: ReadInput & { project: ProjectSelector }): Promise<Json>;
    listReviewerCandidates?(input: ReadInput & { project: ProjectSelector }): Promise<Json>;
    /** The attachment as the provider's fetch Response; the shell checks its type and streams it. */
    readUpload?(input: ReadInput & { project: ProjectSelector; secret: string; filename: string; range?: string; signal: AbortSignal }): Promise<Response>;
    /** `revision` (40-hex) only when the descriptor declares `capabilities.revisions`; absent means the current one. */
    readChangeRequestPatch?(input: ReadInput & { number: number; sourceRepo?: { owner: string; repo: string }; revision?: string }): Promise<Json>;
    readChangeRequestFile?(input: ReadInput & {
      number: number; sourceRepo?: { owner: string; repo: string }; path: string; previousPath?: string; status?: string; revision?: string;
    }): Promise<Json>;
    liveSummaries?(input: { session: ProviderSession; refs: Json[]; issueRefs: Json[] }): Promise<Json>;
    readChangeRequestHead?(input: ReadInput & { number: number }): Promise<{
      project: { id: string; owner: string; name: string }; headSha: string; headBranch: string; headOwner: string;
    }>;
    resolveChangeRequestSource?(input: ReadInput & {
      project: { id: string; owner: string; name: string }; number: number;
      expectedHeadSha: string; requestedRemoteName: string;
    }): Promise<Json>;
    /** Capability `referencePicker`: one searched page of issues or change requests. */
    references?(input: ReadInput & { kind: 'issue' | 'pull'; state: string; people: string; query: string; cursor: string | null }): Promise<Json>;
    /** The same search across folders; each folder's context goes through `validateReadContext` and its own account. */
    referencesAcross?(input: { body: Json; validateReadContext(context: Json): Promise<Json> }): Promise<Json>;
    referenceDetail?(input: ReadInput & { project: ProjectSelector; number: number; host: string }): Promise<Json>;
    /** Statuses of listed change requests (`owner/repo#n[@host]`, comma separated); read with each host's account, so no session. */
    referenceStatuses?(input: Omit<ReadInput, 'session'> & { pulls: string }): Promise<Json>;
  };
  mutations?: {
    /** The shell route suffixes (`/pr/create`, ...) this provider performs. */
    routes: string[];
    /** Provider-owned kind and digest: persisted records replay only while both stay byte-identical. */
    prepare(input: { route: string; input: Json; context: Json; actor: AccountIdentity; credential: { accountId: string; credentialRevision: number } }): {
      kind: string; input: Json; digest(target: Json): string;
    };
    /** `replayOf` is the stored record when a durable key is retried. */
    resolveTarget(input: { session: ProviderSession; context: Json; kind: string; input: Json; replayOf?: Json }): Promise<{ providerTarget: Json; target: Json }>;
    perform(input: { session: ProviderSession; route: string; kind: string; input: Json; resolved: { providerTarget: Json; target: Json } }): Promise<Json>;
    reconcile(input: { session: ProviderSession; route: string; kind: string; input: Json; resolved: { providerTarget: Json; target: Json } }): Promise<{ state: string; result?: Json }>;
    /** Drops caches a succeeded (or replayed) mutation left stale; called after the record is durable, and a throw is ignored. */
    afterSuccess?(input: { session: ProviderSession; target: Json }): Promise<void>;
    /** `failed` (recorded, never retried) or `outcome-unknown`; without it the shell's rule: a provider 4xx is definite. */
    classifyError?(error: Error): 'failed' | 'outcome-unknown';
    /** How a failed mutation answers, after the shell wrote off a refused account; without it the shell's own mapping. */
    presentError?(error: Error): { status: number; body: Json };
  };
}

/**
 * Account verification for a provider built on `pat-account-auth.js`.
 * `credentials` is passed only when the descriptor declares a `username`
 * settings field (Basic auth): the username typed at connect, then the
 * stored `user.login` on every re-verify. Other providers get `(origin, token)`.
 */
export type VerifyToken = (origin: string, token: string, credentials?: { username: string }) => Promise<TransportCredential['user']>;
/** Without a token: whether the instance is supported. With one (Basic-auth hosts at connect): read as that user when anonymous reads are blocked. */
export type ProbeInstance = (origin: string, token?: string, credentials?: { username: string }) => Promise<{ supported: boolean; version?: string; message?: string }>;

/*
 * Optional DTO fields of change-based review hosts. The DTOs themselves are
 * `Json` here (the UI's `types.ts` owns their full shape); these name the
 * fields a host that declares the matching capability may add. Hosts that
 * declare none never send them.
 */

/** One label of a votes host's change (`ChangeRequestContext.voteLabels`). */
export interface ChangeRequestVoteLabel {
  name: string;
  values: Array<{ value: number; description: string }>;
  defaultValue: number;
  /** What the caller may vote on the current revision. */
  permitted: number[];
  blocking: boolean;
  status: 'approved' | 'rejected' | 'recommended' | 'disliked' | 'neutral';
  votes: Array<{ user: Json; value: number; revision?: number }>;
}

export interface ChangeRequestSubmitRequirement {
  name: string;
  status: 'satisfied' | 'unsatisfied' | 'overridden' | 'not-applicable' | 'error' | 'forced';
  description?: string;
}

/** One uploaded revision, oldest first (`ChangeRequestContext.revisions`). */
export interface ChangeRequestRevision {
  number: number;
  sha: string;
  createdAt: string;
  uploader?: Json;
  kind?: 'rework' | 'trivial-rebase' | 'merge-first-parent-update' | 'no-code-change' | 'no-change';
  /** The revision's fetchable ref (`refs/changes/NN/NNNN/P`). */
  ref: string;
}

export interface ChangeRequestContextExtensions {
  voteLabels?: ChangeRequestVoteLabel[];
  submitRequirements?: ChangeRequestSubmitRequirement[];
  revisions?: ChangeRequestRevision[];
}

export interface ChangeRequestExtensions {
  private?: boolean;
  topic?: string;
  /** The number of the revision `headSha` names. */
  revisionNumber?: number;
}

export interface ChangeRequestStatusExtensions {
  /**
   * Push-create hosts: the local tip's Change-Id and which uploaded revision
   * equals local HEAD (`uploadedAs: null` means local commits are not uploaded).
   */
  localRevision?: { sha: string; changeId: string | null; uploadedAs: number | null };
  /** Push-create hosts: open changes stacked on the branch, bottom first (`number: null`). */
  stack?: Json;
}
