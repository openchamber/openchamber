import type { WorktreeMetadata } from '@/types/worktree';

export type RuntimePlatform = 'web' | 'desktop' | 'vscode';

export interface RuntimeDescriptor {
  platform: RuntimePlatform;

  isDesktop: boolean;

  isVSCode: boolean;

  label?: string;
}

export interface ApiError {
  message: string;
  code?: string;
  cause?: unknown;
}

export interface Subscription {

  close: () => void;
}

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  capabilities?: {
    input?: {
      preferred?: 'ws' | 'http';
      transports?: Array<'ws' | 'http'>;
      ws?: {
        path: string;
        v?: number;
        enc?: string;
      };
    };
  };
}

export interface TerminalStreamEvent {
  type: 'connected' | 'data' | 'exit' | 'reconnecting';
  data?: string;
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;

  runtime?: 'node' | 'bun';
  ptyBackend?: string;
}

export interface CreateTerminalOptions {
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface TerminalStreamOptions {
  retry?: Partial<RetryPolicy>;
  connectionTimeoutMs?: number;
}

export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: Error, fatal?: boolean) => void;
}

export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

export interface TerminalAPI {
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers, options?: TerminalStreamOptions): Subscription;
  sendInput(sessionId: string, input: string): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  close(sessionId: string): Promise<void>;
  restartSession?(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
}

export interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitMergeInProgress {
  /** Short SHA of MERGE_HEAD */
  head: string;
  /** First line of MERGE_MSG */
  message: string;
}

export interface GitRebaseInProgress {
  /** Branch name being rebased */
  headName: string;
  /** Short SHA of the onto commit */
  onto: string;
}

export interface GitStatus {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  isClean: boolean;
  diffStats?: Record<string, { insertions: number; deletions: number }>;
  /** Present when a merge is in progress with conflicts */
  mergeInProgress?: GitMergeInProgress | null;
  /** Present when a rebase is in progress */
  rebaseInProgress?: GitRebaseInProgress | null;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GetGitDiffOptions {
  path: string;
  staged?: boolean;
  contextLines?: number;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

export interface GetGitFileDiffOptions {
  path: string;
  staged?: boolean;
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

export interface GitBranch {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
}

export interface GitCommitSummary {
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

export interface GitRebaseResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface MergeConflictDetails {
  /** Git status --porcelain output showing current state */
  statusPorcelain: string;
  /** List of unmerged file paths */
  unmergedFiles: string[];
  /** Git diff output showing current conflict state */
  diff: string;
  /** Information about MERGE_HEAD or REBASE_HEAD */
  headInfo: string;
  /** The operation type: 'merge' or 'rebase' */
  operation: 'merge' | 'rebase';
}

export type GitIdentityAuthType = 'ssh' | 'token';

export interface GitIdentityProfile {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: GitIdentityAuthType;
  sshKey?: string | null;
  host?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface DiscoveredGitCredential {
  host: string;
  username: string;
}

export interface GitIdentitySummary {
  userName: string | null;
  userEmail: string | null;
  sshCommand: string | null;
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
}

export interface GitLogResponse {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
}

export interface CommitFileEntry {
  path: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  changeType: 'A' | 'M' | 'D' | 'R' | 'C' | string;
}

export interface GitCommitFilesResponse {
  files: CommitFileEntry[];
}

export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
}

export interface GitWorktreeValidationError {
  code: string;
  message: string;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: GitWorktreeValidationError[];
  resolved?: {
    mode?: 'new' | 'existing';
    localBranch?: string | null;
  };
}

export interface CreateGitWorktreePayload {
  mode?: 'new' | 'existing';
  /** Worktree folder name (falls back to OpenCode name generation when omitted). */
  worktreeName?: string;
  /** Backward-compatible alias for worktreeName. */
  name?: string;
  /** New local branch name for mode=new. */
  branchName?: string;
  /** Existing local/remote branch for mode=existing. */
  existingBranch?: string;
  /** Start ref for mode=new (local/remote branch or commit SHA). */
  startRef?: string;
  /** Additional startup script to run after project startup script. */
  startCommand?: string;
  /** Configure upstream tracking for the created/attached local branch. */
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  /** Optional remote provisioning (used for fork PR workflows). */
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
}

export interface GitWorktreeCreateResult {
  head: string;
  name: string;
  branch: string;
  path: string;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
}

export interface GitDeleteBranchPayload {
  branch: string;
  force?: boolean;
}

export interface GitDeleteRemoteBranchPayload {
  branch: string;
  remote?: string;
}

export interface CreateGitCommitOptions {
  addAll?: boolean;
  files?: string[];
}

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
  file?: string;
}

export interface GeneratedCommitMessage {
  subject: string;
  highlights: string[];
}

export interface GeneratedPullRequestDescription {
  title: string;
  body: string;
}

export interface GitWorktreeAPI {
  list(directory: string): Promise<GitWorktreeInfo[]>;
  validate?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  create?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  remove?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
}

export interface GitAPI {
  checkIsGitRepository(directory: string): Promise<boolean>;
  getGitStatus(directory: string): Promise<GitStatus>;
  getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse>;
  getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse>;
  revertGitFile(directory: string, filePath: string): Promise<void>;
  isLinkedWorktree(directory: string): Promise<boolean>;
  getGitBranches(directory: string): Promise<GitBranch>;
  deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }>;
  deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }>;
  generateCommitMessage(directory: string, files: string[], options?: { zenModel?: string }): Promise<{ message: GeneratedCommitMessage }>;
  generatePullRequestDescription(
    directory: string,
    payload: { base: string; head: string; context?: string; zenModel?: string }
  ): Promise<GeneratedPullRequestDescription>;
  listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]>;
  validateGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  createGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  deleteGitWorktree?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  createGitCommit(directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitPush(directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitPull(directory: string, options?: { remote?: string; branch?: string }): Promise<GitPullResult>;
  gitFetch(directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }>;
  createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }>;
  renameBranch(directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }>;
  getGitLog(directory: string, options?: GitLogOptions): Promise<GitLogResponse>;
  getCommitFiles(directory: string, hash: string): Promise<GitCommitFilesResponse>;
  getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null>;
  hasLocalIdentity?(directory: string): Promise<boolean>;
  setGitIdentity(directory: string, profileId: string): Promise<{ success: boolean; profile: GitIdentityProfile }>;
  getGitIdentities(): Promise<GitIdentityProfile[]>;
  createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile>;
  updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile>;
  deleteGitIdentity(id: string): Promise<void>;
  discoverGitCredentials?(): Promise<DiscoveredGitCredential[]>;
  getGlobalGitIdentity?(): Promise<GitIdentitySummary | null>;
  getRemoteUrl?(directory: string, remote?: string): Promise<string | null>;
  getRemotes(directory: string): Promise<GitRemote[]>;
  rebase(directory: string, options: { onto: string }): Promise<GitRebaseResult>;
  abortRebase(directory: string): Promise<{ success: boolean }>;
  continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  merge(directory: string, options: { branch: string }): Promise<GitMergeResult>;
  abortMerge(directory: string): Promise<{ success: boolean }>;
  continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  stash(directory: string, options?: { message?: string; includeUntracked?: boolean }): Promise<{ success: boolean }>;
  stashPop(directory: string): Promise<{ success: boolean }>;
  getConflictDetails(directory: string): Promise<MergeConflictDetails>;
  worktree?: GitWorktreeAPI;
}

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
}

export interface FileSearchResult {
  path: string;
  score?: number;
  preview?: string[];
}

export interface CommandExecResult {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface ListDirectoryOptions {
  respectGitignore?: boolean;
}

export interface FilesAPI {
  listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryListResult>;
  search(payload: FileSearchQuery): Promise<FileSearchResult[]>;
  createDirectory(path: string): Promise<{ success: boolean; path: string }>;
  readFile?(path: string): Promise<{ content: string; path: string }>;
  readFileBinary?(path: string): Promise<{ dataUrl: string; path: string }>;
  writeFile?(path: string, content: string): Promise<{ success: boolean; path: string }>;
  delete?(path: string): Promise<{ success: boolean }>;
  rename?(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }>;
  revealPath?(path: string): Promise<{ success: boolean }>;
  execCommands?(commands: string[], cwd: string): Promise<{ success: boolean; results: CommandExecResult[] }>;
}

export interface ProjectEntry {
  id: string;
  path: string;
  label?: string;
  icon?: string | null;
  color?: string | null;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export interface SettingsPayload {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  opencodeBinary?: string;
  projects?: ProjectEntry[];
  activeProjectId?: string;
  approvedDirectories?: string[];
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showReasoningTraces?: boolean;
  showTextJustificationActivity?: boolean;
  showDeletionDialog?: boolean;
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  autoDeleteEnabled?: boolean;
  autoDeleteAfterDays?: number;
  queueModeEnabled?: boolean;
  gitmojiEnabled?: boolean;
  toolCallExpansion?: 'collapsed' | 'activity' | 'detailed';
  fontSize?: number;
  terminalFontSize?: number;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  diffViewMode?: 'single' | 'stacked';
  directoryShowHidden?: boolean;
  filesViewShowGitignored?: boolean;
  openInAppId?: string;

  [key: string]: unknown;
}

export interface SettingsLoadResult {
  settings: SettingsPayload;
  source: 'desktop' | 'web';
}

export interface SettingsAPI {
  load(): Promise<SettingsLoadResult>;
  save(changes: Partial<SettingsPayload>): Promise<SettingsPayload>;

  restartOpenCode?: () => Promise<{ restarted: boolean }>;
}

export interface DirectoryPermissionRequest {
  path: string;
}

export interface DirectoryPermissionResult {
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

export interface NotificationPayload {
  title?: string;
  body?: string;

  tag?: string;
}

export interface NotificationsAPI {
  notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean>;
  canNotify?: () => boolean | Promise<boolean>;
}

export interface DiagnosticsAPI {
  downloadLogs(): Promise<{ fileName: string; content: string }>;
}

export interface ToolsAPI {

  getAvailableTools(): Promise<string[]>;
}

export interface EditorAPI {
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openDiff(original: string, modified: string, label?: string): Promise<void>;
}

export interface VSCodeAPI {
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  openAgentManager(): Promise<void>;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  origin?: string;
}

export interface PushUnsubscribePayload {
  endpoint: string;
}

export interface PushAPI {
  getVapidPublicKey(): Promise<{ publicKey: string } | null>;
  subscribe(payload: PushSubscribePayload): Promise<{ ok: true } | null>;
  unsubscribe(payload: PushUnsubscribePayload): Promise<{ ok: true } | null>;
  setVisibility(payload: { visible: boolean }): Promise<{ ok: true } | null>;
}

export type GitHubUserSummary = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

export type GitHubRepoRef = {
  owner: string;
  repo: string;
  url: string;
};

export type GitHubChecksSummary = {
  state: 'success' | 'failure' | 'pending' | 'unknown';
  total: number;
  success: number;
  failure: number;
  pending: number;
};

export type GitHubCheckRun = {
  id?: number;
  name: string;
  app?: {
    name?: string;
    slug?: string;
  };
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
  job?: {
    runId?: number;
    jobId?: number;
    url?: string;
    name?: string;
    conclusion?: string | null;
    steps?: Array<{
      name: string;
      status?: string;
      conclusion?: string | null;
      number?: number;
      startedAt?: string;
      completedAt?: string;
    }>;
  };
  annotations?: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    level?: string;
    message: string;
    title?: string;
    rawDetails?: string;
  }>;
};

export type GitHubPullRequest = {
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

export type GitHubPullRequestHeadRepo = {
  owner: string;
  repo: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
};

export type GitHubPullRequestSummary = GitHubPullRequest & {
  author?: GitHubUserSummary | null;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  headLabel?: string;
  headRepo?: GitHubPullRequestHeadRepo | null;
};

export type GitHubPullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

export type GitHubPullRequestReviewComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  path?: string;
  line?: number | null;
  position?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubPullRequestsListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  prs?: GitHubPullRequestSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubPullRequestContextResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  pr?: GitHubPullRequestSummary | null;
  issueComments?: GitHubIssueComment[];
  reviewComments?: GitHubPullRequestReviewComment[];
  files?: GitHubPullRequestFile[];
  diff?: string;
  checks?: GitHubChecksSummary | null;
  checkRuns?: GitHubCheckRun[];
};

export type GitHubPullRequestStatus = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  branch?: string;
  pr?: GitHubPullRequest | null;
  checks?: GitHubChecksSummary | null;
  canMerge?: boolean;
};

export type GitHubPullRequestCreateInput = {
  directory: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  /** Remote to create the PR against (target repo, e.g., 'upstream' for forks) */
  remote?: string;
  /** Remote where the head branch lives (source repo, e.g., 'origin' for forks) */
  headRemote?: string;
};

export type GitHubPullRequestUpdateInput = {
  directory: string;
  number: number;
  title: string;
  body?: string;
};

export type GitHubPullRequestMergeInput = {
  directory: string;
  number: number;
  method: 'merge' | 'squash' | 'rebase';
};

export type GitHubPullRequestReadyInput = {
  directory: string;
  number: number;
};

export type GitHubPullRequestReadyResult = {
  ready: boolean;
};

export type GitHubPullRequestMergeResult = {
  merged: boolean;
  message?: string;
};

export type GitHubIssueLabel = {
  name: string;
  color?: string;
};

export type GitHubIssueSummary = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author?: GitHubUserSummary | null;
  labels?: GitHubIssueLabel[];
};

export type GitHubIssue = GitHubIssueSummary & {
  body?: string;
  assignees?: GitHubUserSummary[];
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssueComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssuesListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issues?: GitHubIssueSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubIssueGetResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issue?: GitHubIssue | null;
};

export type GitHubIssueCommentsResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  comments?: GitHubIssueComment[];
};

export type GitHubAuthStatus = {
  connected: boolean;
  user?: GitHubUserSummary | null;
  scope?: string;
  accounts?: GitHubAuthAccount[];
};

export type GitHubAuthAccount = {
  id: string;
  user: GitHubUserSummary;
  scope?: string;
  current?: boolean;
};

export type GitHubDeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
};

export type GitHubDeviceFlowComplete =
  | { connected: true; user: GitHubUserSummary; scope?: string }
  | { connected: false; status?: string; error?: string };

export interface GitHubAPI {
  authStatus(): Promise<GitHubAuthStatus>;
  authStart(): Promise<GitHubDeviceFlowStart>;
  authComplete(deviceCode: string): Promise<GitHubDeviceFlowComplete>;
  authDisconnect(): Promise<{ removed: boolean }>;
  authActivate(accountId: string): Promise<GitHubAuthStatus>;
  me?(): Promise<GitHubUserSummary>;

  prStatus(directory: string, branch: string, remote?: string): Promise<GitHubPullRequestStatus>;
  prCreate(payload: GitHubPullRequestCreateInput): Promise<GitHubPullRequest>;
  prUpdate(payload: GitHubPullRequestUpdateInput): Promise<GitHubPullRequest>;
  prMerge(payload: GitHubPullRequestMergeInput): Promise<GitHubPullRequestMergeResult>;
  prReady(payload: GitHubPullRequestReadyInput): Promise<GitHubPullRequestReadyResult>;

  prsList(directory: string, options?: { page?: number }): Promise<GitHubPullRequestsListResult>;
  prContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; includeCheckDetails?: boolean }
  ): Promise<GitHubPullRequestContextResult>;

  issuesList(directory: string, options?: { page?: number }): Promise<GitHubIssuesListResult>;
  issueGet(directory: string, number: number): Promise<GitHubIssueGetResult>;
  issueComments(directory: string, number: number): Promise<GitHubIssueCommentsResult>;
}

export interface RuntimeAPIs {
  runtime: RuntimeDescriptor;
  terminal: TerminalAPI;
  git: GitAPI;
  files: FilesAPI;
  settings: SettingsAPI;
  permissions: PermissionsAPI;
  notifications: NotificationsAPI;
  github?: GitHubAPI;
  push?: PushAPI;
  diagnostics?: DiagnosticsAPI;
  tools: ToolsAPI;
  editor?: EditorAPI;
  vscode?: VSCodeAPI;
  worktrees?: WorktreeMetadata[];
}

export type RuntimeAPISelector<TValue> = (apis: RuntimeAPIs) => TValue;

// ============== Skills Catalog Types ==============

export type SkillsCatalogSourceId = string;

export type SkillsCatalogSourceType = 'github' | 'clawdhub';

export interface SkillsCatalogSource {
  id: SkillsCatalogSourceId;
  label: string;
  description?: string;
  source: string;
  defaultSubpath?: string;
  sourceType?: SkillsCatalogSourceType;
}

export interface SkillsCatalogItemInstalledBadge {
  isInstalled: boolean;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents' | 'claude';
}

export interface ClawdHubSkillMetadata {
  slug: string;
  version: string;
  displayName?: string;
  owner?: string;
  downloads?: number;
  stars?: number;
  versionsCount?: number;
  createdAt?: number;
  updatedAt?: number;
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
  /** ClawdHub-specific metadata (present only for ClawdHub sources) */
  clawdhub?: ClawdHubSkillMetadata;
}

export interface SkillsCatalogResponse {
  ok: boolean;
  sources?: SkillsCatalogSource[];
  itemsBySource?: Record<SkillsCatalogSourceId, SkillsCatalogItem[]>;
  pageInfoBySource?: Record<SkillsCatalogSourceId, { nextCursor?: string | null }>;
  error?: { kind: string; message: string };
}

export interface SkillsCatalogSourceResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  nextCursor?: string | null;
  error?: { kind: string; message: string };
}

export interface SkillsRepoScanRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

export type SkillsRepoScanError =
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

export interface SkillsInstallSelection {
  skillDir: string;
  /** ClawdHub-specific metadata for installation */
  clawdhub?: {
    slug: string;
    version: string;
  };
}

export interface SkillsInstallRequest {
  source: string;
  subpath?: string;
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
  installed?: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
  skipped?: Array<{ skillName: string; reason: string }>;
  error?: SkillsInstallError;
  requiresReload?: boolean;
  message?: string;
  reloadDelayMs?: number;
}
