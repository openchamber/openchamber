export const GIT_OPERATION_KIND: Readonly<{
  READ: 'read';
  WORKTREE_WRITE: 'worktree-write';
  COMMON_WRITE: 'common-write';
  TOPOLOGY_WRITE: 'topology-write';
}>;

export const GIT_READ_ONLY_ENV: Readonly<{
  GIT_OPTIONAL_LOCKS: '0';
}>;

export type GitOperationKind = typeof GIT_OPERATION_KIND[keyof typeof GIT_OPERATION_KIND];
export type GitStatusShape = 'full' | 'light';

export type GitExecutionContext = {
  isRepository: true;
  commonId: string;
  worktreeId: string;
};

export type GitExecutionLease = {
  readonly commonId: string;
  readonly worktreeId: string;
  readonly kind: GitOperationKind;
  readonly targetWorktree: boolean;
  readonly network: boolean;
  active: boolean;
};

export type GitCloneLease = {
  readonly kind: 'clone-reservation';
  readonly destinationId: string;
  network: boolean;
  active: boolean;
  releaseNetwork(): void;
};

export type GitExecutionLimits = {
  globalConcurrency: number;
  readsPerCommonContext: number;
  networkPerCommonContext: number;
  globalNetworkConcurrency: number;
  maxQueuePerContext: number;
  maxGlobalQueue: number;
  maxContexts: number;
  maxWorktrees: number;
  maxStatusInFlight: number;
  maxCloneQueue: number;
  maxCloneQueuePerDestination: number;
  maxCloneDestinations: number;
  idleTtlMs: number;
  idlePruneIntervalMs: number;
};

export type GitExecutionCoordinatorOptions = {
  globalConcurrency?: number;
  readsPerCommonContext?: number;
  networkPerCommonContext?: number;
  globalNetworkConcurrency?: number;
  maxQueuePerContext?: number;
  maxGlobalQueue?: number;
  maxContexts?: number;
  maxWorktrees?: number;
  maxStatusInFlight?: number;
  maxCloneQueue?: number;
  maxCloneQueuePerDestination?: number;
  maxCloneDestinations?: number;
  idleTtlMs?: number;
  idlePruneIntervalMs?: number;
  now?: () => number;
  canonicalizeCloneDestination?: (destination: string) => Promise<string>;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type GitExecutionRunOptions = {
  context: GitExecutionContext;
  kind: GitOperationKind;
  targetWorktree?: boolean;
  network?: boolean;
  label?: string;
  signal?: AbortSignal;
  queueTimeoutMs?: number;
  lease?: GitExecutionLease;
};

export type GitStatusRunOptions<T, R> = {
  context: GitExecutionContext;
  shape?: GitStatusShape;
  signal?: AbortSignal;
  queueTimeoutMs?: number;
  projectResult?: (
    value: T,
    requestedShape: GitStatusShape,
    sourceShape: GitStatusShape,
  ) => R;
  label?: string;
};

export type GitCloneRunOptions = {
  destination: string;
  label?: string;
  signal?: AbortSignal;
  queueTimeoutMs?: number;
};

export type GitExecutionGeneration = {
  common: number;
  worktree: number;
};

export type GitExecutionCoordinatorStats = {
  active: number;
  pending: number;
  activeNetwork: number;
  contexts: number;
  idleContexts: number;
  worktrees: number;
  statusInFlight: number;
  clonePending: number;
  cloneDestinations: number;
  limits: Readonly<GitExecutionLimits>;
};

export class GitExecutionCoordinator {
  readonly limits: Readonly<GitExecutionLimits>;
  constructor(options?: GitExecutionCoordinatorOptions);
  pruneIdle(options?: { force?: boolean }): void;
  getGeneration(context: GitExecutionContext): GitExecutionGeneration;
  invalidateWorktrees(commonId: string, worktreeIds: string[]): number;
  run<T>(
    options: GitExecutionRunOptions,
    task: (lease: GitExecutionLease) => Promise<T> | T,
  ): Promise<T>;
  runClone<T>(
    options: GitCloneRunOptions,
    task: (lease: GitCloneLease) => Promise<T> | T,
  ): Promise<T>;
  runStatus<T, R = T>(
    options: GitStatusRunOptions<T, R>,
    task: (shape: GitStatusShape) => Promise<T> | T,
  ): Promise<R>;
  getStats(): GitExecutionCoordinatorStats;
}

export function createGitExecutionCoordinator(
  options?: GitExecutionCoordinatorOptions,
): GitExecutionCoordinator;
