import type { SourceControlProviderId } from './providers/descriptor.js';

export type SourceControlProvider = SourceControlProviderId;

export interface SourceControlIdentity {
  provider: SourceControlProvider;
  instance: string;
  instanceSshUrl?: string;
  instanceAliases?: string[];
}

export interface SourceControlRepositoryEndpoint {
  displayUrl: string;
  fingerprint: string;
}

export interface SourceControlRepositoryRemote {
  name: string;
  fetch: SourceControlRepositoryEndpoint;
  push: SourceControlRepositoryEndpoint;
}

export interface SourceControlRepositoryContext {
  repositoryId: string;
  configRevision: string;
  bare: boolean;
  remotes: SourceControlRepositoryRemote[];
}

export interface SourceControlReadContext extends SourceControlIdentity {
  directory: string;
  repositoryId: string;
  accountId: string;
  bindingRevision: number;
  primaryRemote: string;
  linked?: true;
}

export interface SourceControlProviderBinding extends SourceControlIdentity {
  accountId: string;
  primaryRemote: string;
  repository?: { owner: string; name: string };
}

export type SourceControlProviderBindingTarget = Pick<SourceControlProviderBinding,
  'provider' | 'instance' | 'accountId' | 'primaryRemote'>;

export type SourceControlProviderBindingMutation = {
  directory: string;
  expectedRepositoryId: string;
  expectedRevision: number;
} & (
  | { operation: 'add'; provider: SourceControlProviderBinding }
  | { operation: 'replace'; target: SourceControlProviderBindingTarget; provider: SourceControlProviderBinding }
  | { operation: 'remove'; target: SourceControlProviderBindingTarget }
);

export type SourceControlManagedCredentialPresentation =
  | {
      status: 'available';
      transport: 'https';
      provider: SourceControlProvider;
      instance: string;
      source: 'oauth' | 'pat' | 'cli';
      username: string;
      providerUserId: string;
    }
  | { status: 'available'; transport: 'ssh'; fingerprint: string }
  | { status: 'unavailable' };

export interface SourceControlRepositoryBinding {
  repositoryId: string;
  revision: number;
  providers: Array<SourceControlProviderBinding & {
    readiness: 'ready' | 'confirmation-required' | 'account-unavailable' | 'config-changed';
    endpoint: SourceControlRepositoryEndpoint | null;
  }>; 
  remotes: Array<SourceControlRepositoryRemote & {
    readiness: 'ready' | 'confirmation-required' | 'config-changed';
    inherited?: true;
  } & (
    | { mode: 'managed'; credentialId: string; presentation?: SourceControlManagedCredentialPresentation }
    | { mode: 'system'; credentialId?: never }
    | { mode: 'anonymous'; credentialId?: never }
  )>;
  auxiliary: Array<{
    kind: 'submodule' | 'lfs';
    endpoint: SourceControlRepositoryEndpoint;
    readiness: 'ready' | 'confirmation-required';
  } & (
    | { mode: 'managed'; credentialId: string }
    | { mode: 'system'; credentialId?: never }
    | { mode: 'anonymous'; credentialId?: never }
  )>;
  state: 'bound' | 'needs-attention';
  configRevision: string;
}

type SourceControlBindingReadBase = {
  repository: SourceControlRepositoryContext;
  revision: number;
};

export type SourceControlBindingRead =
  | (SourceControlBindingReadBase & { status: 'missing'; binding: null })
  | (SourceControlBindingReadBase & { status: 'needs-attention'; binding: SourceControlRepositoryBinding })
  | (SourceControlBindingReadBase & { status: 'bound'; binding: SourceControlRepositoryBinding });

export const effectiveRepositoryBinding = (read: SourceControlBindingRead): SourceControlRepositoryBinding => {
  if (read.binding) return read.binding;
  return {
    repositoryId: read.repository.repositoryId,
    revision: read.revision,
    providers: [],
    remotes: read.repository.remotes.map((remote) => ({ ...remote, mode: 'system', readiness: 'ready' })),
    auxiliary: [],
    state: 'bound',
    configRevision: read.repository.configRevision,
  };
};

export const hasConfigChangedGrant = (binding: SourceControlRepositoryBinding): boolean =>
  [...binding.providers, ...binding.remotes].some((entry) => entry.readiness === 'config-changed');

export type GitTransportBindingIntent = {
  directory: string;
  expectedRepositoryId: string;
  expectedRevision: number;
  expectedConfigRevision: string;
  expectedFetchFingerprint: string;
  expectedPushFingerprint: string;
  remote: string;
} & (
  | { transport: 'system'; unverifiedConfirmed: true; credentialAccount?: never }
  | { transport: 'anonymous'; credentialAccount?: never; unverifiedConfirmed?: never }
  | { transport: 'https'; credentialAccount: SourceControlIdentity & { accountId: string }; unverifiedConfirmed?: never }
  | { transport: 'ssh'; sshCredentialId: string; credentialAccount?: never; unverifiedConfirmed?: never }
);

export type GitTransportBindingResult =
  | { status: 'cancelled' }
  | { status: 'configured'; binding: SourceControlBindingRead };

export type GitTransportBindingRemovalIntent = {
  directory: string;
  expectedRepositoryId: string;
  expectedRevision: number;
  expectedConfigRevision: string;
  expectedFetchFingerprint: string;
  expectedPushFingerprint: string;
  remote: string;
};

export type GitTransportBindingRemovalResult = { status: 'removed'; binding: SourceControlBindingRead };

export type SourceControlRepositoryBindingResetIntent = {
  directory: string;
  expectedRepositoryId: string;
  expectedRevision: number;
  expectedConfigRevision: string;
  confirmed: true;
};

export type GitAuxiliaryBindingIntent = {
  directory: string;
  expectedRepositoryId: string;
  expectedRevision: number;
  expectedConfigRevision: string;
  parentRemote: string;
  expectedParentFingerprint: string;
  kind: 'submodule' | 'lfs';
  path: string;
  expectedEndpointFingerprint: string;
} & (
  | { operation: 'remove' }
  | { operation: 'configure'; transport: 'system'; unverifiedConfirmed: true; credentialAccount?: never; sshCredentialId?: never }
  | { operation: 'configure'; transport: 'anonymous'; credentialAccount?: never; sshCredentialId?: never; unverifiedConfirmed?: never }
  | { operation: 'configure'; transport: 'https'; credentialAccount: SourceControlIdentity & { accountId: string }; sshCredentialId?: never; unverifiedConfirmed?: never }
  | { operation: 'configure'; transport: 'ssh'; sshCredentialId: string; credentialAccount?: never; unverifiedConfirmed?: never }
);

export type GitAuxiliaryBindingResult = { status: 'configured'; binding: SourceControlBindingRead };

export interface SourceControlUser extends SourceControlIdentity {
  id: string;
  username: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
}

type SourceControlAuthError = {
  status: 'error';
  code: 'access-denied' | 'expired' | 'network' | 'provider-error';
  message: string;
};

export interface SourceControlAuthAccount {
  id: string;
  credentialId: string;
  credentialRevision: number;
  providerUserId: string;
  providerUserStatus: 'available' | 'unavailable';
  user: SourceControlUser;
  scope?: string;
  current: boolean;
  usable?: boolean;
  source: 'oauth' | 'pat' | 'cli';
  status: 'valid' | 'invalid';
}

type SourceControlDisconnectedAuth = SourceControlIdentity & {
  connected: false;
  accounts?: SourceControlAuthAccount[];
  cli?: { available: boolean; disabled: boolean; active: boolean; user?: SourceControlUser };
};

export type SourceControlAuthStatus =
  | (SourceControlDisconnectedAuth & {
      status: 'disconnected';
    })
  | (SourceControlDisconnectedAuth & { status: 'unavailable'; message?: string })
  | (SourceControlDisconnectedAuth & { status: 'misconfigured'; reason: 'invalid-client'; message?: string })
  | (SourceControlDisconnectedAuth & { status: 'unreachable'; message?: string })
  | (SourceControlDisconnectedAuth & { status: 'temporarily-unavailable'; message?: string })
  | (SourceControlDisconnectedAuth & { status: 'unsupported'; reason: 'no-supported-auth-method'; message?: string })
  | (SourceControlIdentity & {
      status: 'connected';
      connected: true;
      user: SourceControlUser;
      scope?: string;
      accounts: SourceControlAuthAccount[];
      cli?: { available: boolean; disabled: boolean; active: boolean; user?: SourceControlUser };
    });

export interface SourceControlCapabilities {
  identity: SourceControlIdentity;
  authentication: boolean;
  authenticationMethods: {
    device: SourceControlAuthMethodCapability;
    pat: SourceControlAuthMethodCapability;
    cli: SourceControlAuthMethodCapability;
  };
  multipleAccounts: boolean;
  projects: boolean;
  issues: boolean;
  changeRequests: boolean;
  draftChangeRequests: boolean;
  draftConversion?: boolean;
  mergeChangeRequests: boolean;
  mergeMethods?: MergeMethod[];
  ci: boolean;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase' | 'submit';
const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase', 'submit'];

export const isKnownMergeMethod = (value: string): value is MergeMethod => MERGE_METHODS.some((method) => method === value);

export interface SourceControlAuthMethodCapability {
  available: boolean;
  reason?: 'not-gitlab' | 'unsupported' | 'invalid-client' | 'cli-unavailable' | 'provider-error' | 'runtime-unsupported';
}

export interface Project extends SourceControlIdentity {
  id: string;
  owner: string;
  name: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
  defaultBranch?: string;
  defaultBranchSha?: string | null;
  remoteName?: string | null;
}

export interface Label {
  name: string;
  color?: string;
}

export interface Issue extends SourceControlIdentity {
  id: string;
  number: number;
  project: Project;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed';
  author?: SourceControlUser | null;
  assignees?: SourceControlUser[];
  labels?: Label[];
  createdAt?: string;
  updatedAt?: string;
}

export interface IssueComment extends SourceControlIdentity {
  id: string;
  url: string;
  body: string;
  author?: SourceControlUser | null;
  createdAt?: string;
  updatedAt?: string;
  canUpdate?: boolean;
  canDelete?: boolean;
  thread?: CommentThreadRef;
}

export interface CommentThreadRef {
  id: string;
  resolved: boolean;
  resolvable: boolean;
  first: boolean;
  canResolve?: boolean;
  canReply?: boolean;
}

export interface ChangeRequest extends SourceControlIdentity {
  id: string;
  number: number;
  project: Project;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  base: string;
  head: string;
  headSha?: string;
  author?: SourceControlUser | null;
  createdAt?: string;
  updatedAt?: string;
  headLabel?: string;
  headProject?: Project | null;
  mergeable?: boolean | null;
  mergeableState?: string | null;
  isInMergeQueue?: boolean;
  mergeQueueEntry?: { state: string; position: number } | null;
  autoMergeRequest?: { enabledAt: string; mergeMethod: string } | null;
  labels?: Label[];
  workInProgress?: boolean;
  private?: boolean;
  topic?: string;
  hashtags?: string[];
  revisionNumber?: number;
}

export interface ChangeRequestFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

export interface ChangeRequestReviewComment extends IssueComment {
  path?: string;
  line?: number | null;
  position?: number | null;
  revision?: number;
}

export type ChangeRequestRevisionKind = 'rework' | 'trivial-rebase' | 'merge-first-parent-update' | 'no-code-change' | 'no-change';

export interface ChangeRequestRevision {
  number: number;
  sha: string;
  createdAt: string | null;
  uploader?: SourceControlUser;
  kind?: ChangeRequestRevisionKind;
  ref: string;
}

export interface ChangeRequestVoteValue {
  value: number;
  description: string;
}

export interface ChangeRequestVote {
  user: SourceControlUser;
  value: number;
  revision?: number;
}

export interface ChangeRequestVoteLabel {
  name: string;
  values: ChangeRequestVoteValue[];
  defaultValue: number;
  permitted: number[];
  blocking: boolean;
  status: 'approved' | 'rejected' | 'recommended' | 'disliked' | 'neutral';
  votes: ChangeRequestVote[];
}

export interface ChangeRequestSubmitRequirement {
  name: string;
  status: 'satisfied' | 'unsatisfied' | 'overridden' | 'not-applicable' | 'error' | 'forced';
  description?: string;
}

export interface ChangeRequestLocalRevision {
  sha: string;
  changeId: string | null;
  uploadedAs: number | null;
}

export type CIState = 'success' | 'failure' | 'pending' | 'unknown';

export interface CISummary {
  state: CIState;
  total: number;
  success: number;
  failure: number;
  pending: number;
  inProgress?: number;
  queued?: number;
  startedAt?: string;
}

export interface CIStep {
  name: string;
  status?: string;
  conclusion?: string | null;
  number?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface CIAnnotation {
  path?: string;
  startLine?: number;
  endLine?: number;
  level?: string;
  message: string;
  title?: string;
  rawDetails?: string;
}

export interface CIRun extends SourceControlIdentity {
  id: string;
  name: string;
  startedAt?: string;
  completedAt?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  application?: { name?: string; slug?: string };
  job?: {
    runId?: string;
    jobId?: string;
    url?: string;
    name?: string;
    workflowName?: string;
    conclusion?: string | null;
    steps?: CIStep[];
  };
  output?: { title?: string; summary?: string; text?: string };
  annotations?: CIAnnotation[];
}

export interface CI {
  summary: CISummary;
  runs?: CIRun[];
}

export interface PageResult<TItem> {
  items: TItem[];
  page: number;
  hasMore: boolean;
  incompleteProjectIds?: string[];
}

export interface ChangeRequestCommit {
  sha: string;
  headline: string;
  authorName: string | null;
  committedAt: string | null;
  url: string | null;
}

export interface ChangeRequestVerdict {
  state: 'approved' | 'changes_requested';
  author?: SourceControlUser;
  createdAt: string | null;
  url: string;
}

export interface PullRequestStack {
  number: number | null;
  base: string;
  layers: PullRequestStackLayer[];
}

export interface PullRequestStackLayer {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  head: string;
}

export interface ChangeRequestContext {
  identity: SourceControlIdentity;
  fetchedAt?: number;
  project: Project | null;
  changeRequest: ChangeRequest | null;
  issueComments: IssueComment[];
  reviewComments: ChangeRequestReviewComment[];
  files: ChangeRequestFile[];
  diff?: string;
  ci?: CI | null;
  commits?: ChangeRequestCommit[];
  commitsComplete?: boolean;
  verdicts?: ChangeRequestVerdict[];
  reviewers?: SourceControlUser[];
  stack?: PullRequestStack | null;
  voteLabels?: ChangeRequestVoteLabel[];
  submitRequirements?: ChangeRequestSubmitRequirement[];
  revisions?: ChangeRequestRevision[];
}

export interface ChangeRequestStatus {
  identity: SourceControlIdentity;
  fetchedAt?: number;
  project: Project | null;
  branch: string;
  changeRequest: ChangeRequest | null;
  ci?: CI | null;
  canMerge?: boolean;
  defaultBranch?: string | null;
  resolvedRemoteName?: string | null;
  localRevision?: ChangeRequestLocalRevision;
  stack?: PullRequestStack | null;
}

export interface ProjectUpstream {
  identity: SourceControlIdentity;
  isFork: boolean;
  upstream: Project | null;
}

export interface SourceControlDeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
}

export type SourceControlDeviceFlowComplete =
  | { status: 'connected'; user: SourceControlUser; scope?: string }
  | { status: 'pending'; slowDown?: boolean }
  | SourceControlAuthError;

export interface SourceControlMutationProjectTarget {
  owner: string;
  name: string;
}

export interface SourceControlCreateMutationTarget {
  project: SourceControlMutationProjectTarget;
  head: string;
  base: string;
  number?: never;
  headSha?: never;
}

export interface SourceControlExistingMutationTarget {
  project: SourceControlMutationProjectTarget;
  number: number;
  head?: string;
  base?: string;
  headSha?: string;
}

export type SourceControlExpectedMutationTarget =
  | SourceControlCreateMutationTarget
  | SourceControlExistingMutationTarget;

export interface SourceControlMutationContext<
  TTarget extends SourceControlExpectedMutationTarget = SourceControlExpectedMutationTarget,
> extends SourceControlReadContext {
  idempotencyKey: string;
  target: TTarget;
}

export interface SourceControlResolvedMutationTarget {
  repositoryId: string;
  bindingRevision: number;
  primaryRemote: string;
  project: { id: string; owner: string; name: string };
  number?: number;
  head?: string;
  base?: string;
  headSha?: string;
}

export interface SourceControlMutationReceipt<TResult> {
  status: 'succeeded';
  actor: SourceControlIdentity & { providerAccountId: string };
  target: SourceControlResolvedMutationTarget;
  replayed: boolean;
  result: TResult;
}

export type SourceControlEmptyMutationResult = Record<string, never>;
export interface SourceControlCreateMutationResult {
  stacked?: boolean;
}
export interface SourceControlMergeMutationResult {
  merged: boolean;
  message?: string;
  outcome?: 'queued' | 'merging' | 'auto-merge' | 'cancelled';
}
export interface SourceControlReadyMutationResult {
  ready: boolean;
}
export interface SourceControlDraftMutationResult {
  draft: boolean;
}
export interface SourceControlStateMutationResult {
  state: 'open' | 'closed';
}
export interface SourceControlReviewMutationResult {
  commented: boolean;
}

export interface CreateChangeRequestInput extends SourceControlMutationContext<SourceControlCreateMutationTarget> {
  title: string;
  body?: string;
  draft?: boolean;
  remote?: string;
  headRemote?: string;
}

export interface UpdateChangeRequestInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  title: string;
  body?: string;
}

export interface UpdateIssueInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  title: string;
  body?: string;
}

export interface UpdateDiscussionInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  title: string;
  body?: string;
}

export interface MergeChangeRequestInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  method: MergeMethod;
  cancel?: boolean;
}

export type ReadyChangeRequestInput = SourceControlMutationContext<SourceControlExistingMutationTarget>;
export type DraftChangeRequestInput = SourceControlMutationContext<SourceControlExistingMutationTarget>;

export interface CommentInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  body: string;
}

export interface CommentUpdateInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  commentId: string;
  body: string;
}

export interface CommentDeleteInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  commentId: string;
}

export interface ThreadReplyInput extends CommentInput {
  threadId: string;
}

export interface ThreadResolveInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  threadId: string;
  resolved: boolean;
}

export type ReviewVerdict = 'approve' | 'request-changes' | 'comment';

export type ReviewCommentSide = 'old' | 'new';

export type ReviewCommentPosition =
  | { path: string; side: ReviewCommentSide; line: number; startLine?: number }
  | { path: string; side?: never; line?: never; startLine?: never };

export type ReviewCommentInput = SourceControlMutationContext<SourceControlExistingMutationTarget> & ReviewCommentPosition & {
  body: string;
};

export interface ReviewCommentUpdateInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  commentId: string;
  body: string;
}

export interface ReviewCommentDeleteInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  commentId: string;
}

export type ReviewDiscardInput = SourceControlMutationContext<SourceControlExistingMutationTarget>;

export interface ReviewPerson {
  login: string;
  avatarUrl?: string;
}

export interface ReviewDraftComment {
  id: string;
  path: string;
  side: ReviewCommentSide;
  line: number | null;
  startLine: number | null;
  body: string;
  author: ReviewPerson | null;
}

export interface ReviewThreadComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  author: ReviewPerson | null;
}

export interface ReviewThread {
  id: string;
  path: string;
  side: ReviewCommentSide;
  line: number | null;
  startLine: number | null;
  resolved: boolean;
  canReply: boolean;
  canResolve: boolean;
  comments: ReviewThreadComment[];
}

export interface ChangeRequestReviewState {
  viewerIsAuthor: boolean;
  headSha: string;
  draft: { id: string; body: string; comments: ReviewDraftComment[] } | null;
  threads: ReviewThread[];
  truncated: boolean;
}

export type ChangeRequestReviewStateResult =
  | { connected: false }
  | ({ connected: true } & ChangeRequestReviewState);

export interface SetLabelsInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  labels: string[];
}

export interface SetReviewersInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  reviewers: string[];
}

export interface SetStateInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  state: 'open' | 'closed';
}

export type DiscussionCloseReason = 'resolved' | 'outdated' | 'duplicate';

export interface DiscussionCommentInput extends CommentInput {
  replyTo?: string;
}

export type SetDiscussionStateInput = SourceControlMutationContext<SourceControlExistingMutationTarget> & (
  | { state: 'closed'; reason: DiscussionCloseReason }
  | { state: 'open'; reason?: never }
);

export interface SetDiscussionAnswerInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  commentId: string;
  answer: boolean;
}

export type ReviewChangeRequestInput = SourceControlMutationContext<SourceControlExistingMutationTarget> & {
  body?: string;
} & (
  | { verdict: ReviewVerdict; votes?: never }
  | { votes: Record<string, number>; verdict?: never; publishDrafts?: boolean }
);
