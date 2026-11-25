
import type { ProviderId } from './provider-id.js';
import type { SourceControlChangeRequestSource, SourceControlJson, SourceControlJsonObject, SourceControlMutationTarget } from '@openchamber/sdk';
import type { MutationCompletionInput, MutationRecord } from './mutation-storage.js';
import type { BindingMutationTarget } from './binding-service-contracts.js';
import type { LiveSummariesResult, ThreadRef } from '../tracked-items/contracts.js';
export type { ProviderId } from './provider-id.js';

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
  merge: false | { methods: readonly MergeMethod[] };
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
    defaultInstances: readonly string[];
    normalize(raw: string | undefined): string;
    origin(instance: string): URL;
  };
  repositoryPath: 'owner/name' | 'namespace/name' | 'path';
  projectPathOfRemote?(remote: { protocol: string; path: string }): string;
  capabilities: ProviderCapabilities;
  authMethods: { device: boolean; pat: boolean; cli: false | { tool: string; kind?: never; hint?: never } | { kind: 'service'; hint: string; tool?: never } };
  transport: {
    httpsUsername: { kind: 'fixed'; value: string } | { kind: 'login' };
    managedHttpsInstances: 'default-only' | 'any';
    appendDotGitToHttpsClone: boolean;
  };
  urls: { thread: { hosts: readonly string[] | 'any'; pattern: RegExp } };
  trackedItems: { nestedOwners: boolean; defaultInstance: string | null; batchLimit: number };
  limits: { commentMaxLength: number; reviewerId: RegExp; labelsMax: number; reviewersMax: number };
  identity: { noReplyEmail: ((user: { id?: number | string | undefined; login: string }) => string | null) | null };
  settings: ReadonlyArray<{ key: string; type: SettingsFieldKind; secret: boolean; scope: 'global' | 'instance' }>;
  instances: { legacyFlow: { instance: string; kind: 'github-com-device' } | null };
  presentation: {
    sharedNumberSpace: boolean;
    abbreviation: string;
    promptNoun: string;
    icon: { sprite?: string; filledSprite?: string; path?: string };
    instances: { multiple: boolean; allowLoopbackHttp: boolean; allowPort: boolean; reserved: readonly string[]; placeholder: string };
    cliTransport: boolean;
    token?: { scopes: readonly string[]; createPath?: string };
    urls: { changeRequest: readonly string[]; issue: readonly string[]; discussion?: readonly string[]; commit?: readonly string[]; user?: readonly string[]; resolve?: string };
    features: {
      referenceSearch: boolean; referenceDetail: boolean; listStatuses: boolean; referencesAcross: boolean;
      startThread: boolean; authorCanReview: boolean; projectUploads: boolean; absoluteProjectUploads?: boolean; issueCloseReason: boolean;
      reviewDrafts?: boolean; reviewDraftFileComments?: boolean;
      changeRequestTemplates: readonly string[];
      branchHeads?: boolean;
      submitRequirements?: boolean;
      advancedSearch?: boolean;
      commentEdit?: boolean;
      issueAssignees?: boolean;
      issueCloseReasonWrite?: boolean;
    };
  };
  routeAliases?: {
    authAliasPrefix: string;
    retiredGet: readonly string[];
    retiredPost: readonly string[];
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
    defaultInstances: string[];
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
  urls: { changeRequest: string[]; issue: string[]; discussion?: string[]; commit?: string[]; user?: string[]; resolve?: string };
  features: ProviderDescriptor['presentation']['features'] & {
    changeRequestPatch: boolean;
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
  user: { id: number; login?: string; username?: string; name?: string | null; email?: string | null; avatarUrl?: string };
  secret: string;
}

export interface ConnectedAccount {
  account: AccountIdentity;
  user: Omit<TransportCredential['user'], 'id' | 'avatarUrl' | 'name' | 'email'> & {
    id: number | string;
    avatarUrl?: string | null | undefined;
    name?: string | null | undefined;
    email?: string | null | undefined;
  };
  credential: { credentialRevision: number; providerUserId: string };
}

export interface AccountEvents {
  connected(payload: ConnectedAccount & { renews: AccountIdentity[] }): Promise<void>;
  invalidated(identity: AccountIdentity): Promise<void>;
  removed(identity: AccountIdentity): Promise<void>;
  subscribe(listener: Partial<Omit<AccountEvents, 'subscribe'>>): () => void;
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ProviderReadContext {
  directory: string;
  repositoryId: string;
  provider: ProviderId;
  instance: string;
  accountId: string;
  bindingRevision: number;
  primaryRemote: string;
  linked?: boolean;
}

export interface ReadContextRequest {
  directory?: unknown;
  repositoryId?: unknown;
  provider?: unknown;
  instance?: unknown;
  accountId?: unknown;
  bindingRevision?: unknown;
  primaryRemote?: unknown;
  linked?: unknown;
}

export interface ProviderMutationContext extends ProviderReadContext {
  idempotencyKey: string;
  target: BindingMutationTarget;
}
type OptionalTargetField = 'number' | 'head' | 'base' | 'headSha';
export type ResolvedMutationTarget = Omit<SourceControlMutationTarget, OptionalTargetField> & {
  [Field in OptionalTargetField]?: SourceControlMutationTarget[Field] | undefined;
};

type ResolvedMutation<ProviderTarget> = { providerTarget: ProviderTarget; target: ResolvedMutationTarget };
type MutationReconciliation = { state: string; result?: MutationCompletionInput['result'] };
type ReadInput = { session: ProviderSession; context: ProviderReadContext; directory: string; remote: string };
type ProjectSelector = { owner: string; name: string };

export interface ProviderImplementation<MutationInput = Json, ProviderTarget = Json> {
  descriptor: ProviderDescriptor;
  classifyFailure?(error: Error): string;
  auth: {
    capabilities(input: { instance: string }): Promise<{ authentication: boolean; authenticationMethods: Json }>;
    status(input: { instance: string }): Promise<object>;
    accounts(input: { instance: string }): Promise<readonly object[]>;
    startDeviceFlow?(input: { instance: string }): Promise<{
      flow: { deviceCode: string; clientId: string; expiresIn: number };
      result: { userCode: string; verificationUri: string; expiresIn: number; interval: number; verificationUriComplete?: string };
    }>;
    completeDeviceFlow?(input: { instance: string; deviceCode: string; clientId: string }, control: { consume(): void }): Promise<{ pending: boolean; body: object }>;
    connectToken(input: { instance: string; token: string; username?: string }): Promise<object>;
    activate(input: { instance: string; accountId: string }): Promise<object>;
    setCliDisabled?(input: { instance: string; disabled: boolean }): Promise<{ available: boolean; disabled: boolean }>;
    remove(input: { instance: string; accountId: string }): Promise<{ removed: boolean }>;
    resolveAccount(input: { instance: string; accountId?: string; orCurrent?: boolean }): Promise<ProviderSession>;
    refreshOAuthToken?(input: { instance: string; refreshToken: string }): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>;
    invalidateAccount(input: { instance: unknown; accountId: unknown; persisted?: boolean; renew?: boolean }): Promise<boolean>;
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
    changeRequestStatus(input: ReadInput & { branch: string; force: boolean }): Promise<object>;
    listChangeRequests(input: ReadInput & { page: number; query?: string | undefined; state: string; people: string; labels?: string[] }): Promise<object>;
    changeRequestContext(input: ReadInput & {
      number: number; project?: ProjectSelector | undefined; includeDiff: boolean; includeCIDetails: boolean; includeTimeline: boolean;
      includeReferences?: boolean;
      revision?: string;
    }): Promise<object>;
    listIssues?(input: ReadInput & { page: number; query?: string | undefined; state: string; people: string; labels?: string[] }): Promise<object>;
    getIssue?(input: ReadInput & { number: number; project?: ProjectSelector | undefined; includeReferences?: boolean }): Promise<object | null>;
    issueComments?(input: ReadInput & { number: number; project?: ProjectSelector | undefined }): Promise<object>;
    projectUpstream(input: ReadInput): Promise<object>;
    projectBranches(input: ReadInput & { project: ProjectSelector }): Promise<object>;
    listLabels?(input: ReadInput & { project: ProjectSelector }): Promise<object>;
    listReviewerCandidates?(input: ReadInput & { project: ProjectSelector; role?: 'assignee' | 'reviewer' }): Promise<object>;
    readUpload?(input: ReadInput & { project: ProjectSelector; secret: string; filename: string; range?: string | undefined; signal: AbortSignal }): Promise<Response>;
    readChangeRequestPatch?(input: Omit<ReadInput, 'context'> & {
      number: number; sourceRepo?: { owner: string; repo: string } | null | undefined; revision?: string; linked?: true;
    }): Promise<Json>;
    readChangeRequestFile?(input: Omit<ReadInput, 'context'> & {
      number: number; sourceRepo?: { owner: string; repo: string } | null | undefined; path: string; previousPath?: string | undefined; status?: string;
      revision?: string; binary?: true | undefined; linked?: true;
    }): Promise<Json>;
    liveSummaries?(input: { session: ProviderSession; refs: ThreadRef[]; issueRefs: ThreadRef[]; discussionRefs: ThreadRef[]; details: boolean }): Promise<Omit<LiveSummariesResult, 'connected'>>;
    readChangeRequestHead?(input: ReadInput & { number: number }): Promise<{
      project: { id: string; owner: string; name: string }; headSha: string; headBranch: string; headOwner: string;
    }>;
    resolveChangeRequestSource?(input: ReadInput & {
      project: { id: string; owner: string; name: string }; number: number;
      expectedHeadSha: string; requestedRemoteName: string;
    }): Promise<ResolvedChangeRequestSource>;
    references?(input: ReadInput & { kind: 'issue' | 'pull' | 'discussion'; state: string; people: string; query: string; cursor: string | null }): Promise<object>;
    referencesAcross?(input: { body: SourceControlJson; validateReadContext(context: ReadContextRequest): Promise<ProviderReadContext | null> }): Promise<object>;
    referenceDetail?(input: ReadInput & { project: ProjectSelector; number: number; host: string; kind: 'item' | 'discussion'; includeReferences?: boolean }): Promise<object>;
    reviewState?(input: ReadInput & { project: ProjectSelector; number: number }): Promise<object>;
    referenceStatuses?(input: Omit<ReadInput, 'session'> & { pulls: string }): Promise<object>;
  };
  mutations?: {
    routes: readonly string[];
    prepare(input: { route: string; input: SourceControlJsonObject; context: ProviderMutationContext; actor: AccountIdentity; credential: { accountId: string; credentialRevision: number } }): {
      kind: string; input: MutationInput; digest(target: ResolvedMutationTarget): string;
    };
    resolveTarget(input: { session: ProviderSession; context: ProviderMutationContext; kind: string; input: MutationInput; replayOf?: MutationRecord }): ResolvedMutation<ProviderTarget> | Promise<ResolvedMutation<ProviderTarget>>;
    perform(input: { session: ProviderSession; route: string; kind: string; input: MutationInput; resolved: ResolvedMutation<ProviderTarget> }): Promise<MutationCompletionInput['result']>;
    reconcile(input: { session: ProviderSession; route: string; kind: string; input: MutationInput; resolved: ResolvedMutation<ProviderTarget> }): MutationReconciliation | Promise<MutationReconciliation>;
    afterSuccess?(input: { session: ProviderSession; target: SourceControlMutationTarget }): Promise<void>;
    classifyError?(cause: unknown): 'failed' | 'outcome-unknown';
    presentError?(cause: unknown): { status: number; body: object };
  };
}

export type ResolvedChangeRequestSource = SourceControlChangeRequestSource & {
  context: ProviderReadContext;
  requestedRemoteName: string;
  remoteUrl?: string;
};

export type ProviderMutations<MutationInput = Json, ProviderTarget = Json> = NonNullable<ProviderImplementation<MutationInput, ProviderTarget>['mutations']>;

export type VerifyToken = (origin: string, token: string, credentials?: { username: string }) => Promise<TransportCredential['user']>;
export type ProbeInstance = (origin: string, token?: string, credentials?: { username: string }) => Promise<{ supported: boolean; version?: string | null; message?: string; edition?: string | null }>;


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
