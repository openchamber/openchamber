import type { WorktreeMetadata } from '@/types/worktree';
import type { NotificationPayload } from '@/lib/notifications/notificationShapes';
import type { DesktopSettings } from '@/lib/settings/registry';
import type { GitIdentityProfile, GitIdentitySummary } from './git-identity';
import type { GitPathUnavailableReason } from './git-path-diff';
import type { GitWorktreeValidationResult } from './worktree-validation';
import type { GitWorktreeInfo } from './git-worktree-info';
export type { GitWorktreeInfo } from './git-worktree-info';
export type { GitWorktreeValidationResult };
import type { PushAPI } from './push';
import type { RepositoryReferenceReviewer } from './repositoryReferenceTypes';
import type { RepositoryReferenceDetail } from './repository-reference-detail';
import type { SetAssigneesInput, SetIssueStateInput } from '../source-control/mutation-writes';
import type { SourceControlBranchWrites } from './source-control-branch-writes';
export { SourceControlInstanceAliasError, SourceControlInstanceOtherProviderError } from './source-control-errors';
export type { RepositoryReferenceReviewer } from './repositoryReferenceTypes';
import type {
  ChangeRequest,
  ChangeRequestContext,
  CISummary,
  Label,
  ChangeRequestStatus,
  CreateChangeRequestInput,
  Issue,
  IssueComment,
  MergeChangeRequestInput,
  PageResult,
  ProjectUpstream,
  ReadyChangeRequestInput,
  DraftChangeRequestInput,
  CommentInput,
  CommentUpdateInput,
  CommentDeleteInput,
  DiscussionCloseReason,
  DiscussionCommentInput,
  ChangeRequestReviewStateResult,
  ReviewChangeRequestInput,
  SourceControlReviewWrites,
  SetDiscussionAnswerInput,
  SetDiscussionStateInput,
  SetStateInput,
  SetLabelsInput,
  SetReviewersInput,
  ThreadReplyInput,
  ThreadResolveInput,
  SourceControlAuthStatus,
  SourceControlCapabilities,
  SourceControlDeviceFlowComplete,
  SourceControlDeviceFlowStart,
  SourceControlIdentity,
  SourceControlEmptyMutationResult,
  SourceControlCreateMutationResult,
  SourceControlMergeMutationResult,
  SourceControlMutationReceipt,
  SourceControlReadyMutationResult,
  SourceControlDraftMutationResult,
  SourceControlReviewMutationResult,
  SourceControlStateMutationResult,
  SourceControlBindingRead,
  SourceControlProvider,
  SourceControlProviderBindingMutation,
  SourceControlReadContext,
  SourceControlRepositoryBindingResetIntent,
  SourceControlRepositoryContext,
  GitTransportBindingIntent,
  GitTransportBindingResult,
  GitTransportBindingRemovalIntent,
  GitTransportBindingRemovalResult,
  GitAuxiliaryBindingIntent,
  GitAuxiliaryBindingResult,
  UpdateChangeRequestInput,
  UpdateIssueInput,
  UpdateDiscussionInput,
} from '../source-control/types';
import type { SourceControlProviderDescriptor } from '../source-control/providers/descriptor';
import type { TrackerAPI } from '../trackers/types';

export type * from '../source-control/types';
export type { IssueCloseReason, SetAssigneesInput, SetIssueStateInput } from '../source-control/mutation-writes';
export type * from '../trackers/types';
export type {
  GitIdentityProfile,
  GitIdentitySummary,
  GitIdentityTransport,
} from './git-identity';

type RuntimePlatform = 'web' | 'desktop' | 'vscode';

interface RuntimeDescriptor {
  platform: RuntimePlatform;

  isDesktop: boolean;

  isVSCode: boolean;

  label?: string;
}

interface Subscription {

  close: () => void;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited' | 'error';
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurpose;
}

export type TerminalSessionPurpose =
  | { type: 'terminal' }
  | { type: 'project-action'; actionId: string; executionId: string; agentSessionId?: string };

export type TerminalShell = 'auto' | 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'dash' | 'ksh' | 'nu';

export interface TerminalShellOption {
  id: TerminalShell;
  name: string;
  supportsLogin: boolean;
}

export interface TerminalStreamEvent {
  type: 'snapshot' | 'data' | 'exit' | 'reconnecting';
  sequence?: number;
  data?: string;
  replayData?: string;
  cols?: number;
  rows?: number;
  status?: 'running' | 'exited' | 'error';
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;

  runtime?: 'node' | 'bun';
  ptyBackend?: string;
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurpose;
}

export interface TerminalError extends Error {
  code?: string;
}

interface BaseCreateTerminalOptions {
  cwd: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
  shell?: TerminalShell;
  loginShell?: boolean;
  purpose?: TerminalSessionPurpose;
}

interface InteractiveCreateTerminalOptions extends BaseCreateTerminalOptions {
  mode?: 'interactive';
}

interface CommandCreateTerminalOptions extends BaseCreateTerminalOptions {
  mode: 'command';
  command: string;
}

export type CreateTerminalOptions = InteractiveCreateTerminalOptions | CommandCreateTerminalOptions;
export type RestartTerminalOptions = InteractiveCreateTerminalOptions;

export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
  directory?: string | null;
}

export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: TerminalError, fatal?: boolean) => void;
}

export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

export interface TerminalServerSession {
  sessionId: string;
  cwd: string;
  status: 'running' | 'exited';
  createdAt: number | null;
  mode?: 'interactive' | 'command';
  purpose?: TerminalSessionPurpose;
}

export interface TerminalAPI {
  listShells?(): Promise<TerminalShellOption[]>;
  listSessions?(cwd: string): Promise<TerminalServerSession[]>;
  touchSessions?(sessionIds: string[], directory?: string | null): Promise<void>;
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers, directory?: string | null): Subscription;
  sendInput(sessionId: string, input: string, directory?: string | null): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  updateAppearance?(sessionId: string, appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>, directory?: string | null): Promise<void>;
  close(sessionId: string, directory?: string | null): Promise<void>;
  restartSession?(currentSessionId: string, options: RestartTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
}

interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
  previousPath?: string;
}

export interface GitMergeInProgress {
  head: string;
  message: string;
}

export interface GitRebaseInProgress {
  headName: string;
  onto: string;
}

export interface GitRemoteComparison {
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  aheadBase?: string | null;
  upstreamComparison?: GitRemoteComparison | null;
  files: GitStatusFile[];
  isClean: boolean;
  unborn?: boolean;
  diffStats?: {
    staged: Record<string, { insertions: number; deletions: number }>;
    working: Record<string, { insertions: number; deletions: number }>;
  };
  mergeInProgress?: GitMergeInProgress | null;
  rebaseInProgress?: GitRebaseInProgress | null;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface GitUnpushedBranchCounts {
  counts: Record<string, number>;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GitSubmoduleState {
  headCommit: string | null;
  indexCommit: string | null;
  worktreeCommit: string | null;
  hasTrackedChanges: boolean;
  hasUntrackedFiles: boolean;
  hasConflict: boolean;
}

export interface GitPathDiffResponse extends GitDiffResponse {
  submodule: GitSubmoduleState | null;
}

export interface GetGitDiffOptions {
  path: string;
  staged?: boolean;
  contextLines?: number;
  previousPath?: string;
}

export interface GetGitDiffsOptions {
  paths: string[];
  staged?: boolean;
  contextLines?: number;
}

export type GitPathDiffBatchEntry =
  | { path: string; ok: true; diff: GitPathDiffResponse }
  | { path: string; ok: false; error: string; reason: GitPathUnavailableReason | null };

export interface GetGitRangeDiffOptions {
  base: string;
  head: string;
  path?: string;
  contextLines?: number;
  includeWorkingTree?: boolean;
  previousPath?: string;
}

export interface GetGitRangeFilesOptions {
  base: string;
  head: string;
  includeWorkingTree?: boolean;
}

export interface GitRangeFileEntry {
  path: string;
  status: string;
  previousPath?: string;
  revision?: string;
}

export interface GitBranchBaseResponse {
  base: string | null;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
  submodule: GitSubmoduleState | null;
}

export interface GetGitFileDiffOptions {
  path: string;
  staged?: boolean;
  previousPath?: string;
}

export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export type GitBranchListOptions = { remote?: 'local' | 'live' };

export interface GitBranch {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
  defaultBranches?: Record<string, string>;
}

interface GitCommitSummary {
  changes: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitResult {
  success: boolean;
  commit: string;
  branch: string;
  summary: GitCommitSummary;
}

export interface GitPushResult {
  success: boolean;
  pushed: Array<{
    local: string;
    remote: string;
  }>;
  repo: string;
  ref: unknown;
}

export interface GitPullResult {
  success: boolean;
  summary: GitCommitSummary;
  files: string[];
  insertions: number;
  deletions: number;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface GitPullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export type GitNetworkTransportMode = 'managed' | 'system' | 'anonymous';

export interface GitNetworkRedactedEndpoint {
  displayUrl: string;
  fingerprint: string;
}

export interface GitNetworkRedactedDestination {
  displayName: string;
  fingerprint: string;
}

interface GitNetworkRuntimeIdentity {
  id: string;
  platform: RuntimePlatform;
  label?: string;
}

export type GitNetworkTransportActor =
  | {
      kind: 'provider';
      provider: string;
      instance: string;
      accountId: string;
      login?: string;
    }
  | {
      kind: 'ssh-key';
      fingerprint: string;
    };

export type GitNetworkTransport =
  | { mode: 'anonymous'; verification: { status: 'anonymous' } }
  | {
      mode: 'managed';
      verification: { status: 'verified'; method: 'credential' | 'git-identity' };
      actor?: GitNetworkTransportActor;
    }
  | {
      mode: 'system';
      verification: { status: 'unverified'; reason: 'system-credentials' };
    };

export interface GitNetworkRemoteTarget {
  name: string;
  endpoint: GitNetworkRedactedEndpoint;
}

export interface GitCheckoutHydrationRequirement {
  kind: 'submodule' | 'lfs';
  path: string;
  endpoint: GitNetworkRedactedEndpoint;
}

type ExistingRepositoryNetworkOperationRequest = {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  remote: GitNetworkRemoteTarget;
  sourceRef: string;
  destinationRef: string;
  transportMode: GitNetworkTransportMode;
};

type GitNetworkSyncRemoteRequest = {
  remote: GitNetworkRemoteTarget;
  sourceRef: string;
  destinationRef: string;
  transportMode: GitNetworkTransportMode;
};

export type GitNetworkOperationRequest =
  | (ExistingRepositoryNetworkOperationRequest & {
      operation: 'push';
      forceWithLease?: { expectedRemoteSha: string };
      configureUpstream?: boolean;
      destinationSelectionId?: string;
      review?: GitPushReviewIntent;
    })
  | (ExistingRepositoryNetworkOperationRequest & { operation: 'fetch'; fetchScope?: 'ref' })
  | (Omit<ExistingRepositoryNetworkOperationRequest, 'sourceRef' | 'destinationRef'> & {
      operation: 'fetch';
      fetchScope: 'remote';
    })
  | (ExistingRepositoryNetworkOperationRequest & { operation: 'pull' })
  | {
      operation: 'delete-remote-branch';
      directory: string;
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      destinationRef: string;
      transportMode: GitNetworkTransportMode;
    }
  | {
      operation: 'checkout-hydration';
      directory: string;
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
    }
  | {
      operation: 'sync';
      directory: string;
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      fetch: GitNetworkSyncRemoteRequest;
      pull: { destinationRef: string };
      push: GitNetworkSyncRemoteRequest & {
        forceWithLease?: { expectedRemoteSha: string };
        destinationSelectionId?: string;
      };
    }
  | ({
      operation: 'clone';
      remoteUrl: string;
      destinationPath: string;
      gitIdentityId?: string;
      providerAccount?: SourceControlIdentity & { accountId: string };
      auxiliaryGrants?: Array<{
        kind: 'submodule' | 'lfs';
        endpoint: GitNetworkRedactedEndpoint;
      } & (
        | { transportMode: 'managed'; credentialId: string }
        | { transportMode: 'system'; unverifiedConfirmed: true; credentialId?: never }
        | { transportMode: 'anonymous'; credentialId?: never; unverifiedConfirmed?: never }
      )>;
    } & (
      | { transportMode: 'system'; unverifiedConfirmed: true; credentialAccount?: never; sshCredentialId?: never }
      | { transportMode: 'anonymous'; credentialAccount?: never; sshCredentialId?: never; unverifiedConfirmed?: never }
      | { transportMode: 'managed'; credentialAccount: SourceControlIdentity & { accountId: string }; sshCredentialId?: never; unverifiedConfirmed?: never }
      | { transportMode: 'managed'; sshCredentialId: string; credentialAccount?: never; unverifiedConfirmed?: never }
    ));

export type GitPushReviewIntent = {
  target: string;
  topic?: string;
  wip?: boolean;
  private?: boolean;
  hashtags?: string[];
};

export type GitManagedSshCredential = {
  credentialId: string;
  label: string;
  fingerprint: string;
  capability: { status: 'ready' } | { status: 'unavailable'; reason: 'unreadable' | 'encrypted-or-unverifiable' | 'fingerprint-mismatch' };
};

export type GitManagedSshCandidate =
  | {
      candidateId: string;
      label: string;
      fingerprint: string;
      capability: { status: 'ready' };
    }
  | {
      label: string;
      capability: { status: 'unavailable'; reason: 'unreadable' | 'encrypted-or-unverifiable' | 'insecure-permissions' };
    };

export type GitManagedSshIntent = { operation: 'inventory' }
  | { operation: 'discover'; passphrase?: string }
  | { operation: 'import'; candidateId: string; expectedFingerprint: string; confirmed: true; passphrase?: string };

export type GitManagedSshResult =
  | { status: 'available'; credentials: GitManagedSshCredential[] }
  | { status: 'discovered'; candidates: GitManagedSshCandidate[]; truncated: boolean }
  | { status: 'imported'; credentials: GitManagedSshCredential[]; selectedCredential: GitManagedSshCredential & { capability: { status: 'ready' } } }
  | { status: 'rejected'; reason: 'candidate-expired' | 'candidate-changed' | 'fingerprint-mismatch' | 'candidate-unavailable' | 'inventory-full' }
  | { status: 'unsupported'; reason: 'host-setup-required' };

export type GitNetworkOperationTarget =
  | {
      operation: 'push';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      sourceRef: string;
      destinationRef: string;
      forceWithLease?: { expectedRemoteSha: string };
      configureUpstream?: boolean;
    }
  | {
      operation: 'fetch';
      fetchScope: 'remote';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      force: boolean;
    }
  | {
      operation: 'fetch';
      fetchScope?: 'ref';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      sourceRef: string;
      destinationRef: string;
    }
  | {
      operation: 'pull';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      sourceRef: string;
      destinationRef: string;
    }
  | {
      operation: 'delete-remote-branch';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      destinationRef: string;
    }
  | {
      operation: 'checkout-hydration';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      remote: GitNetworkRemoteTarget;
      requirements: GitCheckoutHydrationRequirement[];
    }
  | {
      operation: 'sync';
      repositoryId: string;
      bindingRevision: number;
      configRevision: string;
      fetch: GitNetworkRemoteTarget & { sourceRef: string; destinationRef: string };
      pull: { destinationRef: string };
      push: GitNetworkRemoteTarget & {
        sourceRef: string;
        destinationRef: string;
        forceWithLease?: { expectedRemoteSha: string };
      };
    }
  | {
      operation: 'clone';
      remote: GitNetworkRedactedEndpoint;
      destination: GitNetworkRedactedDestination;
    };

export type GitNetworkOperationStep =
  | 'validated'
  | 'authenticated'
  | 'transferred'
  | 'updated-local-repository'
  | 'checked-out'
  | 'cleaned-up';

type GitNetworkSyncStepStatus = 'succeeded' | 'skipped' | 'conflicted' | 'failed' | 'cancelled';

interface GitNetworkSyncStepResult {
  step: 'fetch' | 'pull' | 'push';
  status: GitNetworkSyncStepStatus;
  error?: GitNetworkOperationError;
}

export type GitNetworkOperationErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'STALE_REPOSITORY'
  | 'STALE_BINDING'
  | 'STALE_CONFIG'
  | 'REMOTE_CHANGED'
  | 'REMOTE_URL_USERINFO'
  | 'AUTHENTICATION_REQUIRED'
  | 'DESTINATION_SELECTION_REQUIRED'
  | 'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED'
  | 'AUTHENTICATION_FAILED'
  | 'TRANSPORT_FAILED'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'OUTCOME_UNKNOWN'
  | 'RUNTIME_UNSUPPORTED'
  | 'GIT_LFS_CLIENT_MISSING'
  | 'CHECKOUT_TOO_LARGE'
  | 'PATH_LENGTH_LIMIT'
  | 'BRANCH_NAME_CONFLICT' | 'SUBMODULE_SOURCE_LOCAL' | 'LFS_SOURCE_LOCAL'
  | 'UNKNOWN';

export interface GitNetworkOperationError<Code extends GitNetworkOperationErrorCode = GitNetworkOperationErrorCode> {
  code: Code;
  message: string;
}

export class GitNetworkOperationRequestError extends Error {
  readonly code: GitNetworkOperationErrorCode;
  readonly status: number;

  constructor(code: GitNetworkOperationErrorCode, message: string, status: number) {
    super(message);
    this.name = 'GitNetworkOperationRequestError';
    this.code = code;
    this.status = status;
  }
}

export type GitCheckoutHydrationStatus =
  | 'succeeded'
  | 'authorization-required'
  | 'invalid'
  | 'client-missing'
  | 'failed'
  | 'cancelled'
  | 'not-needed';

interface GitCheckoutHydrationItemResult {
  path: string;
  status: GitCheckoutHydrationStatus;
  endpoint?: GitNetworkRedactedEndpoint;
  error?: GitNetworkOperationError;
}

interface GitCheckoutLfsResult {
  path: string;
  status: GitCheckoutHydrationStatus;
  endpoint?: GitNetworkRedactedEndpoint;
  error?: GitNetworkOperationError;
}

export interface GitCheckoutHydrationResult {
  status: GitCheckoutHydrationStatus;
  submodules: GitCheckoutHydrationItemResult[];
  lfs: GitCheckoutLfsResult[];
}

type GitNetworkOperationBase = {
  operationId: string;
  runtimeIdentity: GitNetworkRuntimeIdentity;
  transport: GitNetworkTransport | { fetch: GitNetworkTransport; push: GitNetworkTransport };
  target: GitNetworkOperationTarget;
  completedSteps: GitNetworkOperationStep[];
  stepResults?: GitNetworkSyncStepResult[];
  hydration?: GitCheckoutHydrationResult;
};

export type GitNetworkOperationPlan = GitNetworkOperationBase & { state: 'planned' };

export type GitNetworkOperation =
  | GitNetworkOperationPlan
  | (GitNetworkOperationBase & { state: 'running' })
  | (GitNetworkOperationBase & { state: 'succeeded' })
  | (GitNetworkOperationBase & {
      state: 'partial';
      error: GitNetworkOperationError<
        | 'INVALID_REQUEST'
        | 'AUTHENTICATION_REQUIRED'
        | 'AUTHENTICATION_FAILED'
        | 'TRANSPORT_FAILED'
        | 'RUNTIME_UNSUPPORTED'
        | 'GIT_LFS_CLIENT_MISSING'
        | 'CHECKOUT_TOO_LARGE'
        | 'UNKNOWN'
      >;
    })
  | (GitNetworkOperationBase & {
      state: 'failed';
      error: GitNetworkOperationError<
        | 'INVALID_REQUEST'
        | 'AUTHENTICATION_REQUIRED'
        | 'AUTHENTICATION_FAILED'
        | 'TRANSPORT_FAILED'
        | 'RUNTIME_UNSUPPORTED'
        | 'GIT_LFS_CLIENT_MISSING'
        | 'CHECKOUT_TOO_LARGE'
        | 'UNKNOWN'
      >;
    })
  | (GitNetworkOperationBase & {
      state: 'cancelled';
      error: GitNetworkOperationError<'CANCELLED' | 'TIMEOUT'>;
    })
  | (GitNetworkOperationBase & {
      state: 'outcome-unknown';
      error: GitNetworkOperationError<'OUTCOME_UNKNOWN'>;
    })
  | (GitNetworkOperationBase & {
      state: 'conflicted';
      error: GitNetworkOperationError<
        'STALE_REPOSITORY' | 'STALE_BINDING' | 'STALE_CONFIG' | 'REMOTE_CHANGED' | 'CONFLICT'
      >;
    });

export interface GitStashEntry {
  ref: string;
  message: string;
  relativeTime: string;
  hash: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitMergeResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface CheckoutCommitResponse {
  success: boolean;
}

export interface CherryPickResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface RevertCommitResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface ResetToCommitResponse {
  success: boolean;
}

export interface GitRebaseResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface MergeConflictDetails {
  statusPorcelain: string;
  unmergedFiles: string[];
  diff: string;
  headInfo: string;
  operation: 'merge' | 'rebase';
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  parents: string[];
}

export interface GitLogResponse {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
}

export interface CommitFileEntry {
  path: string;
  previousPath?: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  changeType: 'A' | 'M' | 'D' | 'R' | 'C' | string;
}

export interface GitCommitFilesResponse {
  files: CommitFileEntry[];
}

export interface GetGitCommitDiffOptions {
  hash: string;
  path?: string;
  previousPath?: string;
  contextLines?: number;
}

export interface CommitFileDiffResponse {
  original: string;
  modified: string;
  isBinary: boolean;
}

export interface GitWorktreeTitleResult {
  title: string;
  branch: string;
}

export interface GitWorktreePinResult {
  pinned: boolean;
  branch: string;
}

export interface GitContributorWorktreeProvenance {
  kind: 'contributor-fork';
  revision: number;
  trust: 'untrusted';
  push: 'destination-selection-required';
  prunable?: boolean;
}

export class GitWorktreeRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly remoteName?: string;

  constructor(code: string, message: string, status: number, remoteName?: string) {
    super(message);
    this.name = 'GitWorktreeRequestError';
    this.code = code;
    this.status = status;
    this.remoteName = remoteName;
  }
}

export interface GitWorktreeBootstrapStatus {
  status: 'pending' | 'ready' | 'failed';
  phase?: 'directory-created' | 'git-ready' | 'setup-ready';
  error: string | null;
  errorCode?: GitNetworkOperationErrorCode;
  updatedAt: number;
  hydration?: GitCheckoutHydrationResult;
}

export interface CreateGitWorktreePayload {
  mode?: 'new' | 'existing';
  worktreeName?: string;
  name?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  startCommand?: string;
  createCommand?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  expectedRevision?: string;
  changeRequestSource?: GitChangeRequestSourceRequest;
  returnAfterDirectoryCreated?: boolean;
  taskTitle?: string;
  generatedBranchName?: string;
  generatedBranchPrefix?: string;
}

export interface GitChangeRequestSourceRequest {
  context: SourceControlReadContext;
  project: { id: string; owner: string; name: string };
  number: number;
  expectedHeadSha: string;
  requestedRemoteName: string;
}

export interface GitWorktreeCreateResult {
  head: string;
  name: string;
  branch: string;
  path: string;
  directoryCreated?: true;
  bootstrapStatus?: GitWorktreeBootstrapStatus;
  sourceFetchFailed?: true;
  sourceFetchReason?: 'access';
  branchBackup?: string;
  provenance?: GitContributorWorktreeProvenance;
}

export interface GitCheckoutTrustInspection {
  state: 'awaiting-trust';
  digest: string;
  actions: Array<{ kind: 'post-checkout-hook' | 'project-start-command' | 'setup-command'; label: string }>;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
  teardownCommand?: string;
}

export interface TeardownGitWorktreePayload {
  directory: string;
  teardownCommand: string;
}

export interface GitWorktreeSnapshotPayload {
  ref: string;
}

export interface GitWorktreeSnapshotResult {
  ref: string;
  commit: string;
  head: string;
}

export interface GitWorktreeArchive {
  id: string;
  ref: string;
  commit: string;
  head: string;
  path: string;
  branch: string;
  branchExists: boolean;
  title: string;
  archivedAt: number;
  sessionIds: string[];
}

export interface ArchiveGitWorktreePayload {
  directory: string;
  id: string;
  sessionIds: string[];
  title?: string;
}

export interface GitWorktreeArchiveRestoreResult {
  id: string;
  conflicts: boolean;
}

export interface DeleteGitWorktreeArchivePayload {
  id: string;
  deleteBranch?: boolean;
}

export interface GitDeleteBranchPayload {
  branch: string;
  force?: boolean;
}

export interface GitRemoveRemotePayload {
  remote: string;
}

export interface CreateGitCommitOptions {
  addAll?: boolean;
  files?: string[];
  stageFiles?: string[];
}

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
  file?: string;
  all?: boolean;
}

export interface GeneratedCommitMessage {
  subject: string;
  highlights: string[];
}

export interface GeneratedPullRequestDescription {
  title: string;
  body: string;
}

interface GitWorktreeAPI {
  list(directory: string): Promise<GitWorktreeInfo[]>;
  validate?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  bootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  preview?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  create?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  remove?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  teardown?(directory: string, payload: TeardownGitWorktreePayload): Promise<{ success: boolean }>;
  setTitle?(directory: string, title: string, by?: 'user' | 'agent', session?: string): Promise<GitWorktreeTitleResult>;
  setPinned?(directory: string, pinned: boolean, list?: string | null): Promise<GitWorktreePinResult>;
  snapshot?(directory: string, payload: GitWorktreeSnapshotPayload): Promise<GitWorktreeSnapshotResult>;
  archive?(directory: string, payload: ArchiveGitWorktreePayload): Promise<GitWorktreeArchive>;
  listArchives?(directory: string): Promise<GitWorktreeArchive[]>;
  restoreArchive?(directory: string, id: string): Promise<GitWorktreeArchiveRestoreResult>;
  deleteArchive?(directory: string, payload: DeleteGitWorktreeArchivePayload): Promise<{ id: string; branchDeleted: boolean }>;
}

export interface GitAPI {
  checkIsGitRepository(directory: string): Promise<boolean>;
  getGitStatus(directory: string, options?: { mode?: 'light'; fresh?: boolean }): Promise<GitStatus>;
  prefetchProjectStatuses?(directories: string[]): Promise<void>;
  getGitDiff?(directory: string, options: GetGitDiffOptions): Promise<GitPathDiffResponse>;
  getGitDiffs?(directory: string, options: GetGitDiffsOptions): Promise<GitPathDiffBatchEntry[]>;
  getGitFileDiff?(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse>;
  getGitRangeDiff?(directory: string, options: GetGitRangeDiffOptions): Promise<GitDiffResponse>;
  getGitRangeFiles?(directory: string, options: GetGitRangeFilesOptions): Promise<GitRangeFileEntry[]>;
  getBranchBase?(directory: string, branch: string): Promise<GitBranchBaseResponse>;
  revertGitFile(directory: string, filePath: string, options?: { scope?: 'all' | 'working' }): Promise<void>;
  stageGitFile(directory: string, filePath: string): Promise<void>;
  stageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  unstageGitFile(directory: string, filePath: string): Promise<void>;
  unstageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  stageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  unstageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  revertGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  isLinkedWorktree(directory: string): Promise<boolean>;
  getGitBranches(directory: string, options?: GitBranchListOptions): Promise<GitBranch>;
  getGitUnpushedBranchCounts(directory: string, branches: string[]): Promise<GitUnpushedBranchCounts>;
  deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }>;
  removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }>;
  generateCommitMessage?(directory: string, files: string[], options?: { zenModel?: string; providerId?: string; modelId?: string }): Promise<{ message: GeneratedCommitMessage }>;
  generatePullRequestDescription?(
    directory: string,
    payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
  ): Promise<GeneratedPullRequestDescription>;
  listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]>;
  validateGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  getGitWorktreeBootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  previewGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  createGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  deleteGitWorktree?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  createGitCommit?(directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitPush?(directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitPull?(directory: string, options?: GitPullOptions): Promise<GitPullResult>;
  gitFetch?(directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  planNetworkOperation(request: GitNetworkOperationRequest): Promise<GitNetworkOperationPlan>;
  issueContributorDestination(request: GitContributorDestinationRequest): Promise<GitContributorDestinationSelection>;
  listContributorDestinations(directory: string): Promise<GitContributorDestinationCandidates>;
  inspectCheckoutTrust(directory: string): Promise<GitCheckoutTrustInspection>;
  decideCheckoutTrust(directory: string, digest: string, decision: 'run' | 'skip'): Promise<{ state: string }>;
  executeNetworkOperation(operationId: string): Promise<GitNetworkOperation>;
  getNetworkOperation(operationId: string): Promise<GitNetworkOperation>;
  cancelNetworkOperation(operationId: string): Promise<GitNetworkOperation>;
  managedSshCredentials?(intent: GitManagedSshIntent): Promise<GitManagedSshResult>;
  configureTransportBinding?(intent: GitTransportBindingIntent): Promise<GitTransportBindingResult>;
  removeTransportBinding?(intent: GitTransportBindingRemovalIntent): Promise<GitTransportBindingRemovalResult>;
  configureAuxiliaryBinding?(intent: GitAuxiliaryBindingIntent): Promise<GitAuxiliaryBindingResult>;
  listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }>;
  countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }>;
  stashGitChanges(directory: string, options?: { message?: string }): Promise<{ success: boolean; created: boolean; message: string; output: string }>;
  applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  checkoutBranch?(directory: string, branch: string): Promise<{ success: boolean; branch: string }>;
  createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }>;
  renameBranch(directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }>;
  getGitLog?(directory: string, options?: GitLogOptions): Promise<GitLogResponse>;
  addChangeIdToHead?(directory: string, expectedHead: string): Promise<{ sha: string; changeId: string }>;
  getCommitFiles?(directory: string, hash: string): Promise<GitCommitFilesResponse>;
  getGitCommitDiff?(directory: string, options: GetGitCommitDiffOptions): Promise<GitDiffResponse>;
  getCommitFileDiff?(directory: string, hash: string, filePath: string, isBinary: boolean): Promise<CommitFileDiffResponse>;
  getCurrentGitIdentity?(directory: string): Promise<GitIdentitySummary | null>;
  hasLocalIdentity?(directory: string): Promise<boolean>;
  setGitIdentity?(directory: string, profileId: string): Promise<{ success: boolean; profile: GitIdentityProfile | null }>;
  getGitIdentities(): Promise<GitIdentityProfile[]>;
  createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile>;
  updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile>;
  deleteGitIdentity(id: string): Promise<void>;
  getGlobalGitIdentity?(): Promise<GitIdentitySummary | null>;
  getRemotes(directory: string): Promise<GitRemote[]>;
  rebase?(directory: string, options: { onto: string }): Promise<GitRebaseResult>;
  abortRebase?(directory: string): Promise<{ success: boolean }>;
  continueRebase?(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  merge?(directory: string, options: { branch: string }): Promise<GitMergeResult>;
  abortMerge?(directory: string): Promise<{ success: boolean }>;
  continueMerge?(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  checkoutCommit?(directory: string, hash: string): Promise<CheckoutCommitResponse>;
  cherryPick?(directory: string, hash: string): Promise<CherryPickResponse>;
  revertCommit?(directory: string, hash: string): Promise<RevertCommitResponse>;
  resetToCommit?(directory: string, hash: string, mode: 'soft' | 'mixed' | 'hard', force?: boolean): Promise<ResetToCommitResponse>;
  stash(directory: string, options?: { message?: string; includeUntracked?: boolean }): Promise<{ success: boolean }>;
  stashPop(directory: string): Promise<{ success: boolean }>;
  getConflictDetails?(directory: string): Promise<MergeConflictDetails>;
  validateWorktreeDirectory?(directory: string, worktreeRoot: string): Promise<{
    valid: boolean;
    insideWorktreeRoot: boolean;
    resolvedWorktreeRoot: string | null;
    resolvedCwd: string | null;
  }>;
  resolveRepositoryPrefix?(directory: string): Promise<string>;
  canonicalizeWorktreeState?(directory: string): Promise<{
    worktreeRoot: string | null;
    cwd: string | null;
    branch: string | null;
    headState: 'branch' | 'detached' | 'unborn';
    worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
    legacy: boolean;
    degraded: boolean;
    attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  }>;
  worktree?: GitWorktreeAPI;
}

export interface GitContributorDestinationRequest {
  directory: string;
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  provenanceRevision: number;
  remote: GitNetworkRemoteTarget;
  sourceRef: string;
  destinationRef: string;
  transportMode: 'managed';
}

export interface GitContributorDestinationSelection {
  selectionId: string;
  provenanceRevision: number;
  sourceSha: string;
  expiresInMs: number;
}

export type GitContributorDestinationClassification = 'contributor-fork' | 'own-fork' | 'bound-repository' | 'other';

export type GitContributorDestinationCandidates = { kind: 'ordinary' } | {
  kind: 'contributor';
  repositoryId: string;
  bindingRevision: number;
  configRevision: string;
  provenanceRevision: number;
  candidates: Array<{
    remote: GitNetworkRemoteTarget;
    transportMode: 'managed';
    classification: GitContributorDestinationClassification;
  }>;
};

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedTime?: number;
}

export interface DirectoryListResult {
  directory: string;
  entries: FileListEntry[];
}

export interface FileSearchQuery {
  directory: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
}

export interface FileSearchResult {
  path: string;
  score?: number;
  preview?: string[];
}

export interface FileContentSearchQuery {
  directory: string;
  query: string;
  regex: boolean;
  limit?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  signal?: AbortSignal;
}

export interface FileContentSearchMatch {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  text: string;
  ranges: Array<[number, number]>;
  cutStart: boolean;
}

export type FileContentSearchStop = 'limit' | 'deadline';

export type FileContentSearchOutcome =
  | { status: 'ok'; matches: FileContentSearchMatch[]; stopped: FileContentSearchStop | null }
  | { status: 'invalid-pattern'; message: string }
  | { status: 'unavailable' };

interface ListDirectoryOptions {
  respectGitignore?: boolean;
}

interface FileReadOptions {
  allowOutsideWorkspace?: boolean;
  outsideFileGrant?: string;
  optional?: boolean;
  directory?: string;
  fresh?: boolean;
}

export interface FilesAPI {
  listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryListResult>;
  search(payload: FileSearchQuery): Promise<FileSearchResult[]>;
  searchContents?(payload: FileContentSearchQuery): Promise<FileContentSearchOutcome>;
  createDirectory(path: string): Promise<{ success: boolean; path: string }>;
  statFile?(path: string, options?: FileReadOptions): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }>;
  readFile?(path: string, options?: FileReadOptions): Promise<{ content: string; path: string }>;
  readFileBinary?(path: string, options?: FileReadOptions): Promise<{ dataUrl: string; path: string }>;
  writeFile?(path: string, content: string): Promise<{ success: boolean; path: string }>;
  uploadFile?(path: string, file: Blob, options?: { overwrite?: boolean; directory?: string }): Promise<{ success: boolean; path: string }>;
  delete?(path: string): Promise<{ success: boolean }>;
  rename?(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }>;
  revealPath?(path: string): Promise<{ success: boolean }>;
  downloadFile?(path: string, options?: FileReadOptions): Promise<void>;
}

export interface ProjectEntry {
  id: string;
  path: string;
  label?: string;
  labelSource?: 'auto' | 'manual';
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultAgent?: string;
  defaultModel?: string;
  defaultVariant?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export type SettingsPayload = DesktopSettings;

export interface SettingsLoadResult {
  settings: SettingsPayload;
  source: 'desktop' | 'web';
}

export interface SettingsAPI {
  load(): Promise<SettingsLoadResult>;
  save(changes: Partial<SettingsPayload>, options?: { keepalive?: boolean }): Promise<SettingsPayload>;

  restartOpenCode?: () => Promise<{ restarted: boolean }>;
}

export interface DirectoryPermissionRequest {
  path: string;
}

interface DirectoryPermissionResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface StartAccessingResult {
  success: boolean;
  error?: string;
}

export interface PermissionsAPI {
  requestDirectoryAccess(request: DirectoryPermissionRequest): Promise<DirectoryPermissionResult>;
  startAccessingDirectory(path: string): Promise<StartAccessingResult>;
  stopAccessingDirectory(path: string): Promise<StartAccessingResult>;
}

export type { NotificationPayload };

export interface NotificationsAPI {
  notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean>;
  canNotify?: () => boolean | Promise<boolean>;
}

interface DiagnosticsAPI {
  downloadLogs(): Promise<{ fileName: string; content: string }>;
}

export interface EditorAPI {
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openDiff(
    original: string,
    modified: string,
    label?: string,
    options?: { line?: number; patch?: string; snapshot?: boolean },
  ): Promise<void>;
}

export interface VSCodeAPI {
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  openExternalUrl(url: string): Promise<void>;
  pickFiles?(options?: { extensions?: string[] }): Promise<unknown>;
  saveImage?(payload: unknown): Promise<unknown>;
  saveMarkdown?(payload: unknown): Promise<unknown>;
  addWorkspaceFolder?(path: string): Promise<Array<{ name: string; path: string }>>;
}

type GitHubRepoRef = {
  owner: string;
  repo: string;
  host?: string;
  url: string;
};

export type GitHubPullRequest = {
  isInMergeQueue?: boolean;
  mergeQueueEntry?: { state: string; position: number } | null;
  autoMergeRequest?: { enabledAt: string; mergeMethod: string } | null;
  number: number;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  base: string;
  head: string;
  headSha?: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};

type GitHubPullRequestHeadRepo = {
  owner: string;
  repo: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
};

export type RepositoryItemRef = RepositorySelector & { number: number; host?: string };

export type ProviderReadsRefreshScope = { item: RepositoryItemRef } | { lists: true };

export type ChangeRequestLiveSummary = RepositoryItemRef & {
  isInMergeQueue?: boolean;
  mergeQueueEntry?: { state: string; position: number } | null;
  autoMergeRequest?: { enabledAt: string; mergeMethod: string } | null;
  state: GitHubPullRequest['state'];
  draft: boolean;
  title: string;
  headSha?: string;
  base?: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  checks: CISummary | null;
};

export type IssueLiveSummary = RepositoryItemRef & {
  title: string;
  state: 'open' | 'completed' | 'not_planned';
};

export type DiscussionState = 'open' | DiscussionCloseReason;

export type DiscussionLiveSummary = RepositoryItemRef & {
  title: string;
  state: DiscussionState;
  answered: boolean | null;
};

export type RepositorySelector = {
  owner: string;
  repo: string;
};

export type RepositoryReferenceKind = 'issue' | 'pull' | 'discussion';

export type RepositoryReferenceState = 'open' | 'closed' | 'merged' | 'all' | 'unanswered';
export type RepositoryReferencePeople = 'any' | 'assigned' | 'created' | 'reviewRequested';
export type RepositoryReferenceFilter = {
  state: RepositoryReferenceState;
  people: RepositoryReferencePeople;
  labels: string[];
};

export type RepositoryReferenceQuery = {
  kind: RepositoryReferenceKind;
  state?: RepositoryReferenceState;
  people?: RepositoryReferencePeople;
  labels?: string[];
  query?: string;
  cursor?: string | null;
};

type RepositoryReferenceCommon = {
  number: number;
  title: string;
  url: string;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  author: { login: string; avatarUrl?: string } | null;
  labels: Label[];
  commentCount: number;
  sourceRepo: RepositorySelector & { source: string };
  linked?: true;
  projectId?: string;
  provider: SourceControlProvider;
};

export type RepositoryIssueReference = RepositoryReferenceCommon & {
  kind: 'issue';
  state: IssueLiveSummary['state'];
};

export type RepositoryDiscussionReference = RepositoryReferenceCommon & {
  kind: 'discussion';
  state: DiscussionState;
  answered: boolean | null;
  upvotes: number;
  locked: boolean;
  category: { name: string; emoji: string | null; answerable: boolean };
};

export type RepositoryChangeRequestReference = RepositoryReferenceCommon & {
  kind: 'pull';
  state: GitHubPullRequest['state'];
  draft: boolean;
  head: string;
  base: string;
  headSha: string;
  headRepo: GitHubPullRequestHeadRepo | null;
  workInProgress?: boolean;
  private?: boolean;
  topic?: string;
  revisionNumber?: number;
};

export type { RepositoryReferenceComment, ReviewCommentExcerpt } from './repositoryReferenceTypes';

export type { RepositoryReferenceDetail } from './repository-reference-detail';

export type RepositoryReferenceDetailResult =
  | { connected: false }
  | { connected: true; detail: RepositoryReferenceDetail | null };

export type RepositoryReference = RepositoryIssueReference | RepositoryChangeRequestReference | RepositoryDiscussionReference;

export type ChangeRequestListStatus = RepositoryItemRef & {
  checks: CISummary | null;
  mergeable: boolean | null;
  mergeableState: string | null;
};

export type ChangeRequestListStatusesResult =
  | { connected: false }
  | { connected: true; statuses: ChangeRequestListStatus[] };

export type RepositoryReferencePage =
  | { connected: false }
  | {
      connected: true;
      repo: GitHubRepoRef | null;
      items: RepositoryReference[];
      cursor: string | null;
      hasMore: boolean;
      total: number;
    };

export type RepositoryReferencesAcrossSkip = 'no-repo' | 'disconnected' | 'invalid-context' | 'error';

export type RepositoryReferencesAcrossResult = {
  items: Array<RepositoryReference & { directory: string }>;
  cursor: string | null;
  hasMore: boolean;
  total: number;
  repositories: Array<
    | { directory: string; status: 'included'; repo: GitHubRepoRef }
    | { directory: string; status: RepositoryReferencesAcrossSkip }
  >;
};

export interface SourceControlAPI extends SourceControlBranchWrites, SourceControlReviewWrites {
  providers(): Promise<SourceControlProviderDescriptor[]>;
  repositoryContext(directory: string): Promise<SourceControlRepositoryContext>;
  repositoryBinding(directory: string): Promise<SourceControlBindingRead>;
  resetRepositoryBinding(intent: SourceControlRepositoryBindingResetIntent): Promise<SourceControlBindingRead>;
  repositoryProviderBindingMutate(input: SourceControlProviderBindingMutation): Promise<SourceControlBindingRead>;
  authInstances(): Promise<SourceControlIdentity[]>;
  capabilities(identity: SourceControlIdentity): Promise<SourceControlCapabilities>;
  authStatus(identity: SourceControlIdentity): Promise<SourceControlAuthStatus>;
  authStart(identity: SourceControlIdentity): Promise<SourceControlDeviceFlowStart>;
  authComplete(identity: SourceControlIdentity, flowId: string): Promise<SourceControlDeviceFlowComplete>;
  authSetToken(identity: SourceControlIdentity, token: string, options?: { username?: string }): Promise<SourceControlAuthStatus>;
  authSetSshUrl(identity: SourceControlIdentity, sshUrl: string | null): Promise<{ sshUrl: string | null }>;
  setInstanceAliases(identity: SourceControlIdentity, aliases: string[]): Promise<{ aliases: string[] }>;
  authDisconnect(identity: SourceControlIdentity, accountId: string): Promise<{ removed: boolean }>;
  authActivate(identity: SourceControlIdentity, accountId: string): Promise<SourceControlAuthStatus>;
  authSetCliDisabled(identity: SourceControlIdentity, disabled: boolean): Promise<{ disabled: boolean }>;

  changeRequestStatus(
    context: SourceControlReadContext,
    branch: string,
    options?: { force?: boolean },
  ): Promise<ChangeRequestStatus>;
  changeRequestCreate(payload: CreateChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlCreateMutationResult>>;
  changeRequestUpdate(payload: UpdateChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueUpdate(payload: UpdateIssueInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestMerge(payload: MergeChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlMergeMutationResult>>;
  changeRequestReady(payload: ReadyChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlReadyMutationResult>>;
  changeRequestDraft(payload: DraftChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlDraftMutationResult>>;
  changeRequestComment(payload: CommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestCommentUpdate(payload: CommentUpdateInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestCommentDelete(payload: CommentDeleteInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestStartThread(payload: CommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestReplyToThread(payload: ThreadReplyInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestResolveThread(payload: ThreadResolveInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestReview(payload: ReviewChangeRequestInput): Promise<SourceControlMutationReceipt<SourceControlReviewMutationResult>>;
  changeRequestReviewState(context: SourceControlReadContext, ref: { owner: string; repo: string; number: number }): Promise<ChangeRequestReviewStateResult>;
  issueComment(payload: CommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueCommentUpdate(payload: CommentUpdateInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueCommentDelete(payload: CommentDeleteInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestSetState(payload: SetStateInput): Promise<SourceControlMutationReceipt<SourceControlStateMutationResult>>;
  issueSetState(payload: SetIssueStateInput): Promise<SourceControlMutationReceipt<SourceControlStateMutationResult>>;
  changeRequestSetLabels(payload: SetLabelsInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueSetLabels(payload: SetLabelsInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionComment(payload: DiscussionCommentInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionSetState(payload: SetDiscussionStateInput): Promise<SourceControlMutationReceipt<SourceControlStateMutationResult>>;
  discussionSetAnswer(payload: SetDiscussionAnswerInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionUpdate(payload: UpdateDiscussionInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionSetLabels(payload: SetLabelsInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionCommentUpdate(payload: CommentUpdateInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  discussionCommentDelete(payload: CommentDeleteInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  changeRequestSetReviewers(payload: SetReviewersInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  issueSetAssignees(payload: SetAssigneesInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>>;
  refreshProviderReads(identity: SourceControlIdentity, scope: ProviderReadsRefreshScope): Promise<void>;
  referenceLabels(context: SourceControlReadContext, project: RepositorySelector): Promise<Label[]>;
  referenceReviewers(context: SourceControlReadContext, project: RepositorySelector, role?: 'assignee' | 'reviewer'): Promise<RepositoryReferenceReviewer[]>;
  changeRequestsList(
    context: SourceControlReadContext,
    options?: { page?: number; query?: string; state?: RepositoryReferenceState; people?: RepositoryReferencePeople; labels?: string[] },
  ): Promise<PageResult<ChangeRequest>>;
  changeRequestContext(
    context: SourceControlReadContext,
    number: number,
    options?: {
      includeDiff?: boolean;
      includeCIDetails?: boolean;
      includeTimeline?: boolean;
      includeReferences?: boolean;
      project?: { owner: string; name: string };
      revision?: string;
    },
  ): Promise<ChangeRequestContext>;

  issuesList(
    context: SourceControlReadContext,
    options?: { page?: number; query?: string; state?: RepositoryReferenceState; people?: RepositoryReferencePeople; labels?: string[] },
  ): Promise<PageResult<Issue>>;
  issueGet(
    context: SourceControlReadContext,
    number: number,
    project?: { owner: string; name: string },
    options?: { includeReferences?: boolean },
  ): Promise<Issue | null>;
  issueComments(
    context: SourceControlReadContext,
    number: number,
    project?: { owner: string; name: string },
  ): Promise<IssueComment[]>;
  projectUpstream(context: SourceControlReadContext): Promise<ProjectUpstream>;
  projectBranches(context: SourceControlReadContext, owner: string, project: string): Promise<string[]>;

  references(context: SourceControlReadContext, query: RepositoryReferenceQuery): Promise<RepositoryReferencePage>;
  referencesAcross?(contexts: SourceControlReadContext[], query: RepositoryReferenceQuery): Promise<RepositoryReferencesAcrossResult>;
  referenceDetail(context: SourceControlReadContext, ref: RepositoryItemRef & { kind?: 'discussion' }, options?: { includeReferences?: boolean }): Promise<RepositoryReferenceDetailResult>;
  changeRequestListStatuses(context: SourceControlReadContext, refs: RepositoryItemRef[]): Promise<ChangeRequestListStatusesResult>;
}

export interface RemoteClientRecord {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt?: string | null;
  clientKind?: string | null;
  authMethod?: string | null;
  pairingId?: string | null;
  deviceName?: string | null;
  devicePlatform?: string | null;
  usesRelay?: boolean;
  lastTransport?: 'relay' | 'direct' | null;
}

export interface PendingPairingRecord {
  id: string;
  label?: string;
  fingerprint?: string | null;
  expiresAt?: string;
  usesRelay?: boolean;
}

export interface RemoteClientCreateResult {
  client: RemoteClientRecord;
  token: string;
}

export interface RemoteClientRevokeResult {
  revoked: boolean;
  client?: RemoteClientRecord;
}

export interface RemoteClientPurgeRevokedResult {
  purged: number;
}

export interface PairingSessionCreateResult {
  pairing: {
    id: string;
    label?: string;
    fingerprint?: string | null;
    expiresAt?: string;
    secret: string;
  };
  server: {
    label: string;
    candidates: Array<Record<string, unknown>>;
  };
}

export interface ClientAuthAPI {
  listClients(): Promise<RemoteClientRecord[]>;
  createClient(input?: { label?: string }): Promise<RemoteClientCreateResult>;
  createPairingSession(input?: {
    label?: string;
    allowedClientKinds?: Array<'mobile' | 'desktop'>;
    serverUrl?: string;
    includeRelay?: boolean;
    includeDirect?: boolean;
  }): Promise<PairingSessionCreateResult>;
  purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult>;
  revokeClient(id: string): Promise<RemoteClientRevokeResult>;
  listPendingPairings(): Promise<PendingPairingRecord[]>;
  cancelPairing(id: string): Promise<{ cancelled: boolean }>;
  getPairingTransports(): Promise<{ local: string | null; lan: string | null; relayAvailable: boolean }>;
  getRelayHostStatus(): Promise<RelayHostStatus>;
  resetRelayIdentity(): Promise<RelayHostStatus>;
}

export interface RelayHostStatus {
  identityConflict: boolean;
}

export interface ClipboardAPI {
  selection: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
}

export interface RuntimeAPIs {
  themeFiles?: {
    pick(): Promise<{ status: 'unsupported' } | { status: 'picked'; file: { name: string; size: number; text: string } | null }>;
  };
  clipboard?: ClipboardAPI;
  runtime: RuntimeDescriptor;
  terminal: TerminalAPI;
  git: GitAPI;
  files: FilesAPI;
  settings: SettingsAPI;
  permissions: PermissionsAPI;
  notifications: NotificationsAPI;
  sourceControl: SourceControlAPI;
  trackers?: TrackerAPI;
  push?: PushAPI;
  diagnostics?: DiagnosticsAPI;
  clientAuth?: ClientAuthAPI;
  editor?: EditorAPI;
  vscode?: VSCodeAPI;
  worktrees?: WorktreeMetadata[];
}

export type RuntimeAPISelector<TValue> = (apis: RuntimeAPIs) => TValue;

type SkillsCatalogSourceId = string;

type SkillsCatalogSourceType = 'github';

export interface SkillsCatalogSource {
  id: SkillsCatalogSourceId;
  label: string;
  description?: string;
  source: string;
  defaultSubpath?: string;
  sourceType?: SkillsCatalogSourceType;
  stars?: number | null;
  repoUpdatedAt?: string | null;
}

interface SkillsCatalogItemInstalledBadge {
  isInstalled: boolean;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents' | 'claude';
}

export interface SkillsCatalogItem {
  sourceId: SkillsCatalogSourceId;
  repoSource: string;
  repoSubpath?: string;
  gitIdentityId?: string;
  skillDir: string;
  skillName: string;
  frontmatterName?: string;
  description?: string;
  installable: boolean;
  warnings?: string[];
  installed?: SkillsCatalogItemInstalledBadge;
}

export interface SkillsCatalogResponse {
  ok: boolean;
  sources?: SkillsCatalogSource[];
  itemsBySource?: Record<SkillsCatalogSourceId, SkillsCatalogItem[]>;
  error?: { kind: string; message: string };
}

export interface SkillsCatalogSourceResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  error?: { kind: string; message: string };
}

export interface SkillsRepoScanRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

type SkillsRepoScanError =
  | { kind: 'authRequired'; message: string; sshOnly: true; identities?: Array<{ id: string; name: string }> }
  | { kind: 'invalidSource'; message: string }
  | { kind: 'gitUnavailable'; message: string }
  | { kind: 'networkError'; message: string }
  | { kind: 'unknown'; message: string };

export interface SkillsRepoScanResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  error?: SkillsRepoScanError;
}

interface SkillsInstallSelection {
  skillDir: string;
}

export interface SkillsInstallRequest {
  source: string;
  subpath?: string;
  sourceId?: string;
  gitIdentityId?: string;
  scope: 'user' | 'project';
  targetSource?: 'opencode' | 'agents';
  selections: SkillsInstallSelection[];
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}

export type SkillsInstallError = SkillsRepoScanError | {
  kind: 'conflicts';
  message: string;
  conflicts: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
};

export interface SkillsInstallResponse {
  ok: boolean;
  installed?: Array<{ skillName: string; skillDir?: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
  skipped?: Array<{ skillName: string; reason: string }>;
  error?: SkillsInstallError;
  requiresReload?: boolean;
  requiresManualRestart?: boolean;
  reloadFailed?: boolean;
  warning?: string;
  message?: string;
  reloadDelayMs?: number;
}
