
export type ProviderId = string;

export type ChangeRequestTerm = 'pullRequest' | 'mergeRequest' | 'change';
type CiTerm = 'checks' | 'pipeline';
export type SettingsFieldKind = 'instance-url' | 'personal-access-token' | 'username' | 'http-password';
export type MergeMethod = 'merge' | 'squash' | 'rebase' | 'submit';
export type ReviewModel = 'verdict' | 'votes';

export interface ProviderCapabilities {
  projects: boolean;
  issues: boolean;
  changeRequests: boolean;
  draftChangeRequests: boolean;
  draftConversion?: boolean;
  merge: false | { methods: MergeMethod[] };
  ci: boolean;
  comments: boolean;
  commentEdit?: boolean;
  reviews: boolean;
  state: boolean;
  labels: boolean;
  reviewers: boolean;
  reviewThreads: { start: boolean; reply: boolean; resolve: boolean };
  reviewDrafts?: { fileComments: boolean };
  uploads: boolean;
  stacks: boolean;
  changeRequestPatch: boolean;
  liveSummaries: boolean;
  referencePicker: boolean;
  multipleAccounts: boolean;
  reviewModel?: ReviewModel;
  revisions?: boolean;
  createVia?: 'api' | 'push';
  discussions?: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  terminology: { changeRequest: ChangeRequestTerm; ci: CiTerm };
  referencePrefix: { changeRequest: string; issue: string };
  iconId: string;
  instance: {
    form: 'host' | 'origin';
    defaultInstances: string[];
    normalize(raw: string): string;
    origin(instance: string): URL;
  };
  repositoryPath: 'owner/name' | 'namespace/name' | 'path';
  projectPathOfRemote?(remote: { protocol: 'https' | 'http' | 'ssh'; path: string }): string;
  capabilities: ProviderCapabilities;
  authMethods: { device: boolean; pat: boolean; cli: false | { tool: string } | { kind: 'service'; hint: string } };
  transport: {
    httpsUsername: { kind: 'fixed'; value: string } | { kind: 'login' };
    managedHttpsInstances: 'default-only' | 'any';
    appendDotGitToHttpsClone: boolean;
  };
  urls: { thread: { hosts: string[] | 'any'; pattern: RegExp } };
  trackedItems: { nestedOwners: boolean; defaultInstance: string | null; batchLimit: number };
  limits: { commentMaxLength: number; reviewerId: RegExp; labelsMax: number; reviewersMax: number };
  identity: { noReplyEmail: ((user: { id: number; login: string }) => string | null) | null };
  settings: Array<{ key: string; type: SettingsFieldKind; secret: boolean; scope: 'global' | 'instance' }>;
  instances: { legacyFlow: { instance: string; kind: 'github-com-device' } | null };
  presentation: {
    sharedNumberSpace: boolean;
    abbreviation: string;
    promptNoun: string;
    icon: { sprite?: string; filledSprite?: string; path?: string };
    instances: { multiple: boolean; allowLoopbackHttp: boolean; allowPort: boolean; reserved: string[]; placeholder: string };
    cliTransport: boolean;
    token?: { scopes: string[]; createPath?: string };
    urls: { changeRequest: string[]; issue: string[]; discussion?: string[]; commit?: string[]; user?: string[] };
    features: {
      referenceSearch: boolean; referenceDetail: boolean; listStatuses: boolean; referencesAcross: boolean;
      startThread: boolean; authorCanReview: boolean; projectUploads: boolean; issueCloseReason: boolean;
      reviewDrafts?: boolean; reviewDraftFileComments?: boolean;
      changeRequestTemplates: string[];
      branchHeads?: boolean;
      submitRequirements?: boolean;
      advancedSearch?: boolean;
      commentEdit?: boolean;
    };
  };
  routeAliases?: {
    authAliasPrefix: string;
    retiredGet: string[];
    retiredPost: string[];
    extraAuthAliases: Record<string, string>;
  };
  extension?: {
    guestId: string;
    name: string;
    version: string;
    token?: { header: 'authorization' | 'private-token'; scheme: 'bearer' | 'token' | 'basic' | 'none' };
  };
}

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
    login?: { kind: 'service'; hint: string };
    cliTransport: boolean;
    token?: { scopes: string[]; createPath?: string };
  };
  settings: { fields: Array<{ id: string; kind: SettingsFieldKind; secret: boolean }> };
  urls: { changeRequest: string[]; issue: string[]; discussion?: string[]; commit?: string[]; user?: string[] };
  features: ProviderDescriptor['presentation']['features'] & {
    reviewModel?: ReviewModel;
    revisions?: boolean;
    createByPush?: boolean;
    discussions?: boolean;
  };
  extension?: { guestId: string; name: string; version: string };
}

export interface AccountIdentity { provider: ProviderId; instance: string; accountId: string }

export interface ProviderSession {
  instance: string;
  accountId: string;
  credentialRevision: number | null;
  providerUserId: string;
  secretKind: 'oauth' | 'pat' | 'cli';
  persisted: boolean;
}

export interface TransportCredential {
  credentialId: string;
  credentialRevision: number;
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

export interface AccountEvents {
  connected(payload: ConnectedAccount & { renews: AccountIdentity[] }): Promise<void>;
  invalidated(identity: AccountIdentity): Promise<void>;
  removed(identity: AccountIdentity): Promise<void>;
  subscribe(listener: Partial<Omit<AccountEvents, 'subscribe'>>): () => void;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ReadInput = { session: ProviderSession; context: Json; directory: string; remote: string };
type ProjectSelector = { owner: string; name: string };

export interface ProviderImplementation {
  descriptor: ProviderDescriptor;
  classifyFailure?(error: Error): string;
  auth: {
    capabilities?(input: { instance: string }): Promise<{ authentication: boolean; authenticationMethods: Json }>;
    status?(input: { instance: string }): Promise<Json>;
    accounts?(input: { instance: string }): Promise<Json[]>;
    startDeviceFlow?(input: { instance: string }): Promise<{
      flow: { deviceCode: string; clientId: string; expiresIn: number };
      result: { userCode: string; verificationUri: string; expiresIn: number; interval: number; verificationUriComplete?: string };
    }>;
    completeDeviceFlow?(input: { instance: string; deviceCode: string; clientId: string }, control: { consume(): void }): Promise<{ pending: boolean; body: Json }>;
    connectToken?(input: { instance: string; token: string; username?: string }): Promise<Json>;
    activate?(input: { instance: string; accountId: string }): Promise<Json>;
    setCliDisabled?(input: { instance: string; disabled: boolean }): Promise<{ available: boolean; disabled: boolean }>;
    remove?(input: { instance: string; accountId: string }): Promise<{ removed: boolean }>;
    resolveAccount?(input: { instance: string; accountId?: string; orCurrent?: boolean }): Promise<ProviderSession>;
    refreshOAuthToken?(input: { instance: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>;
    invalidateAccount?(input: { instance: string; accountId: string; persisted?: boolean; renew?: boolean }): Promise<boolean>;
    readCurrentAccountId(input: { instance: string }): Promise<string | null>;
    listInstances(): Promise<string[]>;
    readSshUrl?(input: { instance: string }): Promise<string | null>;
    listSshHosts?(): Promise<Array<{ instance: string; sshUrl: string }>>;
    setSshUrl?(input: { instance: string; sshUrl: string | null }): Promise<{ sshUrl: string | null }>;
    listConnectedAccounts(): Promise<ConnectedAccount[]>;
    ownsHost(input: {
      host: string;
      port?: number;
      sshPort?: number;
      knownInstances: string[];
      knownSshHosts?: Array<{ instance: string; sshUrl: string }>;
    }): string | null;
  };
  transport: {
    readCredential(input: { instance: string; credentialId: string; credentialRevision?: number }): Promise<TransportCredential | null>;
  };
  resources: {
    changeRequestStatus?(input: ReadInput & { branch: string; force: boolean }): Promise<Json>;
    listChangeRequests?(input: ReadInput & { page: number; query?: string; state: string; people: string; labels?: string[] }): Promise<Json>;
    changeRequestContext?(input: ReadInput & {
      number: number; project?: ProjectSelector; includeDiff: boolean; includeCIDetails: boolean; includeTimeline: boolean;
      revision?: string;
    }): Promise<Json>;
    listIssues?(input: ReadInput & { page: number; query?: string; state: string; people: string; labels?: string[] }): Promise<Json>;
    getIssue?(input: ReadInput & { number: number; project?: ProjectSelector }): Promise<Json>;
    issueComments?(input: ReadInput & { number: number; project?: ProjectSelector }): Promise<Json>;
    projectUpstream?(input: ReadInput): Promise<Json>;
    projectBranches?(input: ReadInput & { project: ProjectSelector }): Promise<Json>;
    listLabels?(input: ReadInput & { project: ProjectSelector }): Promise<Json>;
    listReviewerCandidates?(input: ReadInput & { project: ProjectSelector }): Promise<Json>;
    readUpload?(input: ReadInput & { project: ProjectSelector; secret: string; filename: string; range?: string; signal: AbortSignal }): Promise<Response>;
    readChangeRequestPatch?(input: ReadInput & { number: number; sourceRepo?: { owner: string; repo: string }; revision?: string }): Promise<Json>;
    readChangeRequestFile?(input: ReadInput & {
      number: number; sourceRepo?: { owner: string; repo: string }; path: string; previousPath?: string; status?: string; revision?: string;
      binary?: boolean;
    }): Promise<Json>;
    liveSummaries?(input: { session: ProviderSession; refs: Json[]; issueRefs: Json[]; discussionRefs: Json[] }): Promise<Json>;
    readChangeRequestHead?(input: ReadInput & { number: number }): Promise<{
      project: { id: string; owner: string; name: string }; headSha: string; headBranch: string; headOwner: string;
    }>;
    resolveChangeRequestSource?(input: ReadInput & {
      project: { id: string; owner: string; name: string }; number: number;
      expectedHeadSha: string; requestedRemoteName: string;
    }): Promise<Json>;
    references?(input: ReadInput & { kind: 'issue' | 'pull' | 'discussion'; state: string; people: string; query: string; cursor: string | null }): Promise<Json>;
    referencesAcross?(input: { body: Json; validateReadContext(context: Json): Promise<Json> }): Promise<Json>;
    referenceDetail?(input: ReadInput & { project: ProjectSelector; number: number; host: string; kind: 'item' | 'discussion' }): Promise<Json>;
    reviewState?(input: ReadInput & { project: ProjectSelector; number: number }): Promise<Json>;
    referenceStatuses?(input: Omit<ReadInput, 'session'> & { pulls: string }): Promise<Json>;
  };
  mutations?: {
    routes: string[];
    prepare(input: { route: string; input: Json; context: Json; actor: AccountIdentity; credential: { accountId: string; credentialRevision: number } }): {
      kind: string; input: Json; digest(target: Json): string;
    };
    resolveTarget(input: { session: ProviderSession; context: Json; kind: string; input: Json; replayOf?: Json }): Promise<{ providerTarget: Json; target: Json }>;
    perform(input: { session: ProviderSession; route: string; kind: string; input: Json; resolved: { providerTarget: Json; target: Json } }): Promise<Json>;
    reconcile(input: { session: ProviderSession; route: string; kind: string; input: Json; resolved: { providerTarget: Json; target: Json } }): Promise<{ state: string; result?: Json }>;
    afterSuccess?(input: { session: ProviderSession; target: Json }): Promise<void>;
    classifyError?(error: Error): 'failed' | 'outcome-unknown';
    presentError?(error: Error): { status: number; body: Json };
  };
}

export type VerifyToken = (origin: string, token: string, credentials?: { username: string }) => Promise<TransportCredential['user']>;
export type ProbeInstance = (origin: string, token?: string, credentials?: { username: string }) => Promise<{ supported: boolean; version?: string; message?: string }>;


export interface ChangeRequestVoteLabel {
  name: string;
  values: Array<{ value: number; description: string }>;
  defaultValue: number;
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

export interface ChangeRequestRevision {
  number: number;
  sha: string;
  createdAt: string;
  uploader?: Json;
  kind?: 'rework' | 'trivial-rebase' | 'merge-first-parent-update' | 'no-code-change' | 'no-change';
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
  revisionNumber?: number;
}

export interface ChangeRequestStatusExtensions {
  localRevision?: { sha: string; changeId: string | null; uploadedAs: number | null };
  stack?: Json;
}
