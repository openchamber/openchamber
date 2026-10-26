import type { SourceControlProviderId } from './providers/descriptor';

/** Open: any id the connected server serves; an id the registry does not hold reads through the fallback descriptor. */
export type SourceControlProvider = SourceControlProviderId;

export interface SourceControlIdentity {
  provider: SourceControlProvider;
  /** Stable provider installation or host identifier, such as `github.com`. */
  instance: string;
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
  /** Exact immutable credential account identity selected by the binding. */
  accountId: string;
  bindingRevision: number;
  primaryRemote: string;
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
    /**
     * Derived from the repository's identity rather than saved for this
     * remote: the System identity reaches every remote, any other identity
     * every remote on its own host and protocol. Never a mutation target.
     */
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

/**
 * The binding a repository acts under, whether or not one was configured.
 *
 * A repository nobody configured uses the machine's own Git for every remote,
 * as it did before bindings existed: every remote is a ready System grant, and
 * the read's revision (the store's tombstone revision) pins the plan so a later
 * configuration still invalidates it.
 */
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

/** Whether a bound remote moved or disappeared after the binding was saved. */
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
  /** Provider-assigned user id. */
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
  /** Exact immutable credential/source identity used by actions and bindings. */
  id: string;
  credentialId: string;
  credentialRevision: number;
  /** Stable provider user identity used for grouping and server-derived actor attribution. */
  providerUserId: string;
  providerUserStatus: 'available' | 'unavailable';
  user: SourceControlUser;
  scope?: string;
  current: boolean;
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
  mergeChangeRequests: boolean;
  mergeMethods?: MergeMethod[];
  ci: boolean;
}

/**
 * How a change request lands: merge, squash or rebase on a forge, or
 * `submit` on a review host, which lands it the way the project is set up and
 * is then the only method.
 */
export type MergeMethod = 'merge' | 'squash' | 'rebase' | 'submit';
const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase', 'submit'];

/** Whether this version knows `value` as a method; a newer server may name others. */
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
  /** The thread the comment is in, when read for the preview's timeline (GitLab merge requests). */
  thread?: CommentThreadRef;
}

export interface CommentThreadRef {
  id: string;
  resolved: boolean;
  /** Whether the thread is one that waits to be resolved. */
  resolvable: boolean;
  /** Whether this comment opened the thread; the others answer it. */
  first: boolean;
  /** This account's permissions, when the host said; absent means unknown. */
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
  labels?: Label[];
  /** A review host's work-in-progress flag; `draft` carries the same meaning for gating. */
  workInProgress?: boolean;
  /** Visible only to its owner and reviewers (a review host's private change). */
  private?: boolean;
  /** The topic a review host groups related changes under. */
  topic?: string;
  /** A review host's hashtags; read only, and also listed among `labels`. */
  hashtags?: string[];
  /** The number of the revision (patchset) `headSha` is, where the host keeps revisions. */
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
  /** The revision (patchset) the comment was made on, where the host keeps revisions. */
  revision?: number;
}

/** What a new revision changed against the one before it, as a review host classifies it. */
export type ChangeRequestRevisionKind = 'rework' | 'trivial-rebase' | 'merge-first-parent-update' | 'no-code-change' | 'no-change';

/** One revision (patchset) of a change: each upload makes a new one. */
export interface ChangeRequestRevision {
  number: number;
  sha: string;
  createdAt: string | null;
  uploader?: SourceControlUser;
  kind?: ChangeRequestRevisionKind;
  /** The ref the revision can be fetched from. */
  ref: string;
}

/** One value a vote label takes, with the host's description of it ("Looks good to me"). */
export interface ChangeRequestVoteValue {
  value: number;
  description: string;
}

/** A vote someone cast on a label; `revision` is the patchset it was cast on, when the host says. */
export interface ChangeRequestVote {
  user: SourceControlUser;
  value: number;
  revision?: number;
}

/**
 * A label a change is voted on (a review host's Code-Review, Verified, or a
 * project's own). Named `voteLabels` on the context: `labels` already means
 * tags on a change request.
 */
export interface ChangeRequestVoteLabel {
  name: string;
  values: ChangeRequestVoteValue[];
  defaultValue: number;
  /** The values this account may cast; empty when it may not vote on the label. */
  permitted: number[];
  /** Whether the label holds submission back until it is satisfied. */
  blocking: boolean;
  status: 'approved' | 'rejected' | 'recommended' | 'disliked' | 'neutral';
  votes: ChangeRequestVote[];
}

/** One condition a change must meet before it can be submitted. */
export interface ChangeRequestSubmitRequirement {
  name: string;
  status: 'satisfied' | 'unsatisfied' | 'overridden' | 'not-applicable' | 'error' | 'forced';
  description?: string;
}

/** The checked-out commit against a review host's change. */
export interface ChangeRequestLocalRevision {
  sha: string;
  /** The Change-Id trailer of the commit; null when it has none. */
  changeId: string | null;
  /** The patchset whose commit is the local one; null when the local commits are not uploaded. */
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

/** A commit of a change request, as a timeline shows it. */
export interface ChangeRequestCommit {
  sha: string;
  headline: string;
  authorName: string | null;
  committedAt: string | null;
  url: string | null;
}

/** A review verdict on a change request: an approval or a request for changes. */
export interface ChangeRequestVerdict {
  state: 'approved' | 'changes_requested';
  author?: SourceControlUser;
  createdAt: string | null;
  url: string;
}

/**
 * Pull requests stacked on one another, bottom layer first: each targets the
 * branch of the one below, and the bottom one targets `base`. GitHub keeps a
 * stack as its own object (`number`); on GitLab it is a chain of merge
 * requests by target branch, with no number.
 */
export interface PullRequestStack {
  number: number | null;
  /** The branch the whole stack lands on. */
  base: string;
  layers: PullRequestStackLayer[];
}

export interface PullRequestStackLayer {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  /** The layer's branch, which the layer above it targets. */
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
  /** With `includeTimeline`: the newest commits, oldest first. */
  commits?: ChangeRequestCommit[];
  /** False when `commits` holds only the newest ones. */
  commitsComplete?: boolean;
  /** With `includeTimeline`: the verdicts reviewers gave, as the host recorded them. */
  verdicts?: ChangeRequestVerdict[];
  /** With `includeTimeline`: who is asked to review. */
  reviewers?: SourceControlUser[];
  /**
   * The stack the change request is a layer of: GitHub's own (sent only for
   * a layer of one), or on GitLab the chain of open merge requests by branch
   * (null in none). Absent when it could not be read.
   */
  stack?: PullRequestStack | null;
  /** The labels the change is voted on, where the host reviews by votes. */
  voteLabels?: ChangeRequestVoteLabel[];
  /** What the change needs before it can be submitted, where the host says. */
  submitRequirements?: ChangeRequestSubmitRequirement[];
  /** The change's revisions (patchsets), oldest first, where the host keeps them. */
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
  /** Where changes are created by pushing for review: the checked-out commit against the change. */
  localRevision?: ChangeRequestLocalRevision;
  /** Where changes are created by pushing for review: the chain the change is in, null when none. */
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
  /** Verified provider-user identity, never the credential account ID. */
  actor: SourceControlIdentity & { providerAccountId: string };
  target: SourceControlResolvedMutationTarget;
  replayed: boolean;
  result: TResult;
}

export type SourceControlEmptyMutationResult = Record<string, never>;
export interface SourceControlCreateMutationResult {
  /**
   * Set when the new pull request's base is another open one's branch: true
   * once the host keeps the two as a stack, false when it refused, so the
   * request stands on that base outside any stack.
   */
  stacked?: boolean;
}
export interface SourceControlMergeMutationResult {
  merged: boolean;
  message?: string;
  /**
   * Set when the host accepted the merge without finishing it yet: added to a
   * merge queue, or still merging in the background (GitHub, a stack's lower
   * layers included). The PR's live state shows the outcome.
   */
  outcome?: 'queued' | 'merging';
}
export interface SourceControlReadyMutationResult {
  ready: boolean;
}
export interface SourceControlStateMutationResult {
  state: 'open' | 'closed';
}
export interface SourceControlReviewMutationResult {
  /** The review's text was posted with it; false when it had none or the text failed to post after the verdict. */
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

export interface MergeChangeRequestInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  method: MergeMethod;
}

export type ReadyChangeRequestInput = SourceControlMutationContext<SourceControlExistingMutationTarget>;

/** A comment on a change request, or on an issue (the target names its number). */
export interface CommentInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  body: string;
}

/** A reply in a change request's review thread; `threadId` is the host's id for it. */
export interface ThreadReplyInput extends CommentInput {
  threadId: string;
}

/** Resolve a change request's review thread, or open it again. */
export interface ThreadResolveInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  threadId: string;
  resolved: boolean;
}

export type ReviewVerdict = 'approve' | 'request-changes';

/** The whole label set of a change request or an issue; an empty one clears it. */
export interface SetLabelsInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  labels: string[];
}

/** The whole set of people asked to review, by the host's user id (a login on GitHub). */
export interface SetReviewersInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  reviewers: string[];
}

/** Close (`closed`) or reopen (`open`) a change request or an issue. */
export interface SetStateInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  state: 'open' | 'closed';
}

/** Why a discussion is closed: answered or settled, no longer relevant, or a copy of another. */
export type DiscussionCloseReason = 'resolved' | 'outdated' | 'duplicate';

/** A comment on a discussion, or with `replyTo` (a comment's id) a reply in that comment's thread. */
export interface DiscussionCommentInput extends CommentInput {
  replyTo?: string;
}

/** Close a discussion for a reason, or reopen it. */
export type SetDiscussionStateInput = SourceControlMutationContext<SourceControlExistingMutationTarget> & (
  | { state: 'closed'; reason: DiscussionCloseReason }
  | { state: 'open'; reason?: never }
);

/** Choose a comment as the discussion's answer (`answer: true`), or unchoose it. */
export interface SetDiscussionAnswerInput extends SourceControlMutationContext<SourceControlExistingMutationTarget> {
  commentId: string;
  answer: boolean;
}

/**
 * A review: a verdict where the host reviews by verdicts, or votes on labels
 * (label name to value) where it reviews by votes. The target's `headSha` is
 * the commit the review is for; a push past it refuses the review.
 */
export type ReviewChangeRequestInput = SourceControlMutationContext<SourceControlExistingMutationTarget> & {
  body?: string;
} & (
  | { verdict: ReviewVerdict; votes?: never }
  | { votes: Record<string, number>; verdict?: never }
);
