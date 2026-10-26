/**
 * VS Code Git Extension API type definitions
 * Based on the vscode.git extension API
 * @see https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */

import type { Uri, Event, Disposable } from 'vscode';

export interface Git {
  readonly path: string;
}

export interface InputBox {
  value: string;
}

export const enum ForcePushMode {
  Force,
  ForceWithLease,
  ForceWithLeaseIfIncludes,
}

export const enum RefType {
  Head,
  RemoteHead,
  Tag,
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface UpstreamRef {
  readonly remote: string;
  readonly name: string;
}

export interface Branch extends Ref {
  readonly upstream?: UpstreamRef;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
}

export interface Submodule {
  readonly name: string;
  readonly path: string;
  readonly url: string;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export const enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,
  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED,
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: Status;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly refs: Ref[];
  readonly remotes: Remote[];
  readonly submodules: Submodule[];
  readonly rebaseCommit: Commit | undefined;
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly onDidChange: Event<void>;
}

export interface RepositoryUIState {
  readonly selected: boolean;
  readonly onDidChange: Event<void>;
}

export interface CommitOptions {
  all?: boolean | 'tracked';
  amend?: boolean;
  signoff?: boolean;
  signCommit?: boolean;
  empty?: boolean;
  noVerify?: boolean;
  requireUserConfig?: boolean;
  useEditor?: boolean;
  verbose?: boolean;
  postCommitCommand?: string | null;
}

export interface FetchOptions {
  remote?: string;
  ref?: string;
  all?: boolean;
  prune?: boolean;
  depth?: number;
}

export interface BranchQuery {
  readonly remote?: boolean;
  readonly pattern?: string;
  readonly count?: number;
  readonly contains?: string;
  readonly sort?: 'alphabetically' | 'committerdate';
}

export interface LogOptions {
  readonly maxEntries?: number;
  readonly path?: string;
  readonly reverse?: boolean;
  readonly sortByAuthorDate?: boolean;
  readonly shortStats?: boolean;
  readonly range?: string;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;
  readonly ui: RepositoryUIState;

  getConfigs(): Promise<{ key: string; value: string }[]>;
  getConfig(key: string): Promise<string>;
  setConfig(key: string, value: string): Promise<string>;
  getGlobalConfig(key: string): Promise<string>;

  getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number }>;
  detectObjectType(object: string): Promise<{ mimetype: string; encoding?: string }>;
  buffer(ref: string, path: string): Promise<Buffer>;
  show(ref: string, path: string): Promise<string>;
  getCommit(ref: string): Promise<Commit>;

  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;

  apply(patch: string, reverse?: boolean): Promise<void>;
  diff(cached?: boolean): Promise<string>;
  diffWithHEAD(): Promise<Change[]>;
  diffWithHEAD(path: string): Promise<string>;
  diffWith(ref: string): Promise<Change[]>;
  diffWith(ref: string, path: string): Promise<string>;
  diffIndexWithHEAD(): Promise<Change[]>;
  diffIndexWithHEAD(path: string): Promise<string>;
  diffIndexWith(ref: string): Promise<Change[]>;
  diffIndexWith(ref: string, path: string): Promise<string>;
  diffBlobs(object1: string, object2: string): Promise<string>;
  diffBetween(ref1: string, ref2: string): Promise<Change[]>;
  diffBetween(ref1: string, ref2: string, path: string): Promise<string>;

  hashObject(data: string): Promise<string>;

  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  getBranch(name: string): Promise<Branch>;
  getBranches(query: BranchQuery): Promise<Ref[]>;
  getBranchBase(name: string): Promise<Branch | undefined>;
  setBranchUpstream(name: string, upstream: string): Promise<void>;

  getRefs(query: { contains?: string; count?: number; pattern?: string; sort?: 'alphabetically' | 'committerdate' }): Promise<Ref[]>;

  getMergeBase(ref1: string, ref2: string): Promise<string>;

  tag(name: string, upstream: string): Promise<void>;
  deleteTag(name: string): Promise<void>;

  status(): Promise<void>;
  checkout(treeish: string): Promise<void>;

  addRemote(name: string, url: string): Promise<void>;
  removeRemote(name: string): Promise<void>;
  renameRemote(name: string, newName: string): Promise<void>;

  fetch(options?: FetchOptions): Promise<void>;
  fetch(remote?: string, ref?: string, depth?: number): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>;

  blame(path: string): Promise<string>;
  log(options?: LogOptions): Promise<Commit[]>;

  commit(message: string, opts?: CommitOptions): Promise<void>;
}

export interface RemoteSource {
  readonly name: string;
  readonly description?: string;
  readonly url: string | string[];
}

export interface RemoteSourceProvider {
  readonly name: string;
  readonly icon?: string;
  readonly supportsQuery?: boolean;
  getRemoteSources(query?: string): Promise<RemoteSource[]>;
  getBranches?(url: string): Promise<string[]>;
  publishRepository?(repository: Repository): Promise<void>;
}

export interface RemoteSourcePublisher {
  readonly name: string;
  readonly icon?: string;
  publishRepository(repository: Repository): Promise<void>;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

export interface CredentialsProvider {
  getCredentials(host: Uri): Promise<Credentials | undefined>;
}

export interface PostCommitCommandsProvider {
  getCommands(repository: Repository): Promise<Array<{ command: string; title: string; tooltip?: string }>>;
}

export interface PushErrorHandler {
  handlePushError(repository: Repository, remote: Remote, refspec: string, error: Error & { gitErrorCode?: string }): Promise<boolean>;
}

export interface BranchProtection {
  readonly remote: string;
  readonly rules: BranchProtectionRule[];
}

export interface BranchProtectionRule {
  readonly include?: string[];
  readonly exclude?: string[];
}

export interface BranchProtectionProvider {
  onDidChangeBranchProtection: Event<Uri>;
  provideBranchProtection(): Promise<BranchProtection[]>;
}

export type APIState = 'uninitialized' | 'initialized';

export interface PublishEvent {
  repository: Repository;
  branch?: string;
}

export interface API {
  readonly state: APIState;
  readonly onDidChangeState: Event<APIState>;
  readonly onDidPublish: Event<PublishEvent>;
  readonly git: Git;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;

  toGitUri(uri: Uri, ref: string): Uri;
  getRepository(uri: Uri): Repository | null;
  init(root: Uri): Promise<Repository | null>;
  openRepository(root: Uri): Promise<Repository | null>;
  registerRemoteSourceProvider(provider: RemoteSourceProvider): Disposable;
  registerRemoteSourcePublisher(publisher: RemoteSourcePublisher): Disposable;
  registerCredentialsProvider(provider: CredentialsProvider): Disposable;
  registerPostCommitCommandsProvider(provider: PostCommitCommandsProvider): Disposable;
  registerPushErrorHandler(handler: PushErrorHandler): Disposable;
  registerBranchProtectionProvider(root: Uri, provider: BranchProtectionProvider): Disposable;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}

export const enum GitErrorCodes {
  BadConfigFile = 'BadConfigFile',
  AuthenticationFailed = 'AuthenticationFailed',
  NoUserNameConfigured = 'NoUserNameConfigured',
  NoUserEmailConfigured = 'NoUserEmailConfigured',
  NoRemoteRepositorySpecified = 'NoRemoteRepositorySpecified',
  NotAGitRepository = 'NotAGitRepository',
  NotAtRepositoryRoot = 'NotAtRepositoryRoot',
  Conflict = 'Conflict',
  StashConflict = 'StashConflict',
  UnmergedChanges = 'UnmergedChanges',
  PushRejected = 'PushRejected',
  RemoteConnectionError = 'RemoteConnectionError',
  DirtyWorkTree = 'DirtyWorkTree',
  CantOpenResource = 'CantOpenResource',
  GitNotFound = 'GitNotFound',
  CantCreatePipe = 'CantCreatePipe',
  PermissionDenied = 'PermissionDenied',
  CantAccessRemote = 'CantAccessRemote',
  RepositoryNotFound = 'RepositoryNotFound',
  RepositoryIsLocked = 'RepositoryIsLocked',
  BranchNotFullyMerged = 'BranchNotFullyMerged',
  NoRemoteReference = 'NoRemoteReference',
  InvalidBranchName = 'InvalidBranchName',
  BranchAlreadyExists = 'BranchAlreadyExists',
  NoLocalChanges = 'NoLocalChanges',
  NoStashFound = 'NoStashFound',
  LocalChangesOverwritten = 'LocalChangesOverwritten',
  NoUpstreamBranch = 'NoUpstreamBranch',
  IsInSubmodule = 'IsInSubmodule',
  WrongCase = 'WrongCase',
  CantLockRef = 'CantLockRef',
  CantRebaseMultipleBranches = 'CantRebaseMultipleBranches',
  PatchDoesNotApply = 'PatchDoesNotApply',
  NoPathFound = 'NoPathFound',
  UnknownPath = 'UnknownPath',
  EmptyCommitMessage = 'EmptyCommitMessage',
  BranchFastForwardRejected = 'BranchFastForwardRejected',
  TagConflict = 'TagConflict',
}
