export type GitDiscoveryCommandResult = {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  message?: string;
};

export type GitRepositoryContext = {
  isRepository: true;
  requestedDirectory: string;
  topLevel: string;
  gitDir: string;
  commonDir: string;
  commonId: string;
  worktreeId: string;
};

export type GitNonRepositoryContext = {
  isRepository: false;
  requestedDirectory: string;
  reason: 'not-a-repository';
};

export type GitResolvedContext = GitRepositoryContext | GitNonRepositoryContext;

export type GitContextResolverOptions = {
  runGit: (
    cwd: string,
    args: string[],
  ) => Promise<GitDiscoveryCommandResult | string | Buffer>;
  realpath?: (value: string) => Promise<string>;
  pathImpl?: typeof import('node:path');
  platform?: NodeJS.Platform;
  discoveryConcurrency?: number;
  maxPendingDiscoveries?: number;
  maxInFlightAliases?: number;
  maxInFlightContexts?: number;
};

export type GitContextResolveOptions = {
  signal?: AbortSignal;
};

export type GitContextResolverStats = {
  inFlightAliases: number;
  maxInFlightAliases: number;
  inFlightContexts: number;
  maxInFlightContexts: number;
  discovery: {
    active: number;
    pending: number;
    concurrency: number;
    maxPending: number;
  };
};

export class GitContextResolver {
  constructor(options: GitContextResolverOptions);
  resolve(directory: string, options?: GitContextResolveOptions): Promise<GitResolvedContext>;
  getStats(): GitContextResolverStats;
}

export function createGitContextResolver(options: GitContextResolverOptions): GitContextResolver;
