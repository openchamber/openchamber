import { createGitPathError, expandDirectoryEntries, GIT_PATH_IS_NESTED_REPOSITORY, GIT_PATH_IS_UNTRACKED_DIRECTORY, GIT_PATH_NOT_FOUND, resolveDirectoryEntry } from './directory-entry.js';
import { z } from 'zod';
import { simpleGit } from 'simple-git';
import { createSerialRefresh } from './serial-refresh.js';
import { stripAppImageLauncherEnv } from '../inherited-env.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import crypto from 'node:crypto';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';
import { readWorktreeDirectorySetting } from '../opencode/config-files.js';
import { readProjectStartCommand } from '../opencode/project-start-command.js';
import { normalizeGitOutputPath } from './output-path.js';
import { DIRECTORY_UNREACHABLE, directoryReachability, directoryUnreachableError } from '../directory-reachability/index.js';
import { GIT_LAUNCH_DIRECTORY, gitArgsIn, launchesFrom } from './git-launch.js';
import { assertLinkedRepositoryReachable, assertPathReachable, assertRepositoryReachable, directoryExists, execFileAsync, realpathOf } from './reachable-disk.js';
import { readWorktreeTopologyFingerprint } from './worktree-fingerprint.js';
import { createWorktreeRegistry } from './worktree-registry.js';
import { overlayEnvironment } from '../environment/variables.js';
import { primaryWorktreeRootFromGitDir, unsupportedRepositoryRootReason } from './repository-root.js';
import { createRemoteRefRefresher } from './refresh-remote-ref.js';
import { resolveSshAuthSock } from './ssh-auth-sock.js';
import { knownWorktreeBootstrapFailureCode, worktreeBootstrapFailureMessage } from './worktree-bootstrap-storage.js';
import { createIntegration, normalizeIntegrateBranch } from './integrate.js';
import { createIntegrateCheckouts, flagIntegrateCheckouts } from './integrate-checkouts.js';
import { createIntegratePublisher } from './integrate-publish.js';
import { BRANCH_CREATION_SOURCE_RE, findRestackedParent, isOwnRemoteCopy } from './branch-restack.js';
import { createRemoteProvisioning } from './remote-provisioning.js';
import { contributorProvenanceResult, createWorktreeResume } from './worktree-resume.js';
import { cleanBranchName, existingBranchLocalRefs, parseRemoteBranchRef } from './existing-branch-refs.js';
import type { SimpleGit, BranchSummary, FileStatusResult, RemoteWithRefs } from 'simple-git';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  GitEnvironment, GitUnsafeOptions, GitFactoryOptions, GitOptions, GitCommandOptions, GitCommandResult,
  PlannedRemote, WorktreeBootstrapState, BootstrapStore, BootstrapOptions,
  WorktreeCreateInput, WorktreeServerOptions, WorktreeCandidate, WorktreeProjectContext,
  WorktreeCreateResult, UpstreamConfiguration, WorktreeBootstrapTask, WorktreeRemovalInput,
  WorktreeArchiveInput, IntegratePlanInput, DiffOptions, CommitDiffOptions, RangeOptions,
  RepositoryGitContext, GitFileContext, DiffStats, WorktreeTopologyEntry, WorktreeTopologyEvent,
  StartCommandResult, StartCommandOptions, BranchStart, SnapshotOptions, LogOptions,
  HunkAction, PathDiffResult, CommitFile, PostCheckoutHookAction, RepositoryGitPaths, ErrorFields,
} from './service-contracts.js';
export type { RepositoryGitPaths } from './service-contracts.js';

const fsp = fs.promises;
const _require = createRequire(import.meta.url);
let resolvedGitBinary: string | null = null;
const worktreeBootstrapState = new Map<string, WorktreeBootstrapState>();
const activeWorktreeBootstrapTasks = new Map<string, Set<Promise<unknown>>>();
const worktreeSetupCancellations = new Map<string, AbortController>();
const remoteExistenceCache = new Map<string, { exists: boolean; checkedAt: number }>();
const SIMPLE_GIT_SAFE_BINARY_PATTERN = /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i;
const SIMPLE_GIT_UNSAFE_BINARY_WARNING = 'Invalid value supplied for custom binary, restricted characters must be removed';
const REMOTE_EXISTENCE_CACHE_TTL_MS = 30_000;
const gitIndexMutationQueues = new Map<string, Promise<unknown>>();

const WORKTREE_BOOTSTRAP_PENDING = 'pending';
const WORKTREE_BOOTSTRAP_READY = 'ready';
const WORKTREE_BOOTSTRAP_FAILED = 'failed';
const WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED = 'directory-created';
const WORKTREE_BOOTSTRAP_PHASE_GIT_READY = 'git-ready';
const WORKTREE_BOOTSTRAP_PHASE_SETUP_READY = 'setup-ready';
const WORKTREE_BOOTSTRAP_RECOVERY_ERROR = 'Worktree bootstrap completion is unknown. Inspect the checkout and repair setup before use.';
const GIT_NULL_REF = '0'.repeat(40);
const WORKTREE_INDEX_LOCK_RETRY_DELAY_MS = 250;
const WORKTREE_INDEX_LOCK_STALE_DELAY_MS = 750;
const WORKTREE_COMMAND_OUTPUT_MAX_CHARS = 20 * 1024 * 1024;

const toBootstrapStateKey = (directory: string) => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

const toCanonicalBootstrapStateKey = async (directory: string) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return '';
  }
  const realPath = await realpathOf(key).catch(() => key);
  const normalized = path.normalize(realPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const createWorktreeBootstrapState = <ErrorValue, Hydration, ErrorCode>(status: string, phase: string, error: ErrorValue | null = null, hydration?: Hydration, errorCode?: ErrorCode) => {
  const safeError = isPrimitiveString(error)
    ? error.trim().replace(/[\0\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 4096)
    : '';
  const state: WorktreeBootstrapState = {
    status,
    phase,
    error: safeError || null,
    updatedAt: Date.now(),
  };
  if (hydration) state.hydration = hydration;
  if (errorCode) state.errorCode = errorCode;
  return state;
};

const setWorktreeBootstrapState = async <ErrorValue, Hydration, ErrorCode>(directory: string, status: string, phase: string, error: ErrorValue | null = null, hydration?: Hydration, errorCode?: ErrorCode, bootstrapStore?: BootstrapStore) => {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) {
    return null;
  }
  let state = createWorktreeBootstrapState(status, phase, error, hydration, errorCode);
  worktreeBootstrapState.set(key, state);
  if (bootstrapStore) {
    try {
      state = await bootstrapStore.write(key, state);
      worktreeBootstrapState.set(key, state);
    } catch (cause) {
      const blocker = createWorktreeBootstrapState(
        WORKTREE_BOOTSTRAP_FAILED,
        phase === WORKTREE_BOOTSTRAP_PHASE_SETUP_READY ? WORKTREE_BOOTSTRAP_PHASE_GIT_READY : phase,
        WORKTREE_BOOTSTRAP_RECOVERY_ERROR,
        undefined,
        'OUTCOME_UNKNOWN',
      );
      worktreeBootstrapState.set(key, blocker);
      throw Object.assign(new Error(WORKTREE_BOOTSTRAP_RECOVERY_ERROR, { cause }), {
        code: 'WORKTREE_BOOTSTRAP_PERSISTENCE_FAILED',
        bootstrapStatus: blocker,
      });
    }
  }
  return state;
};

const clearWorktreeBootstrapState = async (directory: string, bootstrapStore?: BootstrapStore) => {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) {
    return;
  }
  if (bootstrapStore) await bootstrapStore.remove(key);
  worktreeBootstrapState.delete(key);
};

const rolledBackAttemptFailures = new WeakSet<WorktreeBootstrapState>();
const isRolledBackAttemptFailure = (state: WorktreeBootstrapState | undefined) => state !== undefined && rolledBackAttemptFailures.has(state);

const isReclaimableFailure = (state: WorktreeBootstrapState | undefined) => state?.status === WORKTREE_BOOTSTRAP_FAILED
  && !isRolledBackAttemptFailure(state);

const isMissingPathError = <Failure>(error: Failure) => errorField(error, 'code') === 'ENOENT' || errorField(error, 'code') === 'ENOTDIR';

const forgetMissingWorktreeFailure = async (key: string, bootstrapStore?: BootstrapStore) => {
  const current = worktreeBootstrapState.get(key);
  if (isRolledBackAttemptFailure(current)) return false;
  if (bootstrapStore) {
    if (!await bootstrapStore.remove(key, { ifMissingFailed: true })) return false;
  } else {
    if (current?.status !== WORKTREE_BOOTSTRAP_FAILED) return false;
    try {
      await fsp.lstat(key);
      return false;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  if (worktreeBootstrapState.get(key) === current) worktreeBootstrapState.delete(key);
  return true;
};

const directoryIsGone = async (key: string) => {
  try {
    await fsp.lstat(key);
    return false;
  } catch (error) {
    return isMissingPathError(error);
  }
};

const releaseRolledBackAttemptFailure = async (key: string, bootstrapStore?: BootstrapStore) => {
  const current = worktreeBootstrapState.get(key);
  if (current?.status !== WORKTREE_BOOTSTRAP_FAILED) return;
  rolledBackAttemptFailures.add(current);
  if (bootstrapStore) await bootstrapStore.remove(key, { ifMissingFailed: true });
};

const trackWorktreeBootstrapTask = <Result>(directory: string, task: Promise<Result>) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return task;
  }

  let tasks = activeWorktreeBootstrapTasks.get(key);
  if (!tasks) {
    tasks = new Set();
    activeWorktreeBootstrapTasks.set(key, tasks);
  }
  tasks.add(task);
  const clearTask = () => {
    tasks.delete(task);
    if (tasks.size === 0 && activeWorktreeBootstrapTasks.get(key) === tasks) {
      activeWorktreeBootstrapTasks.delete(key);
    }
  };
  void task.then(clearTask, clearTask);
  return task;
};

export const waitForActiveWorktreeBootstrap = async (directory: string) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }

  while (true) {
    let tasks = activeWorktreeBootstrapTasks.get(key);
    if (!tasks) {
      const canonicalKey = await canonicalPath(key);
      for (const [trackedKey, trackedTasks] of activeWorktreeBootstrapTasks) {
        if (await canonicalPath(trackedKey) === canonicalKey) {
          tasks = trackedTasks;
          break;
        }
      }
    }
    if (!tasks) {
      return;
    }
    await Promise.allSettled([...tasks]);
  }
};

const cancelWorktreeSetup = async (directory: string) => {
  const canonicalKey = await canonicalPath(toBootstrapStateKey(directory));
  for (const [trackedKey, cancellation] of worktreeSetupCancellations) {
    if (await canonicalPath(trackedKey) === canonicalKey) cancellation.abort();
  }
};

const hasActiveWorktreeBootstrap = async (directory: string) => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return false;
  }
  if (activeWorktreeBootstrapTasks.has(key)) {
    return true;
  }
  const canonicalKey = await toCanonicalBootstrapStateKey(key);
  for (const trackedKey of activeWorktreeBootstrapTasks.keys()) {
    if (await toCanonicalBootstrapStateKey(trackedKey) === canonicalKey) {
      return true;
    }
  }
  return false;
};

const isExecutableFile = (candidate: string | null): candidate is string => {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      const ext = path.extname(candidate).toLowerCase();
      return ext.length === 0 || ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const normalizeGitExecutableCandidate = (candidate: string) => {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
    const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
    if (isExecutableFile(exeCandidate)) {
      return exeCandidate;
    }
  }

  return trimmed;
};

const isSafeSimpleGitBinary = (candidate: string) => (
  SIMPLE_GIT_SAFE_BINARY_PATTERN.test(candidate)
);

const createSimpleGit = (options: GitFactoryOptions) => {
  if (!options?.unsafe?.allowUnsafeCustomBinary) {
    return simpleGit(options);
  }

  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (String(args[0] || '').includes(SIMPLE_GIT_UNSAFE_BINARY_WARNING)) {
      return;
    }
    originalWarn(...args);
  };

  try {
    return simpleGit(options);
  } finally {
    console.warn = originalWarn;
  }
};

const listPathExecutableCandidates = (binaryName: string) => {
  const currentPath = process.env.PATH || '';
  const seen = new Set<string>();
  const matches = [];
  for (const segment of currentPath.split(path.delimiter)) {
    const dir = segment.trim();
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    matches.push(path.join(dir, binaryName));
  }
  return matches;
};

const listWindowsGitInstallCandidates = () => {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (isPrimitiveString(value) ? value.trim() : ''))
    .filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'bin', 'git.exe'));
  }
  return candidates;
};

const resolveExplicitGitBinary = () => {
  const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
    .map((value) => (isPrimitiveString(value) ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    const normalized = normalizeGitExecutableCandidate(candidate);
    if (isExecutableFile(normalized)) {
      return /[\\/]/.test(normalized) && !path.win32.isAbsolute(normalized) ? path.resolve(normalized) : normalized;
    }
  }
  return null;
};

const resolveGitBinary = () => {
  if (process.platform !== 'win32') {
    return resolveExplicitGitBinary() || 'git';
  }
  if (resolvedGitBinary) {
    return resolvedGitBinary;
  }

  const explicit = resolveExplicitGitBinary();
  if (explicit) {
    resolvedGitBinary = explicit;
    return resolvedGitBinary;
  }

  const pathDiscovered = [
    ...listPathExecutableCandidates('git.exe'),
    ...listPathExecutableCandidates('git'),
  ]
    .map(normalizeGitExecutableCandidate)
    .filter(Boolean)
    .filter((candidate) => isExecutableFile(candidate));
  if (pathDiscovered.length > 0) {
    resolvedGitBinary = 'git';
    return resolvedGitBinary;
  }

  const discovered = [
    ...listWindowsGitInstallCandidates(),
  ]
    .map(normalizeGitExecutableCandidate)
    .filter(Boolean)
    .filter((candidate) => isExecutableFile(candidate));

  const preferredExe = discovered.find((candidate) => isSafeSimpleGitBinary(candidate) && candidate.toLowerCase().endsWith('.exe'))
    || discovered.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  resolvedGitBinary = preferredExe || discovered[0] || 'git.exe';
  return resolvedGitBinary;
};

const getGitBinary = () => resolveGitBinary();

let gitEnvironment: GitEnvironment | null = null;

export const configureGitEnvironment = (runtime: GitEnvironment | null) => {
  gitEnvironment = runtime;
};

const SIMPLE_GIT_REFUSED_ENV_CATEGORIES = new Map<string, keyof GitUnsafeOptions>([
  ['editor', 'allowUnsafeEditor'],
  ['git_askpass', 'allowUnsafeAskPass'],
  ['git_config', 'allowUnsafeConfigPaths'],
  ['git_config_count', 'allowUnsafeConfigEnvCount'],
  ['git_config_global', 'allowUnsafeConfigPaths'],
  ['git_config_parameters', 'allowUnsafeConfigEnvCount'],
  ['git_config_system', 'allowUnsafeConfigPaths'],
  ['git_editor', 'allowUnsafeEditor'],
  ['git_exec_path', 'allowUnsafeExec'],
  ['git_external_diff', 'allowUnsafeDiffExternal'],
  ['git_pager', 'allowUnsafePager'],
  ['git_proxy_command', 'allowUnsafeGitProxy'],
  ['git_sequence_editor', 'allowUnsafeEditor'],
  ['git_ssh', 'allowUnsafeSshCommand'],
  ['git_ssh_command', 'allowUnsafeSshCommand'],
  ['git_template_dir', 'allowUnsafeTemplateDir'],
  ['pager', 'allowUnsafePager'],
  ['prefix', 'allowUnsafeConfigPaths'],
  ['ssh_askpass', 'allowUnsafeAskPass'],
  ['visual', 'allowUnsafeEditor'],
]);
const isRefusedBySimpleGit = (name: string) => {
  const lower = name.toLowerCase();
  return SIMPLE_GIT_REFUSED_ENV_CATEGORIES.has(lower) || lower.startsWith('git_config_key_') || lower.startsWith('git_config_value_');
};
const REPOSITORY_LOCATION_ENV_NAMES = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE',
]);
const isKeptOutOfGitOverlay = (name: string) => isRefusedBySimpleGit(name) || REPOSITORY_LOCATION_ENV_NAMES.has(name.toUpperCase());

const directoryEnvironmentForGit = async (directory: string) => {
  if (!gitEnvironment || !directory) return null;
  const variables = await gitEnvironment.forDirectory(normalizeDirectoryPath(directory));
  if (!variables) return null;
  return Object.fromEntries(Object.entries(variables).filter(([name]) => !isKeptOutOfGitOverlay(name)));
};

const buildGitEnv = async (directory: string) => {
  const inherited = stripAppImageLauncherEnv({ ...process.env });
  const variables = await directoryEnvironmentForGit(directory);
  const env = variables ? overlayEnvironment(inherited, variables) : inherited;
  if (process.platform === 'win32') {
    env.MSYS = [env.MSYS, 'noglob'].filter(Boolean).join(' ');
  }
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  if (env.GIT_TERMINAL_PROMPT === undefined || variables?.GIT_TERMINAL_PROMPT !== undefined) {
    env.GIT_TERMINAL_PROMPT = '0';
  }
  return env;
};

const simpleGitEnvOptions = (env: NodeJS.ProcessEnv) => {
  const unsafe: GitUnsafeOptions = {};
  for (const [key, value] of Object.entries(env)) {
    const category = SIMPLE_GIT_REFUSED_ENV_CATEGORIES.get(key.toLowerCase());
    if (category && process.env[key] === value) {
      unsafe[category] = true;
    }
  }
  return { allowEnvironment: Object.keys(env), unsafe };
};

const createGit = async (directory: string, { stallTimeoutMs = 0, optionalLocks = true, extraEnv }: GitOptions = {}) => {
  await directoryReachability.assertReachable(directory);
  const env = { ...(await buildGitEnv(directory)), ...extraEnv };
  if (!optionalLocks) {
    env.GIT_OPTIONAL_LOCKS = '0';
  }
  const spawnOptions = { windowsHide: true };
  const timeout = stallTimeoutMs > 0 ? { block: stallTimeoutMs } : undefined;
  const binary = getGitBinary();
  const hasCustomBinary = binary.trim() && binary !== 'git' && binary !== 'git.exe';
  const { allowEnvironment, unsafe } = simpleGitEnvOptions(env);
  if (hasCustomBinary) {
    unsafe.allowUnsafeCustomBinary = true;
  }
  const baseDir = normalizeDirectoryPath(directory);
  if (!isPrimitiveString(baseDir) || !baseDir.trim()) {
    throw new Error('Git directory is required');
  }
  const options: GitFactoryOptions = {
    baseDir: GIT_LAUNCH_DIRECTORY,
    spawnOptions,
    binary,
    unsafe,
    allowEnvironment,
  };
  if (timeout) options.timeout = timeout;
  return launchesFrom(createSimpleGit(options), baseDir).env(env);
};

const createGitForGlobalConfig = async () => createGit(os.homedir());

const normalizeDirectoryPath = <Value>(value: Value) => {
  if (!isPrimitiveString(value)) {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

const normalizePath = <Value>(value: Value) => {
  const normalized = normalizeDirectoryPath(value);
  if (!isPrimitiveString(normalized)) {
    return normalized;
  }
  return normalized.replace(/\\/g, '/');
};

const getGitIndexMutationQueueKey = (directory: string) => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

const withGitIndexMutationQueue = async <Result>(directory: string, task: () => Promise<Result>) => {
  let key = getGitIndexMutationQueueKey(directory);
  try {
    const directoryPath = normalizeDirectoryPath(directory);
    if (directoryPath) {
      const git = await createGit(directoryPath);
      key = await resolveGitRepositoryRoot(directoryPath, git);
    }
  } catch {
    void 0;
  }
  if (!key) {
    return task();
  }

  const previous = gitIndexMutationQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tail = current.catch(() => {});
  gitIndexMutationQueues.set(key, tail);

  try {
    return await current;
  } finally {
    if (gitIndexMutationQueues.get(key) === tail) {
      gitIndexMutationQueues.delete(key);
    }
  }
};

const normalizeFilePathList = <Paths>(paths: Paths) => Array.from(new Set<string>(
  (Array.isArray(paths) ? paths : [paths])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
));

const validateRepositoryFilePaths = (directoryPath: string, filePaths: string[]) => {
  const repoRoot = path.resolve(directoryPath);

  for (const filePath of filePaths) {
    const absoluteTarget = path.resolve(repoRoot, filePath);
    if (!absoluteTarget.startsWith(repoRoot + path.sep) && absoluteTarget !== repoRoot) {
      throw new Error(`Path is outside repository: ${filePath}`);
    }
  }
};

const toGitPath = (value: string) => value.replace(/\\/g, '/');

const isInsideOrSameDirectory = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const toRepositoryRoot = (directoryPath: string, topLevel: string) => {
  const normalizedTopLevel = normalizeGitOutputPath(topLevel.trim());
  return path.isAbsolute(normalizedTopLevel)
    ? path.resolve(normalizedTopLevel)
    : path.resolve(directoryPath, normalizedTopLevel);
};

const resolveGitRepositoryRoot = async (directoryPath: string, git: SimpleGit) => (
  toRepositoryRoot(directoryPath, await git.raw(['rev-parse', '--show-toplevel']))
);

const createRepositoryGitContext = async (directory: string, gitOptions: GitOptions = {}) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!isPrimitiveString(directoryPath) || !directoryPath.trim()) {
    throw new Error('Git directory is required');
  }
  const directoryGit = await createGit(directoryPath, gitOptions);
  const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
  const git = path.resolve(directoryPath) === repoRoot ? directoryGit : await createGit(repoRoot, gitOptions);
  return { directoryPath, directoryGit, repoRoot, git };
};

export async function getRepositoryRoot(directory: string) {
  const { repoRoot } = await createRepositoryGitContext(directory);
  return repoRoot;
}

const resolveGitInternalPath = async (repoRoot: string, git: SimpleGit, gitPath: string) => {
  const resolved = await git.raw(['rev-parse', '--git-path', gitPath]);
  return path.resolve(repoRoot, normalizeGitOutputPath(resolved.trim()));
};

const GITLINK_MODE = '160000';

const readGitEntryMode = async (repoRoot: string, args: string[], repoPath: string) => {
  const result = await runGitCommand(repoRoot, args);
  if (!result.success) return null;
  for (const record of result.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab !== -1 && record.slice(tab + 1) === repoPath) {
      return record.slice(0, record.indexOf(' '));
    }
  }
  return null;
};

const resolveGitFileContext = async (directoryPath: string, git: SimpleGit, filePath: string | undefined, repoRootOverride: string | null = null, { acceptUntrackedDirectory = false } = {}) => {
  if (filePath === undefined) throw new TypeError('Git file path is required');
  const repoRoot = repoRootOverride || await resolveGitRepositoryRoot(directoryPath, git);
  const candidates = Array.from(new Set([
    path.resolve(repoRoot, filePath),
    path.resolve(directoryPath, filePath),
  ]));
  let nestedRepository = false;
  let untrackedDirectory = false;

  for (const absolutePath of candidates) {
    if (!isInsideOrSameDirectory(repoRoot, absolutePath)) {
      continue;
    }

    const repoPath = toGitPath(path.relative(repoRoot, absolutePath));
    const worktreeEntry = await fsp.lstat(absolutePath).catch(() => null);
    const isSymbolicLink = worktreeEntry?.isSymbolicLink() ?? false;
    const existsInWorktree = worktreeEntry?.isFile() || isSymbolicLink;
    const indexMode = await readGitEntryMode(repoRoot, ['ls-files', '--stage', '-z', '--', `:(literal)${repoPath}`], repoPath);
    const headMode = await readGitEntryMode(repoRoot, ['ls-tree', '-z', 'HEAD', '--', repoPath], repoPath);

    if (existsInWorktree || indexMode || headMode) {
      return {
        absolutePath,
        repoPath,
        repoRoot,
        isSymbolicLink,
        isSubmodule: indexMode === GITLINK_MODE || headMode === GITLINK_MODE,
      };
    }

    if (worktreeEntry?.isDirectory()) {
      if (await fsp.lstat(path.join(absolutePath, '.git')).then(() => true, () => false)) {
        nestedRepository = true;
      } else if (acceptUntrackedDirectory && repoPath && filePath.endsWith('/')) {
        const entry = await resolveDirectoryEntry(runGitCommand, repoRoot, repoPath, absolutePath);
        if (entry) return entry;
        nestedRepository = true;
      } else {
        untrackedDirectory = true;
      }
    }
  }

  if (nestedRepository) throw createGitPathError(GIT_PATH_IS_NESTED_REPOSITORY, filePath);
  if (untrackedDirectory) throw createGitPathError(GIT_PATH_IS_UNTRACKED_DIRECTORY, filePath);
  throw createGitPathError(GIT_PATH_NOT_FOUND, filePath);
};

const readSubmoduleState = async (repoRoot: string, fileContext: GitFileContext) => {
  const status = await runGitCommand(repoRoot, ['status', '--porcelain=v2', '-z', '--', `:(literal)${fileContext.repoPath}`]);
  if (!status.success) {
    throw new Error(status.message || 'Failed to read submodule status');
  }
  const record = status.stdout.split('\0').find((entry) => /^[12u] /.test(entry))?.split(' ');
  const hasConflict = record?.[0] === 'u';
  const readHead = async () => (await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `HEAD:${fileContext.repoPath}`])).stdout.trim();
  const head = record && !hasConflict ? record[6] : await readHead();
  const index = hasConflict ? '' : (record ? record[7] : head);
  const flags = record ? record[2] : 'S...';
  const initialized = await fsp.lstat(path.join(fileContext.absolutePath, '.git')).then(() => true, () => false);
  const worktree = initialized ? await runGitCommand(fileContext.absolutePath, ['rev-parse', '--verify', 'HEAD']) : null;
  const commitOrNull = (value: string | undefined) => (value && !/^0+$/.test(value) ? value : null);

  return {
    headCommit: commitOrNull(head),
    indexCommit: commitOrNull(index),
    worktreeCommit: worktree?.success ? worktree.stdout.trim() : null,
    hasTrackedChanges: submoduleFlag(flags, 2) === 'M',
    hasUntrackedFiles: submoduleFlag(flags, 3) === 'U',
    hasConflict,
  };
};

const submoduleFlag = (flags: string | undefined, index: number) => {
  if (flags === undefined) throw new TypeError(`Cannot read properties of undefined (reading '${index}')`);
  return flags[index];
};

const OPENCODE_ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'cosmic',
  'crisp',
  'curious',
  'eager',
  'gentle',
  'glowing',
  'happy',
  'hidden',
  'jolly',
  'kind',
  'lucky',
  'mighty',
  'misty',
  'neon',
  'nimble',
  'playful',
  'proud',
  'quick',
  'quiet',
  'shiny',
  'silent',
  'stellar',
  'sunny',
  'swift',
  'tidy',
  'witty',
];

const OPENCODE_NOUNS = [
  'cabin',
  'cactus',
  'canyon',
  'circuit',
  'comet',
  'eagle',
  'engine',
  'falcon',
  'forest',
  'garden',
  'harbor',
  'island',
  'knight',
  'lagoon',
  'meadow',
  'moon',
  'mountain',
  'nebula',
  'orchid',
  'otter',
  'panda',
  'pixel',
  'planet',
  'river',
  'rocket',
  'sailor',
  'squid',
  'star',
  'tiger',
  'wizard',
  'wolf',
];

const OPENCODE_WORKTREE_ATTEMPTS = 26;

const getOpenCodeDataPath = () => {
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'opencode');
};

const pickRandom = (values: string[]) => values[Math.floor(Math.random() * values.length)];

const generateOpenCodeRandomName = () => `${pickRandom(OPENCODE_ADJECTIVES)}-${pickRandom(OPENCODE_NOUNS)}`;

const slugWorktreeName = (value: string) => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80);
};

const canonicalPath = async (input: string) => {
  const absolutePath = path.resolve(input);
  const realPath = await realpathOf(absolutePath).catch(() => absolutePath);
  const normalized = path.normalize(realPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const checkPathExists = async (targetPath: string) => {
  try {
    await fsp.stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const normalizeStartRef = (value: string | null | undefined) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return 'HEAD';
  }
  return trimmed;
};

function isValidCommitHash(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-fA-F]{7,40}$/.test(hash);
}

const resolveRemoteBranchRef = async (primaryWorktree: string, value: string) => {
  const raw = String(value || '').trim();
  const parsed = parseRemoteBranchRef(raw);
  if (!parsed) {
    return null;
  }

  if (raw.startsWith('refs/remotes/') || raw.startsWith('remotes/')) {
    return parsed;
  }
  if (raw.startsWith('refs/')) {
    return null;
  }

  const localRef = `refs/heads/${raw}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return null;
  }

  return parsed;
};

const resolveCheckoutRemoteName = async (primaryWorktree: string, startRef: string) => {
  const raw = String(startRef || '').trim();
  const branch = raw && raw !== 'HEAD'
    ? raw.replace(/^refs\/heads\//, '')
    : (await runGitCommand(primaryWorktree, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (branch) {
    const upstream = await runGitCommand(primaryWorktree, ['config', '--get', `branch.${branch}.remote`]);
    const name = upstream.success ? upstream.stdout.trim() : '';
    if (name) return name;
  }
  const remotes = await runGitCommand(primaryWorktree, ['remote']);
  const names = remotes.success ? remotes.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  if (names.length === 1) return names[0];
  return names.includes('origin') ? 'origin' : '';
};

const normalizeUpstreamTarget = (remote: string, branch: string) => {
  const remoteName = String(remote || '').trim();
  const branchName = String(branch || '').trim();
  if (!remoteName || !branchName) {
    return null;
  }
  return {
    remote: remoteName,
    branch: branchName,
    full: `${remoteName}/${branchName}`,
  };
};

const hasErrorFields = (value: unknown): value is ErrorFields => value !== null && value !== undefined;
const errorField = <Failure>(value: Failure, key: keyof ErrorFields) => hasErrorFields(value) ? value[key] : undefined;

const isPrimitiveString = (value: unknown): value is string => typeof value === 'string';
const isObjectValue = (value: unknown): value is object => value !== null && typeof value === 'object';
const isInteger = (value: unknown): value is number => Number.isInteger(value);

const isBootstrapPersistenceFailure = (value: unknown): value is { code: string; bootstrapStatus: WorktreeBootstrapState } => {
  if (!hasErrorFields(value) || value.code !== 'WORKTREE_BOOTSTRAP_PERSISTENCE_FAILED') return false;
  const state = value.bootstrapStatus;
  return hasBootstrapStateFields(state)
    && typeof state.status === 'string' && typeof state.phase === 'string'
    && (state.error === null || typeof state.error === 'string') && typeof state.updatedAt === 'number'
    && state.hydration === undefined;
};

const hasBootstrapStateFields = (value: unknown): value is {
  status?: unknown; phase?: unknown; error?: unknown; updatedAt?: unknown; hydration?: unknown;
} => value !== null && value !== undefined;

const parseGitErrorText = <Failure>(error: Failure) => {
  const rawStderr = errorField(error, 'stderr');
  const rawStdout = errorField(error, 'stdout');
  const rawMessage = errorField(error, 'message');
  const stderr = isPrimitiveString(rawStderr) ? rawStderr : '';
  const stdout = isPrimitiveString(rawStdout) ? rawStdout : '';
  const message = isPrimitiveString(rawMessage) ? rawMessage : '';
  const fallback = !message && error != null ? String(error) : '';
  const chunks = [stderr, stdout, message, fallback]
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean);
  return chunks
    .filter((chunk, index) => !chunks.some((other, otherIndex) => otherIndex !== index && other.length > chunk.length && other.includes(chunk)))
    .join('\n')
    .trim();
};

const parseAheadBehindCounts = (value: string) => {
  const [aheadRaw, behindRaw] = String(value || '').trim().split(/\s+/);
  const ahead = parseInt(String(aheadRaw), 10);
  const behind = parseInt(String(behindRaw), 10);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return null;
  }
  return { ahead, behind };
};

const getRemoteExistenceCacheKey = (directory: string, remoteName: string) => {
  const normalizedDirectory = normalizeDirectoryPath(directory) || '';
  return `${path.resolve(normalizedDirectory)}\0${remoteName}`;
};

const hasRemote = async (git: SimpleGit, directory: string, remoteName: string) => {
  const remote = String(remoteName || '').trim();
  if (!remote) {
    return false;
  }

  const key = getRemoteExistenceCacheKey(directory, remote);
  const cached = remoteExistenceCache.get(key);
  if (cached && Date.now() - cached.checkedAt < REMOTE_EXISTENCE_CACHE_TTL_MS) {
    return cached.exists;
  }

  const exists = await git
    .raw(['remote', 'get-url', '--', remote])
    .then((value) => String(value || '').trim().length > 0)
    .catch(() => false);

  remoteExistenceCache.set(key, { exists, checkedAt: Date.now() });
  return exists;
};

const _buildRawGitOptions = (raw: string[] | Record<string, string | boolean | number | null>) => {
  if (Array.isArray(raw)) {
    return raw.map((value) => String(value || '').trim()).filter(Boolean);
  }

  if (!raw) {
    return [];
  }

  return Object.entries(raw).flatMap(([key, value]) => {
    const option = String(key || '').trim();
    if (!option || value === false) {
      return [];
    }
    if (value === true || value == null) {
      return [option];
    }
    return [option, String(value)];
  });
};

const getRemoteBranchComparison = async (git: SimpleGit, remoteName: string, branchName: string) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return null;
  }

  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const exists = await git
    .raw(['rev-parse', '--verify', remoteRef])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  if (!exists) {
    return null;
  }

  const countsRaw = await git
    .raw(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  const counts = parseAheadBehindCounts(countsRaw);
  if (!counts) {
    return null;
  }

  return {
    remote,
    branch,
    ahead: counts.ahead,
    behind: counts.behind,
  };
};

const isNotGitRepositoryError = <Failure>(error: Failure) => {
  const text = parseGitErrorText(error);
  return /not a git repository/i.test(text);
};

const isMissingDirectoryError = <Failure>(error: Failure) => {
  const code = errorField(error, 'code');
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return true;
  }
  const text = parseGitErrorText(error);
  return /directory that does not exist|does not exist|no such file or directory/i.test(text);
};

export const runGitCommand = async (cwd: string, args: string[], { env: envOverride, timeoutMs = 0 }: GitCommandOptions = {}): Promise<GitCommandResult> => {
  try {
    await directoryReachability.assertReachable(cwd);
    const options: import('node:child_process').ExecFileOptionsWithStringEncoding = {
      cwd,
      env: envOverride || await buildGitEnv(cwd),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    };
    if (timeoutMs > 0) {
      options.timeout = timeoutMs;
      options.killSignal = 'SIGKILL';
    }
    const { stdout, stderr } = await execFileAsync(getGitBinary(), args, options);
    return {
      success: true,
      exitCode: 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    };
  } catch (error) {
    const code = errorField(error, 'code');
    return {
      success: false,
      exitCode: isInteger(code) ? code : null,
      stdout: String(errorField(error, 'stdout') || ''),
      stderr: String(errorField(error, 'stderr') || ''),
      message: parseGitErrorText(error),
      timedOut: errorField(error, 'killed') === true,
      spawnFailed: code === 'ENOENT' || code === 'EACCES',
    };
  }
};

const resolveGitCommitFilePath = async (repoRoot: string, hash: string, candidates: string[]) => {
  for (const candidate of candidates) {
    const [originalTreeResult, modifiedTreeResult] = await Promise.all([
      runGitCommand(repoRoot, ['ls-tree', '--name-only', `${hash}^`, '--', candidate]),
      runGitCommand(repoRoot, ['ls-tree', '--name-only', hash, '--', candidate]),
    ]);

    if ((originalTreeResult.success && originalTreeResult.stdout.trim()) || (modifiedTreeResult.success && modifiedTreeResult.stdout.trim())) {
      return candidate;
    }
  }

  throw new Error('Invalid file path');
};

const runGitCommandWithoutEditor = async (cwd: string, args: string[]) => {
  const result = await runGitCommand(cwd, args, { env: { ...(await buildGitEnv(cwd)), GIT_EDITOR: 'true' } });
  if (!result.success) {
    throw new Error(result.message || 'Git command failed');
  }
};

const runGitCommandOrThrow = async (cwd: string, args: string[], fallbackMessage?: string) => {
  const result = await runGitCommand(cwd, args);
  if (!result.success) {
    throw new Error(result.message || fallbackMessage || 'Git command failed');
  }
  return result;
};

const worktreeRegistry = createWorktreeRegistry(runGitCommandOrThrow);

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const isIndexLockError = (result: GitCommandResult) => {
  const message = [result?.message, result?.stderr, result?.stdout].filter(Boolean).join('\n');
  return /index\.lock['"]?: File exists|another git process seems to be running/i.test(message);
};

const getWorktreeIndexLockPath = async (directory: string) => {
  const result = await runGitCommand(directory, ['rev-parse', '--git-path', 'index.lock']);
  if (!result.success) {
    return null;
  }
  const value = normalizeGitOutputPath(String(result.stdout || '').trim());
  return value ? (path.isAbsolute(value) ? value : path.resolve(directory, value)) : null;
};

const getFileIdentity = async (filePath: string) => {
  try {
    const stat = await fsp.stat(filePath);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (errorField(error, 'code') === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const WORKTREE_POPULATE_CONFIG_ARGS = [
  '-c', 'core.longpaths=true',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'submodule.recurse=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.required=false',
];

const buildWorktreePopulateCommand = async (directory: string) => {
  const env: NodeJS.ProcessEnv = {
    ...(await buildGitEnv(directory)),
    GIT_ALLOW_PROTOCOL: '',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.GIT_CONFIG_PARAMETERS;
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  const configured = await runGitCommand(directory, [
    ...WORKTREE_POPULATE_CONFIG_ARGS,
    'config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(process|smudge|clean|required)$',
  ], { env });
  if (!configured.success && configured.exitCode !== 1) {
    throw new Error('Failed to inspect Git filters before populating worktree');
  }
  if (configured.stdout && !configured.stdout.endsWith('\0')) {
    throw new Error('Git filter configuration is invalid');
  }
  const filterArgs = [];
  for (const key of configured.stdout.split('\0').filter(Boolean)) {
    if (!/^filter\.[^\0\r\n=]+\.(process|smudge|clean|required)$/i.test(key)) {
      throw new Error('Git filter configuration is invalid');
    }
    filterArgs.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`);
  }
  return {
    args: [...WORKTREE_POPULATE_CONFIG_ARGS, ...filterArgs, 'reset', '--hard'],
    env,
  };
};

const isFilenameTooLongError = <Message>(message: Message) => /file ?name too long/i.test(String(message || ''));

const formatWorktreePopulateError = <Message>(message: Message) => {
  const text = String(message || '').trim() || 'Failed to populate worktree';
  if (!isFilenameTooLongError(text)) {
    return text;
  }
  return [
    text,
    'The worktree checkout path exceeds this system\'s path-length limit.',
    'OpenChamber enables Git `core.longpaths` for worktree population; if this still fails on Windows, enable OS long paths (LongPathsEnabled) or open the repository from a shorter absolute path.',
  ].join('\n');
};

export const ensureWorktreeLongpaths = async (directory: string) => {
  const current = await runGitCommand(directory, ['config', '--get', 'core.longpaths']);
  if (String(current.stdout || '').trim().toLowerCase() === 'true') {
    return;
  }
  await runGitCommand(directory, ['config', 'core.longpaths', 'true']);
};

export const populateWorktreeWithLockRecovery = async (directory: string) => {
  await ensureWorktreeLongpaths(directory);
  const command = await buildWorktreePopulateCommand(directory);

  let result = await runGitCommand(directory, command.args, { env: command.env });
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await wait(WORKTREE_INDEX_LOCK_RETRY_DELAY_MS);
  result = await runGitCommand(directory, command.args, { env: command.env });
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  const lockPath = await getWorktreeIndexLockPath(directory);
  const identity = lockPath ? await getFileIdentity(lockPath) : null;
  await wait(WORKTREE_INDEX_LOCK_STALE_DELAY_MS);

  result = await runGitCommand(directory, command.args, { env: command.env });
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result) || !lockPath || !identity || await getFileIdentity(lockPath) !== identity) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await fsp.unlink(lockPath).catch((error) => {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  });
  const finalResult = await runGitCommand(directory, command.args, { env: command.env });
  if (!finalResult.success) {
    throw new Error(formatWorktreePopulateError(finalResult.message || 'Failed to populate worktree'));
  }
};

const inspectPostCheckoutHook = async (directory: string): Promise<PostCheckoutHookAction | null> => {
  const result = await runGitCommand(directory, ['rev-parse', '--git-path', 'hooks']);
  if (!result.success) return null;
  const hooksPath = normalizeDirectoryPath(normalizeGitOutputPath(String(result.stdout || '').trim()));
  if (!hooksPath) return null;
  const hookPath = path.join(path.isAbsolute(hooksPath) ? hooksPath : path.resolve(directory, hooksPath), 'post-checkout');
  let handle;
  try {
    handle = await fsp.open(hookPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o111) === 0)) return null;
    const content = await handle.readFile();
    const gitDirResult = await runGitCommand(directory, ['rev-parse', '--absolute-git-dir']);
    const gitDir = normalizeGitOutputPath(String(gitDirResult.stdout || '').trim());
    if (!gitDirResult.success || !gitDir) return null;
    return {
      kind: 'post-checkout-hook',
      path: hookPath,
      content,
      contentDigest: crypto.createHash('sha256').update(content).digest('base64url'),
      gitDir,
      workTree: path.resolve(directory),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

export const inspectContributorCheckoutActions = async (directory: string, provenance: { sourceSha: string; setupCommand?: string }) => {
  const head = String((await runGitCommandOrThrow(directory, ['rev-parse', 'HEAD'], 'Failed to inspect worktree HEAD')).stdout || '').trim().toLowerCase();
  if (head !== provenance.sourceSha) throw Object.assign(new Error('Contributor worktree HEAD changed'), { code: 'STALE_CONFIG', status: 409 });
  const hook = await inspectPostCheckoutHook(directory);
  const projectCommand = await readProjectStartCommand((await resolvePrimaryWorktreeRoot(directory)).root);
  const setupCommand = String(provenance.setupCommand || '').trim();
  const actions: (NonNullable<Awaited<ReturnType<typeof inspectPostCheckoutHook>>> | { kind: 'project-start-command' | 'setup-command'; command: string })[] = [];
  if (hook) actions.push(hook);
  if (projectCommand) actions.push({ kind: 'project-start-command', command: projectCommand });
  if (setupCommand) actions.push({ kind: 'setup-command', command: setupCommand });
  const digestActions = actions.map((action) => action.kind === 'post-checkout-hook' ? {
    kind: action.kind,
    path: action.path,
    contentDigest: action.contentDigest,
    gitDir: action.gitDir,
    workTree: action.workTree,
    args: [GIT_NULL_REF, head, '1'],
  } : action);
  const digest = crypto.createHash('sha256').update(JSON.stringify({ head, actions: digestActions })).digest('base64url');
  return Object.freeze({ state: 'awaiting-trust', actions: Object.freeze(actions), digest });
};

const derivePrimaryWorktreeRootFromGitDir = (gitDir: string) => primaryWorktreeRootFromGitDir(normalizePath(gitDir));

export async function resolvePrimaryWorktreeRoot(directory: string) {
  const result = await runGitCommand(directory, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  if (!result.success) {
    return { root: directory };
  }
  const lines = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const absoluteGitDir = normalizePath(normalizeGitOutputPath(lines[0] || ''));
  const rootFromAbsoluteGitDir = derivePrimaryWorktreeRootFromGitDir(absoluteGitDir);
  if (rootFromAbsoluteGitDir) {
    return { root: rootFromAbsoluteGitDir };
  }
  const rawCommonDir = normalizePath(normalizeGitOutputPath(lines[1] || ''));
  if (rawCommonDir) {
    const commonDir = path.isAbsolute(rawCommonDir)
      ? rawCommonDir
      : path.resolve(directory, rawCommonDir);
    const rootFromCommonDir = derivePrimaryWorktreeRootFromGitDir(commonDir);
    if (rootFromCommonDir) {
      return { root: rootFromCommonDir };
    }
  }
  return { root: directory };
}

export async function resolveRepositoryGitPaths(directory: string): Promise<RepositoryGitPaths> {
  const result = await runGitCommand(directory, [
    'rev-parse',
    '--absolute-git-dir',
    '--path-format=absolute',
    '--git-common-dir',
    '--is-bare-repository',
  ]);
  if (!result.success) {
    return { supported: false, reason: 'not-a-git-repository' };
  }
  const lines = String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return { supported: false, reason: 'unresolved-git-directory' };
  const gitDirectory = path.resolve(directory, lines[0] ?? '');
  const commonDirectory = path.resolve(directory, lines[1] ?? '');
  return {
    supported: true,
    gitDirectory,
    commonDirectory,
    bare: lines[2] === 'true',
  };
}

export function parseRemoteListing(names: string[], listing: string) {
  const urls = new Map<string | undefined, Record<string, string | undefined>>();
  for (const line of String(listing || '').split(/\r?\n/)) {
    const match = line.match(/^([^\t]+)\t(.*) \((fetch|push)\)/);
    if (!match) continue;
    const entry = urls.get(match[1]) ?? {};
    if (entry[match[3] ?? ''] === undefined) entry[match[3] ?? ''] = match[2];
    urls.set(match[1], entry);
  }
  return names.flatMap((name) => {
    const fetchUrl = urls.get(name)?.fetch;
    if (fetchUrl === undefined) return [];
    return [{ name, fetchUrl, pushUrl: urls.get(name)?.push ?? fetchUrl }];
  });
}

export async function getRepositoryRemoteUrls(directory: string, plannedRemote?: PlannedRemote) {
  const remotes = await readRepositoryRemoteUrls(directory, []);
  if (!plannedRemote || remotes.some((remote) => remote.name === plannedRemote.name)) return remotes;
  return readRepositoryRemoteUrls(directory, ['-c', `remote.${plannedRemote.name}.url=${plannedRemote.url}`]);
}

async function readRepositoryRemoteUrls(directory: string, configArgs: string[]) {
  const [namesResult, listResult] = await Promise.all([
    runGitCommand(directory, [...configArgs, 'remote']),
    runGitCommand(directory, [...configArgs, 'remote', '-v']),
  ]);
  if (!namesResult.success) return [];
  const names = String(namesResult.stdout || '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean).sort();
  if (listResult.success) return parseRemoteListing(names, listResult.stdout);
  const configured = await runGitCommand(directory, [...configArgs, 'config', '--name-only', '--get-regexp', '^remote\\..*\\.url$']);
  const withUrl = configured.success || configured.exitCode === 1
    ? new Set(String(configured.stdout || '').split(/\r?\n/).filter(Boolean).map((key) => key.slice('remote.'.length, -'.url'.length)))
    : null;
  return Promise.all(names.filter((name) => !withUrl || withUrl.has(name)).map(async (name) => {
    const [fetchResult, pushResult] = await Promise.all([
      runGitCommand(directory, [...configArgs, 'remote', 'get-url', name]),
      runGitCommand(directory, [...configArgs, 'remote', 'get-url', '--push', name]),
    ]);
    const fetchUrl = fetchResult.success ? String(fetchResult.stdout || '').trim() : '';
    const pushUrl = pushResult.success ? String(pushResult.stdout || '').trim() : fetchUrl;
    return { name, fetchUrl, pushUrl };
  }));
}

export async function resolveWorktreeTopLevel(directory: string) {
  const result = await runGitCommand(directory, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (!result.success) {
    return { root: directory };
  }
  const [rootLine = '', prefixLine = ''] = String(result.stdout || '').split('\n');
  const root = normalizePath(normalizeGitOutputPath(rootLine.trim()));
  return { root: root || directory, prefix: prefixLine.trim().replace(/\/+$/, '') };
}

export async function getCommitSummaries<Shas>(directory: string, shas: Shas) {
  const commits = Array.isArray(shas)
    ? shas.map((sha) => String(sha || '').trim()).filter(Boolean)
    : [];
  if (commits.length === 0) {
    return { commits: [] };
  }
  if (commits.some((sha) => !/^[0-9a-fA-F]{4,64}$/.test(sha))) {
    throw new Error('Invalid commit SHA');
  }
  const result = await runGitCommandOrThrow(
    directory,
    ['show', '-s', '--format=%H%x09%h%x09%s', ...commits, '--'],
    'Failed to get commit summaries'
  );
  const parsed = String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, short, subject] = line.split('\t');
      return { sha: sha || '', short: short || '', subject: subject || '' };
    })
    .filter((entry) => entry.sha && entry.short);
  return { commits: parsed };
}

const trimGitLines = (value: string) => String(value || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const normalizeIntegratePath = <Value>(value: Value, fieldName: string) => {
  const target = value === undefined ? value : normalizeDirectoryPath(value);
  if (!target || !isPrimitiveString(target)) {
    throw new Error(`${fieldName} is required`);
  }
  return path.resolve(target);
};

const runGitOk = (result: GitCommandResult) => Boolean(result?.success);

const ensureLocalIntegrateBranch = async (repoRoot: string, candidate: string) => {
  const raw = normalizeIntegrateBranch(candidate, 'targetBranch');
  if (raw === 'HEAD') {
    return 'HEAD';
  }

  const hasLocal = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${raw}`]);
  if (runGitOk(hasLocal)) {
    return raw;
  }

  if (raw.startsWith('remotes/')) {
    const remoteRef = raw.slice('remotes/'.length);
    const parts = remoteRef.split('/');
    const remote = normalizeIntegrateBranch(parts[0] || 'origin', 'remote');
    const name = normalizeIntegrateBranch(parts.slice(1).join('/'), 'branch');
    await runGitCommandOrThrow(repoRoot, ['branch', '--track', name, `${remote}/${name}`], 'Failed to track remote branch');
    return name;
  }

  const remoteCheck = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${raw}`]);
  if (runGitOk(remoteCheck)) {
    await runGitCommandOrThrow(repoRoot, ['branch', '--track', raw, `origin/${raw}`], 'Failed to track remote branch');
    return raw;
  }

  return raw;
};

export async function computeIntegratePlan(input: IntegratePlanInput = {}) {
  const repoRoot = normalizeIntegratePath(input.repoRoot, 'repoRoot');
  const sourceBranch = normalizeIntegrateBranch(input.sourceBranch, 'sourceBranch');
  const targetBranchRaw = normalizeIntegrateBranch(input.targetBranch, 'targetBranch');
  if (sourceBranch === 'HEAD' || targetBranchRaw === 'HEAD') {
    return { repoRoot, sourceBranch, targetBranch: targetBranchRaw, commits: [] };
  }

  const targetBranch = await ensureLocalIntegrateBranch(repoRoot, targetBranchRaw);
  const cherry = await runGitCommandOrThrow(repoRoot, ['cherry', targetBranch, sourceBranch], 'Failed to compute cherry commits');
  const plus = new Set<string>();
  for (const line of trimGitLines(cherry.stdout)) {
    const match = line.match(/^\+\s+([0-9a-f]{7,40})\b/i);
    if (match) {
      plus.add(match[1] ?? '');
    }
  }

  const revList = await runGitCommandOrThrow(repoRoot, ['rev-list', '--reverse', `${targetBranch}..${sourceBranch}`], 'Failed to list commits');
  const commits = trimGitLines(revList.stdout).filter((sha) => plus.has(sha));
  return { repoRoot, sourceBranch, targetBranch, commits };
}

const integrateCheckouts = createIntegrateCheckouts({
  runGit: (cwd, args) => runGitCommand(cwd, args),
  runGitOrThrow: runGitCommandOrThrow,
  publishChange: (repoRoot) => publishWorktreeTopologyChange(repoRoot),
  registry: worktreeRegistry,
});

const integratePublisher = createIntegratePublisher({
  runGit: (cwd, args) => runGitCommand(cwd, args),
  listWorktrees: (repoRoot) => listWorktreeEntries(repoRoot),
  pathExists: directoryExists,
});

export async function getIntegrateConflictDetails<Path>(tmpDir: Path) {
  const target = normalizeIntegratePath(tmpDir, 'tempWorktreePath');
  const [status, unmerged, diff, meta, patch] = await Promise.all([
    runGitCommand(target, ['status', '--porcelain']),
    runGitCommand(target, ['diff', '--name-only', '--diff-filter=U']),
    runGitCommand(target, ['diff', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']),
    runGitCommand(target, ['show', '--no-patch', '--pretty=fuller', 'CHERRY_PICK_HEAD']),
    runGitCommand(target, ['show', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', 'CHERRY_PICK_HEAD']),
  ]);

  return {
    statusPorcelain: String(status.stdout || ''),
    unmergedFiles: trimGitLines(unmerged.stdout),
    diff: String(diff.stdout || diff.stderr || ''),
    currentPatchMeta: String(meta.stdout || meta.stderr || ''),
    currentPatch: String(patch.stdout || patch.stderr || ''),
  };
}

export async function isIntegrateInProgress<Path>(tmpDir: Path) {
  const target = normalizeIntegratePath(tmpDir, 'tempWorktreePath');
  const head = await runGitCommand(target, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!runGitOk(head)) await assertRepositoryReachable(target);
  return { inProgress: runGitOk(head) };
}

const integration = createIntegration({
  runGit: (cwd, args) => runGitCommand(cwd, args),
  runGitOrThrow: runGitCommandOrThrow,
  publisher: integratePublisher,
  checkouts: integrateCheckouts,
  readDetails: getIntegrateConflictDetails,
  normalizePath: normalizeIntegratePath,
});
export const { integrateWorktreeCommits, abortIntegrate, continueIntegrate, listIntegrateConflicts } = integration;

const ensureOpenCodeProjectId = async (primaryWorktree: string) => {
  const gitDir = path.join(primaryWorktree, '.git');
  const idFile = path.join(gitDir, 'opencode');
  const existing = await fsp.readFile(idFile, 'utf8').then((value) => value.trim()).catch(() => '');
  if (existing) {
    return existing;
  }

  const rootsResult = await runGitCommandOrThrow(
    primaryWorktree,
    ['rev-list', '--max-parents=0', '--all'],
    'Failed to resolve repository roots'
  );

  const roots = rootsResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const projectId = roots[0] || '';
  if (!projectId) {
    throw new Error('Failed to derive OpenCode project ID');
  }

  await fsp.mkdir(gitDir, { recursive: true }).catch(() => undefined);
  await fsp.writeFile(idFile, projectId, 'utf8').catch(() => undefined);

  return projectId;
};

const resolveWorktreeProjectContext = async (directory: string, options: { tolerateWorktreeRootConfigError?: boolean } = {}) => {
  const tolerateWorktreeRootConfigError = options?.tolerateWorktreeRootConfigError === true;
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }

  const topResult = await runGitCommand(directoryPath, ['rev-parse', '--show-toplevel']);
  const sandbox = topResult.success
    ? path.resolve(directoryPath, normalizeGitOutputPath(topResult.stdout.trim()))
    : directoryPath;

  const commonResult = await runGitCommandOrThrow(
    sandbox,
    ['rev-parse', '--git-common-dir'],
    'Failed to resolve git common directory'
  );
  const commonDir = path.resolve(sandbox, normalizeGitOutputPath(commonResult.stdout.trim()));
  const primaryWorktree = derivePrimaryWorktreeRootFromGitDir(commonDir) || sandbox;
  const projectID = await ensureOpenCodeProjectId(primaryWorktree);
  const legacyWorktreeRoot = path.join(getOpenCodeDataPath(), 'worktree', projectID);
  let configuredWorktreeRoot = null;
  try {
    configuredWorktreeRoot = readWorktreeDirectorySetting(primaryWorktree);
  } catch (error) {
    if (!tolerateWorktreeRootConfigError) {
      throw error;
    }
    console.warn(
      'Failed to read OpenCode worktree.directory; using the data-dir worktree root:',
      error instanceof Error ? error.message : String(error),
    );
  }
  const worktreeRoot = configuredWorktreeRoot || legacyWorktreeRoot;

  return {
    projectID,
    requestedDirectory: directoryPath,
    sandbox,
    primaryWorktree,
    worktreeRoot,
    legacyWorktreeRoot,
  };
};

const listWorktreeEntries = worktreeRegistry.list;

const resolveWorktreeNameCandidates = (baseName: string) => {
  const normalizedBase = slugWorktreeName(baseName || '');
  if (!normalizedBase) {
    return Array.from({ length: OPENCODE_WORKTREE_ATTEMPTS }, () => generateOpenCodeRandomName());
  }
  return Array.from({ length: OPENCODE_WORKTREE_ATTEMPTS }, (_, index) => {
    if (index === 0) {
      return normalizedBase;
    }
    return `${normalizedBase}-${generateOpenCodeRandomName()}`;
  });
};

const resolveCandidateDirectory = async (worktreeRoot: string, preferredName: string, explicitBranchName: string, primaryWorktree: string) => {
  const candidates = resolveWorktreeNameCandidates(preferredName);

  for (const name of candidates) {
    const directory = path.join(worktreeRoot, name);
    if (await checkPathExists(directory)) {
      continue;
    }

    if (explicitBranchName) {
      return { name, directory, branch: explicitBranchName };
    }

    const branch = `openchamber/${name}`;
    const branchRef = `refs/heads/${branch}`;
    const branchExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', branchRef]);
    if (branchExists.success) {
      continue;
    }

    return { name, directory, branch };
  }

  throw new Error('Failed to generate a unique worktree name');
};

const resolveBranchForExistingMode = async (primaryWorktree: string, existingBranch: string, preferredBranchName: string) => {
  const requested = String(existingBranch || '').trim();
  if (!requested) {
    throw new Error('existingBranch is required in existing mode');
  }

  const normalizedLocal = cleanBranchName(requested);
  const localRef = `refs/heads/${normalizedLocal}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return {
      localBranch: normalizedLocal,
      checkoutRef: normalizedLocal,
      createLocalBranch: false,
      remoteRef: null,
    };
  }

  const remoteRef = parseRemoteBranchRef(requested);
  if (!remoteRef) {
    throw new Error(`Branch not found: ${requested}`);
  }

  const remoteCheck = await ensureLocalRemoteBranchRef(primaryWorktree, remoteRef.remote, remoteRef.branch);
  if (!remoteCheck.found) {
    throw new Error(`Remote branch not found: ${requested}`);
  }

  const localBranch = cleanBranchName(preferredBranchName || remoteRef.branch || requested);
  if (!localBranch) {
    throw new Error('Failed to resolve local branch name for existing branch worktree');
  }

  return {
    localBranch,
    checkoutRef: remoteRef.remoteRef,
    createLocalBranch: true,
    remoteRef,
  };
};

export async function isExistingBranchAvailableLocally(directory: string, existingBranch: string) {
  for (const ref of existingBranchLocalRefs(existingBranch)) {
    if ((await runGitCommand(directory, ['show-ref', '--verify', '--quiet', ref])).success) return true;
  }
  return false;
}

const findBranchInUse = async (primaryWorktree: string, localBranchName: string) => {
  if (!localBranchName) {
    return null;
  }
  const entries = await listWorktreeEntries(primaryWorktree);
  const targetRef = `refs/heads/${localBranchName}`;
  const targetClean = cleanBranchName(targetRef);
  return entries.find((entry) => {
    const entryRef = String(entry.branchRef || '').trim();
    const entryClean = cleanBranchName(entryRef || entry.branch || '');
    return entryRef === targetRef || entryClean === targetClean;
  }) || null;
};

const isBranchKeptOnWorktreeRemoval = async (primaryWorktree: string, branchName: string) => {
  if (await findBranchInUse(primaryWorktree, branchName)) return true;
  const { git } = await createRepositoryGitContext(primaryWorktree);
  return Object.values(await getRemoteDefaultBranches(git)).includes(branchName);
};

const killWorktreeCommand = (child: ChildProcess) => {
  if (process.platform === 'win32') {
    killProcessTree(child);
    return;
  }
  try {
    process.kill(-Number(child.pid), 'SIGKILL');
  } catch {
    void 0;
  }
};

const runWorktreeStartCommand = async (directory: string, command: string | undefined, { timeoutMs = 0, signal, env: extraEnv }: StartCommandOptions = {}): Promise<StartCommandResult> => {
  const text = String(command || '').trim();
  if (!text) {
    return { success: true };
  }
  const env = { ...(await buildGitEnv(directory)), ...extraEnv };
  if (await directoryReachability.isUnreachable(directory)) return { success: false, message: directoryUnreachableError(directory).message };
  if (signal?.aborted) {
    return { success: false, message: `${text} was cancelled` };
  }

  const windows = process.platform === 'win32';
  return new Promise<StartCommandResult>((resolve) => {
    const child = spawn(windows ? 'cmd' : 'bash', windows ? ['/c', text] : ['-lc', text], {
      cwd: directory,
      env,
      windowsHide: true,
      detached: !windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = { stdout: '', stderr: '' };
    let stopReason: string | null = null;
    const stop = (reason: string) => {
      stopReason ??= reason;
      killWorktreeCommand(child);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const collect = (stream: Readable) => {
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        output[stream === child.stdout ? 'stdout' : 'stderr'] += chunk;
        if (output.stdout.length + output.stderr.length > WORKTREE_COMMAND_OUTPUT_MAX_CHARS) {
          stop(`${text} wrote too much output`);
        }
      });
    };
    collect(child.stdout);
    collect(child.stderr);

    const cancel = () => stop(`${text} was cancelled`);
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = timeoutMs > 0
      ? setTimeout(() => stop(`${text} did not finish within ${Math.round(timeoutMs / 1000)} seconds`), timeoutMs)
      : null;
    const finish = (result: StartCommandResult) => {
      if (timeout !== null) clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      resolve({ ...result, ...output });
    };
    child.once('error', (error) => finish({ success: false, message: parseGitErrorText(error) }));
    child.once('close', (code) => {
      if (stopReason) finish({ success: false, message: stopReason });
      else if (code === 0) finish({ success: true });
      else finish({ success: false, message: parseGitErrorText({ ...output, message: `Command failed: ${text}\n${output.stderr}` }) });
    });
  });
};

const isAttachedGitWorktreeDirectory = async (directory: string) => {
  try {
    const result = await runGitCommand(directory, ['rev-parse', '--is-inside-work-tree']);
    return result.success && String(result.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
};

const cleanupFailedFastWorktreeCreate = async (context: WorktreeProjectContext, candidate: WorktreeCandidate, bootstrapStore?: BootstrapStore) => {
  const candidateDirectory = path.resolve(candidate.directory);
  const worktreeRoot = path.resolve(context.worktreeRoot);
  const isInsideWorktreeRoot = isInsideOrSameDirectory(worktreeRoot, candidateDirectory) && candidateDirectory !== worktreeRoot;
  const isAttached = await isAttachedGitWorktreeDirectory(candidateDirectory);

  if (!isInsideWorktreeRoot || isAttached) {
    return;
  }

  const key = await toCanonicalBootstrapStateKey(candidateDirectory);
  let directoryGone = false;
  try {
    const entries = await fsp.readdir(candidateDirectory);
    if (entries.length === 0) {
      await fsp.rmdir(candidateDirectory);
      directoryGone = true;
    }
  } catch (error) {
    if (errorField(error, 'code') === 'ENOENT') {
      directoryGone = true;
    } else if (!['ENOTEMPTY', 'EEXIST'].some((code) => code === errorField(error, 'code'))) {
      console.warn('Failed to clean up empty worktree directory after creation failure:', error instanceof Error ? error.message : String(error));
    }
  }
  if (!directoryGone) return;
  await releaseRolledBackAttemptFailure(key, bootstrapStore).catch((error) => {
    console.warn('Failed to release the bootstrap record of a rolled-back worktree:', error instanceof Error ? error.message : String(error));
  });
};

const WORKTREE_CREATE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const WORKTREE_CREATE_COMMAND_OUTPUT_MAX_CHARS = 2000;
const WORKTREE_CREATE_COMMAND_FAILED = 'WORKTREE_CREATE_COMMAND_FAILED';

const createCommandFailure = (message: string) => Object.assign(new Error(message), { code: WORKTREE_CREATE_COMMAND_FAILED });

const shownCommandFailure = (result: StartCommandResult, maxChars: number) => {
  const message = String(result.message || '');
  const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  const text = (message.startsWith('Command failed:') || !message) && output
    ? output
    : message || 'the command exited with an error';
  return text.length > maxChars ? `...${text.slice(-maxChars)}` : text;
};

const createWorktreeWithCommand = async ({ primaryWorktree, directory, branch, branchStart, command }: { primaryWorktree: string; directory: string; branch: string; branchStart: BranchStart | null; command: string }) => {
  if (branchStart) {
    const branchArgs = ['branch'];
    if (branchStart.noTrack) branchArgs.push('--no-track');
    if (branchStart.force) branchArgs.push('-f');
    branchArgs.push(branch, branchStart.start);
    await runGitCommandOrThrow(primaryWorktree, branchArgs, 'Failed to create git worktree');
  }
  const failure = (message: string) => Object.assign(createCommandFailure(message), { branchMade: Boolean(branchStart) });
  const result = await runWorktreeStartCommand(primaryWorktree, command, {
    timeoutMs: WORKTREE_CREATE_COMMAND_TIMEOUT_MS,
    env: { WORKTREE_PATH: directory, WORKTREE_BRANCH: branch },
  });
  const found = await findWorktreeAtPath(primaryWorktree, directory);
  if (found) await markWorktreeCreatedByCommand(found.path, found.path === directory ? '' : directory);
  if (!result.success) {
    throw failure(`Worktree create command failed: ${shownCommandFailure(result, WORKTREE_CREATE_COMMAND_OUTPUT_MAX_CHARS)}`);
  }
  if (!found) {
    throw failure(`The worktree create command finished, but no worktree of this repository is at ${directory}. It must create one there on branch ${branch}.`);
  }
  if (found.entry.branchRef !== `refs/heads/${branch}`) {
    throw failure(`The worktree create command checked out ${found.entry.branch || 'a detached HEAD'} at ${directory}, not ${branch}`);
  }
  return found.path;
};

const findWorktreeAtPath = async (primaryWorktree: string, directory: string) => {
  const real = await fsp.realpath(directory).catch(() => null);
  if (!real) return null;
  const realCanonical = await canonicalPath(real);
  for (const entry of await listWorktreeEntries(primaryWorktree)) {
    if (entry?.worktree && await canonicalPath(entry.worktree) === realCanonical) return { path: real, entry };
  }
  return null;
};

const CREATED_BY_COMMAND_MARK = 'openchamber-created-by-command';

const worktreeCreatedByCommandMarkPath = async (worktreeDirectory: string) => {
  const gitDir = await runGitCommand(worktreeDirectory, ['rev-parse', '--absolute-git-dir']);
  return gitDir.success ? path.join(normalizeGitOutputPath(gitDir.stdout.trim()), CREATED_BY_COMMAND_MARK) : null;
};

const markWorktreeCreatedByCommand = async (worktreeDirectory: string, link: string) => {
  const markPath = await worktreeCreatedByCommandMarkPath(worktreeDirectory);
  if (!markPath) return;
  await fsp.writeFile(markPath, link).catch((error) => {
    console.warn('Failed to mark a worktree made by the create command:', error instanceof Error ? error.message : String(error));
  });
};

const readWorktreeCreatedByCommand = async (worktreeDirectory: string) => {
  const markPath = await worktreeCreatedByCommandMarkPath(worktreeDirectory).catch(() => null);
  if (!markPath) return null;
  const link = await fsp.readFile(markPath, 'utf8').catch(() => null);
  return link === null ? null : { link: link.trim() };
};

const samePathOf = async (input: string) => path.join(await canonicalPath(path.dirname(input)), path.basename(input));

const removeCreateCommandLink = async (link: string | undefined, worktreeDirectory: string) => {
  if (!link) return;
  try {
    if (!(await fsp.lstat(link)).isSymbolicLink()) return;
    const target = path.resolve(path.dirname(link), await fsp.readlink(link));
    if (await samePathOf(target) !== await samePathOf(worktreeDirectory)) return;
    await fsp.unlink(link);
  } catch (error) {
    if (errorField(error, 'code') !== 'ENOENT') {
      console.warn('Failed to remove the link the worktree create command left:', error instanceof Error ? error.message : String(error));
    }
  }
};

const runWorktreeStartScripts = async (directory: string, projectDirectory: string, startCommand: string | undefined, signal: AbortSignal) => {
  const projectStart = await readProjectStartCommand(projectDirectory);
  if (projectStart) {
    const projectResult = await runWorktreeStartCommand(directory, projectStart, { signal });
    if (!projectResult.success) {
      console.warn('Worktree project start command failed:', projectResult.message || projectResult.stderr || projectResult.stdout);
      return;
    }
  }

  const extraCommand = String(startCommand || '').trim();
  if (!extraCommand) {
    return;
  }
  const extraResult = await runWorktreeStartCommand(directory, extraCommand, { signal });
  if (!extraResult.success) {
    console.warn('Worktree start command failed:', extraResult.message || extraResult.stderr || extraResult.stdout);
  }
};

const queueWorktreeBootstrap = (args: WorktreeBootstrapTask) => {
  const {
    directory,
    projectDirectory,
    primaryWorktree,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand,
    contributorFork,
    hydrateCheckout,
    checkoutRemoteName,
    bootstrapStore,
    populated,
    resumed,
    disposeInstance,
  } = args;
  const setupKey = toBootstrapStateKey(directory);
  const setupCancellation = new AbortController();
  worktreeSetupCancellations.set(setupKey, setupCancellation);
  const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(async () => {
      if (!populated) await populateWorktreeWithLockRecovery(directory);
      const hydration = hydrateCheckout ? await hydrateCheckout({
        directory,
        parentRemoteName: checkoutRemoteName,
      }) : null;
      if (hydrateCheckout && !hydration) {
        throw new Error('Worktree checkout hydration returned no result');
      }
      if (hydration && !['succeeded', 'not-needed'].includes(hydration.status)) {
        const itemError = [...hydration.submodules, ...hydration.lfs]
          .find((item) => item.status === hydration.status)?.error;
        throw Object.assign(new Error(itemError?.message || 'Worktree checkout hydration did not complete'), {
          code: itemError?.code || 'TRANSPORT_FAILED', hydration,
        });
      }
      if (setUpstream) {
        await applyUpstreamConfiguration({
          primaryWorktree,
          worktreeDirectory: directory,
          localBranch,
          setUpstream,
          upstreamRemote,
          upstreamBranch,
          ensureRemoteName,
          ensureRemoteUrl,
        }).catch((error) => {
          console.warn('Worktree upstream configuration failed:', error instanceof Error ? error.message : String(error));
        });
      }
      if (resumed) await disposeWorktreeInstanceBestEffort(disposeInstance, directory);
      await setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_PENDING,
        WORKTREE_BOOTSTRAP_PHASE_GIT_READY,
        null,
        undefined,
        undefined,
        bootstrapStore,
      );
      if (!contributorFork) {
        await runWorktreeStartScripts(directory, projectDirectory, startCommand, setupCancellation.signal).catch((error) => {
          console.warn('Worktree start script task failed:', error instanceof Error ? error.message : String(error));
        });
      }
      await setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_READY,
        WORKTREE_BOOTSTRAP_PHASE_SETUP_READY,
        null,
        undefined,
        undefined,
        bootstrapStore,
      );
    })
    .catch(async <Failure>(error: Failure) => {
      const recordedPhase = worktreeBootstrapState.get(await toCanonicalBootstrapStateKey(directory))?.phase;
      const hydration = errorField(error, 'hydration');
      const pathLengthFailure = !hydration
        && isFilenameTooLongError(error instanceof Error ? error.message : error);
      const failureCode = bootstrapFailureCode(error, pathLengthFailure);
      const publicMessage = hydration
        ? error instanceof Error ? error.message : 'Worktree checkout hydration did not complete'
        : pathLengthFailure
          ? formatWorktreePopulateError(error instanceof Error ? error.message : error)
          : worktreeBootstrapFailureMessage(failureCode)
            ?? 'Worktree bootstrap failed. Inspect the checkout and repair it before use.';
      await setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_FAILED,
        recordedPhase === WORKTREE_BOOTSTRAP_PHASE_GIT_READY
          ? WORKTREE_BOOTSTRAP_PHASE_GIT_READY
          : WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
        publicMessage,
        hydration,
        failureCode,
        bootstrapStore,
      ).catch(() => {});
      console.warn('Worktree bootstrap task failed:', error instanceof Error ? error.message : String(error));
    });

  const forgetCancellation = () => worktreeSetupCancellations.delete(setupKey);
  void task.then(forgetCancellation, forgetCancellation);
  trackWorktreeBootstrapTask(directory, task);
};

const startWorktreeBootstrap = async (task: WorktreeBootstrapTask) => {
  let bootstrapStatus;
  try {
    bootstrapStatus = await setWorktreeBootstrapState(
      task.directory,
      WORKTREE_BOOTSTRAP_PENDING,
      WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
      null,
      undefined,
      undefined,
      task.bootstrapStore,
    );
  } catch (error) {
    if (!isBootstrapPersistenceFailure(error)) throw error;
    bootstrapStatus = error.bootstrapStatus;
  }
  if (bootstrapStatus === null) throw new TypeError('Missing worktree bootstrap state');
  if (bootstrapStatus.status === WORKTREE_BOOTSTRAP_PENDING) queueWorktreeBootstrap(task);
  return bootstrapStatus;
};

const remoteProvisioning = createRemoteProvisioning({ runGitCommand, runGitCommandOrThrow });
const {
  networkRemoteName, withRemoteProvisioningQueue, isSameRemoteUrl, ensureRemoteWithUrlUnlocked,
  ensureRemoteWithUrl, captureRemoteUrl, restoreProvisionedRemote,
} = remoteProvisioning;

const resolveExistingWorktreeSource = async (primaryWorktree: string, input: WorktreeCreateInput = {}, intent = 'create') => {
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
  const requestedExistingBranch = String(input?.existingBranch || '').trim();
  const wantUpstream = Boolean(input?.setUpstream);
  const explicitUpstreamRemote = String(input?.upstreamRemote || '').trim();
  const explicitUpstreamBranch = String(input?.upstreamBranch || '').trim();
  const expectedRevision = String(input?.expectedRevision || '').trim();
  const contributorTransferComplete = input?.contributorFork === true
    && input?.contributorTransferComplete === true;
  const parsedExistingRemote = await resolveRemoteBranchRef(primaryWorktree, requestedExistingBranch);

  if (
    parsedExistingRemote
    && ensureRemoteName
    && ensureRemoteUrl
    && parsedExistingRemote.remote === ensureRemoteName
  ) {
    if (contributorTransferComplete) {
      if (intent === 'create') {
        await ensureRemoteWithUrlUnlocked(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
      }
      const transferredRevision = await runGitCommand(
        primaryWorktree,
        ['rev-parse', '--verify', parsedExistingRemote.remoteRef]
      );
      if (!transferredRevision.success
        || (expectedRevision && String(transferredRevision.stdout || '').trim() !== expectedRevision)) {
        throw new Error('Transferred branch revision does not match the requested change request head');
      }
    } else {
      if (intent === 'create') {
        await ensureRemoteWithUrlUnlocked(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
      }
      const localRevision = await runGitCommand(
        primaryWorktree,
        ['rev-parse', '--verify', parsedExistingRemote.remoteRef]
      );
      if (!localRevision.success) {
        throw new Error(`Remote branch is not available locally: ${parsedExistingRemote.remoteRef}. Transfer it explicitly and retry.`);
      }
      if (expectedRevision && String(localRevision.stdout || '').trim() !== expectedRevision) {
        throw new Error('Remote branch revision does not match the requested change request head');
      }
    }

    const localBranch = cleanBranchName(preferredBranchName || parsedExistingRemote.branch);
    return {
      localBranch,
      checkoutRef: parsedExistingRemote.remoteRef,
      createLocalBranch: true,
      setUpstream: wantUpstream,
      upstream: {
        remote: explicitUpstreamRemote || parsedExistingRemote.remote,
        branch: explicitUpstreamBranch || parsedExistingRemote.branch,
      },
    };
  }

  if (!requestedExistingBranch) {
    throw new Error('existingBranch is required in existing mode');
  }

  const resolved = await resolveBranchForExistingMode(
    primaryWorktree,
    requestedExistingBranch,
    preferredBranchName
  );
  if (expectedRevision) {
    const resolvedRevision = await runGitCommand(primaryWorktree, ['rev-parse', '--verify', resolved.checkoutRef]);
    if (!resolvedRevision.success || String(resolvedRevision.stdout || '').trim() !== expectedRevision) {
      throw new Error('Existing branch revision does not match the requested change request head');
    }
  }
  const upstream = resolved.remoteRef
    ? {
        remote: explicitUpstreamRemote || resolved.remoteRef.remote,
        branch: explicitUpstreamBranch || resolved.remoteRef.branch,
      }
    : (explicitUpstreamRemote && explicitUpstreamBranch
      ? { remote: explicitUpstreamRemote, branch: explicitUpstreamBranch }
      : null);

  return {
    localBranch: resolved.localBranch,
    checkoutRef: resolved.checkoutRef,
    createLocalBranch: resolved.createLocalBranch,
    setUpstream: wantUpstream && Boolean(upstream),
    upstream,
  };
};

const ensureLocalRemoteBranchRef = async (primaryWorktree: string, remoteName: string, branchName: string) => {
  const localCheck = await checkLocalRemoteBranchExists(primaryWorktree, remoteName, branchName);
  if (localCheck.found || !localCheck.success) return localCheck;
  await fetchRemoteBranchRef(primaryWorktree, remoteName, branchName).catch(() => undefined);
  return checkLocalRemoteBranchExists(primaryWorktree, remoteName, branchName);
};

const checkLocalRemoteBranchExists = async (primaryWorktree: string, remoteName: string, branchName: string) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return { success: false, found: false };
  }

  const localRef = await runGitCommand(
    primaryWorktree,
    ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]
  );
  return {
    success: true,
    found: localRef.success,
  };
};

const applyUpstreamConfiguration = async (args: UpstreamConfiguration) => {
  const {
    primaryWorktree,
    worktreeDirectory,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
  } = args;

  if (!setUpstream) {
    return;
  }

  if (ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  const upstream = normalizeUpstreamTarget(upstreamRemote, upstreamBranch);
  if (!upstream || !localBranch) {
    return;
  }

  const upstreamRef = await runGitCommand(
    primaryWorktree,
    ['show-ref', '--verify', '--quiet', `refs/remotes/${upstream.remote}/${upstream.branch}`]
  );
  if (!upstreamRef.success) {
    return;
  }

  await runGitCommandOrThrow(
    worktreeDirectory,
    ['branch', `--set-upstream-to=${upstream.full}`, localBranch],
    `Failed to set upstream to ${upstream.full}`
  );
};

const warnedUnsupportedRoots = new Set<string>();

const probeFailureMessage = (result: GitCommandResult) => {
  if (result.timedOut) return `Git did not answer within ${GIT_PROBE_TIMEOUT_MS / 1000} seconds.`;
  if (result.spawnFailed) return `Git could not be started: ${result.message}`;
  return result.stderr.trim() || result.message || 'Git could not read this directory.';
};

const probeRepository = async (directoryPath: string, { strict = false, failOnGitError = strict }: { strict?: boolean; failOnGitError?: boolean } = {}) => {
  const notRepository = { isRepository: false, repoRoot: null };
  if (!directoryPath || !await directoryExists(directoryPath)) {
    if (directoryPath) await assertPathReachable(path.resolve(directoryPath));
    if (strict) throw new Error('Project directory does not exist or is inaccessible');
    return notRepository;
  }

  await assertLinkedRepositoryReachable(directoryPath);
  const options: GitCommandOptions = { timeoutMs: GIT_PROBE_TIMEOUT_MS };
  if (failOnGitError) options.env = { ...await buildGitEnv(directoryPath), LC_ALL: 'C' };
  const result = await runGitCommand(directoryPath, ['rev-parse', '--git-dir', '--show-toplevel'], options);
  const [gitDir = '', topLevel = ''] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!gitDir) await assertRepositoryReachable(directoryPath);
  if (failOnGitError && !result.success) {
    if (result.exitCode === 128 && !gitDir && /^fatal: not a git repository \(or any (?:of the parent directories\):|parent up to mount point [^\r\n]+\))/i.test(result.stderr.trim())) {
      return notRepository;
    }
    if (!(gitDir && result.exitCode === 128 && /must be run in a work tree/i.test(result.stderr))) {
      throw Object.assign(new Error(probeFailureMessage(result)), { code: 'GIT_REPOSITORY_UNREADABLE' });
    }
  }
  if (!gitDir && result.timedOut) throw Object.assign(new Error(probeFailureMessage(result)), { code: 'GIT_REPOSITORY_UNREADABLE' });
  if (!gitDir) return notRepository;
  if (!result.success) return { isRepository: true, repoRoot: null };

  const reason = unsupportedRepositoryRootReason(topLevel);
  if (!reason) {
    return { isRepository: true, repoRoot: topLevel ? toRepositoryRoot(directoryPath, topLevel) : null };
  }
  if (!warnedUnsupportedRoots.has(topLevel)) {
    warnedUnsupportedRoots.add(topLevel);
    console.warn(`[git] Ignoring repository rooted at ${topLevel} (${reason}): Git features are disabled for ${directoryPath}`);
  }
  return notRepository;
};

export async function isGitRepository(directory: string, options?: { strict?: boolean; failOnGitError?: boolean }) {
  return (await probeRepository(normalizeDirectoryPath(directory), options)).isRepository;
}

export async function getGlobalIdentity() {
  const git = await createGitForGlobalConfig();

  try {
    const userName = await git.getConfig('user.name', 'global').catch(() => null);
    const userEmail = await git.getConfig('user.email', 'global').catch(() => null);
    const sshCommand = await git.getConfig('core.sshCommand', 'global').catch(() => null);

    return {
      userName: userName?.value || null,
      userEmail: userEmail?.value || null,
      sshCommand: sshCommand?.value || null
    };
  } catch (error) {
    console.error('Failed to get global Git identity:', error);
    return {
      userName: null,
      userEmail: null,
      sshCommand: null
    };
  }
}

export async function getRemoteUrl(directory: string, remoteName = 'origin') {
  const git = await createGit(directory);

  try {
    const url = await git.remote(['get-url', '--', remoteName]);
    return url?.trim() || null;
  } catch {
    return null;
  }
}

export async function getCurrentIdentity(directory: string) {
  const git = await createGit(directory);
  const localOrGlobal = async (key: string) => {
    const local = await git.getConfig(key, 'local').catch(() => null);
    if (local?.value) return local.value;
    const global = await git.getConfig(key, 'global').catch(() => null);
    return global?.value || null;
  };

  try {
    const [userName, userEmail, sshCommand] = await Promise.all([
      localOrGlobal('user.name'),
      localOrGlobal('user.email'),
      localOrGlobal('core.sshCommand'),
    ]);
    return { userName, userEmail, sshCommand };
  } catch (error) {
    console.error('Failed to get current Git identity:', error);
    return {
      userName: null,
      userEmail: null,
      sshCommand: null
    };
  }
}

export async function hasLocalIdentity(directory: string) {
  const git = await createGit(directory);

  try {
    const localUserName = await git.getConfig('user.name', 'local').catch(() => null);
    const localUserEmail = await git.getConfig('user.email', 'local').catch(() => null);
    return Boolean(localUserName?.value?.trim() && localUserEmail?.value?.trim());
  } catch {
    return false;
  }
}

export async function clearLocalIdentity(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  for (const key of ['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'gpg.format']) {
    const removed = await runGitCommand(directoryPath, ['config', '--local', '--unset-all', key]);
    if (!removed.success && removed.exitCode !== 5) {
      throw new Error(removed.stderr.trim() || `Failed to clear ${key}`);
    }
  }
  return true;
}

export async function setLocalIdentity(directory: string, profile: { userName: string; userEmail: string; signCommits?: unknown; signingKey?: unknown }) {
  const git = await createGit(directory);

  try {
    await git.addConfig('user.name', profile.userName, false, 'local');
    await git.addConfig('user.email', profile.userEmail, false, 'local');

    if (profile.signCommits === true && isPrimitiveString(profile.signingKey) && profile.signingKey.trim()) {
      await git.addConfig('gpg.format', 'ssh', false, 'local');
      await git.addConfig('user.signingkey', profile.signingKey.trim(), false, 'local');
      await git.addConfig('commit.gpgsign', 'true', false, 'local');
    }

    return true;
  } catch (error) {
    console.error('Failed to set Git identity:', error);
    throw error;
  }
}

export async function configureRepositoryTransport(directory: string, { credentialHelper = null, sshCommand = null }: { credentialHelper?: string | null; sshCommand?: string | null } = {}) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!isPrimitiveString(directoryPath) || !directoryPath.trim()) throw new Error('Git directory is required');
  const config = (args: string[]) => runGitCommand(directoryPath, ['config', '--local', ...args]);
  const ourHelper = (value: string) => value.startsWith('!') && /git-credential-openchamber/.test(value);
  const helpers = await config(['--get-all', 'credential.helper']);
  if (!helpers.success && helpers.exitCode !== 1) throw new Error(helpers.stderr || 'Failed to read the repository credential helper');
  const current = helpers.success ? helpers.stdout.replace(/\n$/, '').split('\n') : [];
  const others = [];
  for (const value of current) {
    if (!ourHelper(value)) { others.push(value); continue; }
    if (others.at(-1) === '') others.pop();
  }
  const wanted = credentialHelper ? [...others, '', credentialHelper] : others;
  if (JSON.stringify(current) !== JSON.stringify(wanted)) {
    const removed = await config(['--unset-all', 'credential.helper']);
    if (!removed.success && removed.exitCode !== 5) throw new Error(removed.stderr || 'Failed to update the repository credential helper');
    for (const value of wanted) {
      const added = await config(['--add', 'credential.helper', value]);
      if (!added.success) throw new Error(added.stderr || 'Failed to write the repository credential helper');
    }
  }
  const ownedPathKey = 'openchamber.credentialusehttppath';
  const owned = (await config(['--get', ownedPathKey])).success;
  if (credentialHelper && !owned) {
    const existingPath = await config(['--get', 'credential.useHttpPath']);
    if (!existingPath.success && existingPath.exitCode !== 1) throw new Error(existingPath.stderr || 'Failed to read the repository credential settings');
    if (!existingPath.success) {
      for (const args of [['credential.useHttpPath', 'true'], [ownedPathKey, 'true']]) {
        const written = await config(args);
        if (!written.success) throw new Error(written.stderr || 'Failed to write the repository credential settings');
      }
    }
  } else if (!credentialHelper && owned) {
    for (const key of ['credential.useHttpPath', ownedPathKey]) {
      const removed = await config(['--unset-all', key]);
      if (!removed.success && removed.exitCode !== 5) throw new Error(removed.stderr || 'Failed to remove the repository credential settings');
    }
  }
  const currentSsh = await config(['--get', 'core.sshCommand']);
  const existingSsh = currentSsh.success ? currentSsh.stdout.trim() : '';
  const oursSsh = /ssh-wrapper\.js/.test(existingSsh);
  if (sshCommand) {
    if (existingSsh !== sshCommand) {
      const written = await config(['core.sshCommand', sshCommand]);
      if (!written.success) throw new Error(written.stderr || 'Failed to write the repository SSH command');
    }
  } else if (oursSsh) {
    const removed = await config(['--unset', 'core.sshCommand']);
    if (!removed.success && removed.exitCode !== 5) throw new Error(removed.stderr || 'Failed to remove the repository SSH command');
  }
  return true;
}

const UNTRACKED_DIRECTORY_EXPANSION_LIMIT = 1000;

const GIT_STATUS_STALL_TIMEOUT_MS = 120_000;
const GIT_UNTRACKED_LISTING_STALL_TIMEOUT_MS = 60_000;
const GIT_PROBE_TIMEOUT_MS = 30_000;

const killProcessTree = (child: ChildProcess) => {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  child.kill('SIGKILL');
};

const listUntrackedFilesBounded = async (repoRoot: string, dirPath: string, limit: number) => {
  const env = await buildGitEnv(repoRoot);
  await directoryReachability.assertReachable(repoRoot);
  return new Promise<{ paths: string[]; truncated: boolean }>((resolve, reject) => {
    const child = spawn(getGitBinary(), gitArgsIn(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', dirPath]), {
      cwd: GIT_LAUNCH_DIRECTORY,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const paths: string[] = [];
    let pending = '';
    let truncated = false;
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (stallTimer) clearTimeout(stallTimer);
      if (error) {
        reject(error);
        return;
      }
      resolve({ paths, truncated });
    };
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        killProcessTree(child);
        finish(new Error(`git ls-files produced no output for ${GIT_UNTRACKED_LISTING_STALL_TIMEOUT_MS}ms in ${dirPath}`));
      }, GIT_UNTRACKED_LISTING_STALL_TIMEOUT_MS);
    };
    armStallTimer();
    child.stdout.on('data', (chunk) => {
      armStallTimer();
      if (truncated) return;
      pending += chunk.toString('utf8');
      const records = pending.split('\0');
      pending = records.pop() ?? '';
      for (const record of records) {
        if (!record) continue;
        paths.push(record);
        if (paths.length > limit) {
          truncated = true;
          killProcessTree(child);
          finish();
          return;
        }
      }
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (truncated) {
        finish();
        return;
      }
      if (code !== 0) {
        finish(new Error(`git ls-files exited with code ${code} for ${dirPath}`));
        return;
      }
      if (pending) paths.push(pending);
      finish();
    });
  });
};

const expandUntrackedDirectories = async (repoRoot: string, files: FileStatusResult[]) => {
  const expanded = [];
  for (const file of files) {
    const isUntrackedDirectory = file.path.endsWith('/')
      && (file.working_dir || '').trim() === '?'
      && (file.index || '').trim() === '?';
    if (!isUntrackedDirectory) {
      expanded.push(file);
      continue;
    }
    const listing = await listUntrackedFilesBounded(repoRoot, file.path, UNTRACKED_DIRECTORY_EXPANSION_LIMIT)
      .catch((error) => {
        console.warn(`[GitService] Could not expand untracked directory ${file.path}:`, error?.message || error);
        return null;
      });
    if (!listing || listing.truncated || listing.paths.some((entry) => entry === file.path)) {
      expanded.push(file);
      continue;
    }
    for (const entryPath of listing.paths) {
      expanded.push({ ...file, path: entryPath });
    }
  }
  return expanded;
};

const MAX_CONCURRENT_STATUS_READS = 4;
const statusRefresh = createSerialRefresh<{ lightMode: boolean }, Awaited<ReturnType<typeof readStatus>>>({ maxConcurrent: MAX_CONCURRENT_STATUS_READS });

export async function getStatus(directory: string, options: { mode?: string | undefined } = {}) {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  if (!isPrimitiveString(normalizedDirectory) || !normalizedDirectory.trim()) {
    throw new Error('directory is required');
  }
  const lightMode = options.mode === 'light';
  return statusRefresh.run(
    normalizedDirectory,
    { lightMode },
    (requests) => readStatus(normalizedDirectory, requests.every((request) => request.lightMode)),
  );
}

export async function getTrackingBranch(directory: string) {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  if (!normalizedDirectory) {
    return null;
  }
  const head = await runGitCommand(normalizedDirectory, ['symbolic-ref', '--quiet', 'HEAD']);
  const headRef = head.success ? head.stdout.trim() : '';
  if (!headRef.startsWith('refs/heads/')) {
    return null;
  }
  const upstream = await runGitCommand(normalizedDirectory, ['for-each-ref', '--format=%(upstream:short)', headRef]);
  const tracking = upstream.success ? upstream.stdout.trim() : '';
  return tracking || null;
}

export async function getCheckedOutBranch(directory: string) {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  if (!normalizedDirectory) {
    throw new Error('directory is required to read the checked-out branch');
  }
  const head = await runGitCommand(normalizedDirectory, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.success) return head.stdout.trim();
  if ((head.exitCode === 1 && !head.stderr.trim()) || isNotGitRepositoryError(head.message)) {
    await assertRepositoryReachable(normalizedDirectory);
    return '';
  }
  throw new Error(head.message || 'Failed to read the checked-out branch');
}

export async function getPathsWithoutChanges(directory: string, paths: string[]) {
  const unchanged = [];
  for (const filePath of paths) {
    const status = await runGitCommand(directory, [
      '--literal-pathspecs', 'status', '--porcelain', '--untracked-files=all', '--', filePath,
    ]);
    if (!status.success || !status.stdout.trim()) unchanged.push(filePath);
  }
  return unchanged;
}

export async function isAncestorOfHead(directory: string, sha: string) {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  const normalizedSha = isPrimitiveString(sha) ? sha.trim() : '';
  if (!normalizedDirectory || !/^[0-9a-f]{7,64}$/i.test(normalizedSha)) {
    return false;
  }
  const result = await runGitCommand(normalizedDirectory, ['merge-base', '--is-ancestor', normalizedSha, 'HEAD']);
  return result.success;
}

const PATCH_EQUIVALENCE_TIMEOUT_MS = 5_000;

export async function isPatchEquivalentOfHead(directory: string, sha: string) {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  const normalizedSha = String(sha ?? '').trim();
  if (!normalizedDirectory || !/^[0-9a-f]{7,64}$/i.test(normalizedSha)) {
    return false;
  }

  const cherry = await runGitCommand(
    normalizedDirectory,
    ['cherry', 'HEAD', normalizedSha, `${normalizedSha}^`],
    { timeoutMs: PATCH_EQUIVALENCE_TIMEOUT_MS },
  );
  if (!cherry.success) {
    return false;
  }

  const expectedPrefix = normalizedSha.toLowerCase();
  return cherry.stdout.split(/\r?\n/).some((line) => {
    const match = line.match(/^-\s+([0-9a-f]{40,64})$/i);
    return Boolean(match?.[1]) && (match?.[1] ?? '').toLowerCase().startsWith(expectedPrefix);
  });
}

async function readStatus(normalizedDirectory: string, lightMode: boolean) {
  try {
    const repository = await probeRepository(normalizedDirectory);
    if (!repository.isRepository) {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    }

    const gitOptions = { stallTimeoutMs: GIT_STATUS_STALL_TIMEOUT_MS, optionalLocks: false };
    const { directoryPath, repoRoot, git } = repository.repoRoot
      ? { directoryPath: normalizedDirectory, repoRoot: repository.repoRoot, git: await createGit(repository.repoRoot, gitOptions) }
      : await createRepositoryGitContext(normalizedDirectory, gitOptions);

    const [status, headProbe] = await Promise.all([
      git.status(['-unormal']),
      runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: GIT_PROBE_TIMEOUT_MS }),
    ]);
    status.files = await expandUntrackedDirectories(repoRoot, status.files);

    const [stagedStatsRaw, workingStatsRaw] = lightMode
      ? ['', '']
      : await Promise.all([
          git.raw(['diff', '--cached', '--numstat', '-z']).catch(() => ''),
          git.raw(['diff-files', '-M', '--numstat', '-z']).catch(() => ''),
        ]);

    const stagedDiffStats: Record<string, DiffStats> = {};
    const workingDiffStats: Record<string, DiffStats> = {};

    const accumulateStats = (raw: string, target: Record<string, DiffStats>) => {
      if (!raw) return;
      const tokens = raw.split('\0');
      for (let index = 0; index < tokens.length; index += 1) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(String(tokens[index]));
        if (!match) continue;
        let path = match[3];
        if (!path) {
          path = tokens[index + 2];
          index += 2;
        }
        if (!path) continue;
        const insertions = match[1] === '-' ? 0 : parseInt(String(match[1]), 10) || 0;
        const deletions = match[2] === '-' ? 0 : parseInt(String(match[2]), 10) || 0;

        const existing = target[path] || { insertions: 0, deletions: 0 };
        target[path] = {
          insertions: existing.insertions + insertions,
          deletions: existing.deletions + deletions,
        };
      }
    };

    accumulateStats(stagedStatsRaw, stagedDiffStats);
    accumulateStats(workingStatsRaw, workingDiffStats);

    const diffStats = { staged: stagedDiffStats, working: workingDiffStats };

    const MAX_NEW_FILE_STATS = 200;
    const MAX_NEW_FILE_STAT_SIZE = 1024 * 1024;
    const newFileStats = [];

    if (!lightMode) {
      for (const file of status.files) {
        if (newFileStats.length >= MAX_NEW_FILE_STATS) {
          break;
        }

        const working = (file.working_dir || '').trim();
        const indexStatus = (file.index || '').trim();
        const statusCode = working || indexStatus;

        if (statusCode !== '?' && statusCode !== 'A') {
          continue;
        }

        const target = working === '?' || working === 'A' ? workingDiffStats : stagedDiffStats;
        const existing = target[file.path];
        if (existing && existing.insertions > 0) {
          continue;
        }

        const absolutePath = path.join(repoRoot, file.path);

        try {
          const stat = await fsp.stat(absolutePath);
          if (!stat.isFile() || stat.size > MAX_NEW_FILE_STAT_SIZE) {
            continue;
          }

          const buffer = await fsp.readFile(absolutePath);
          if (buffer.indexOf(0) !== -1) {
            newFileStats.push({
              target,
              path: file.path,
              insertions: existing?.insertions ?? 0,
              deletions: existing?.deletions ?? 0,
            });
            continue;
          }

          const normalized = buffer.toString('utf8').replace(/\r\n/g, '\n');
          if (!normalized.length) {
            newFileStats.push({
              target,
              path: file.path,
              insertions: 0,
              deletions: 0,
            });
            continue;
          }

          const segments = normalized.split('\n');
          if (normalized.endsWith('\n')) {
            segments.pop();
          }

          const lineCount = segments.length;
          newFileStats.push({
            target,
            path: file.path,
            insertions: lineCount,
            deletions: 0,
          });
        } catch (error) {
          if (errorField(error, 'code') !== 'ENOENT') {
            console.warn('Failed to estimate diff stats for new file', file.path, error);
          }
        }
      }
    }

    for (const entry of newFileStats) {
      entry.target[entry.path] = {
        insertions: entry.insertions,
        deletions: entry.deletions,
      };
    }

    const selectBaseRefForUnpublished = async () => {
      const parent = status.current ? await readBranchBase(git, repoRoot, status.current).then(({ base }) => base, () => null) : null;
      const remotes = parent ? String(await git.raw(['remote']).catch(() => '')).split('\n').map((name) => name.trim()).filter(Boolean) : [];
      const candidates = parent ? [parent, ...remotes.map((remote) => `${remote}/${parent}`)] : [];

      const originHead = await git
        .raw(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
        .then((value) => String(value || '').trim())
        .catch(() => '');

      if (originHead) {
        candidates.push(originHead.replace(/^refs\/remotes\//, ''));
      }

      candidates.push('origin/main', 'origin/master', 'main', 'master');

      for (const ref of candidates) {
        if (ref === status.current) continue;
        const exists = await git
          .raw(['rev-parse', '--verify', ref])
          .then((value) => String(value || '').trim())
          .catch(() => '');
        if (exists) return ref;
      }

      return null;
    };

    const tracking = status.tracking || null;
    let ahead = status.ahead;
    let behind = status.behind;
    let aheadBase = null;
    let upstreamComparison;

    if (!lightMode && !tracking && status.current) {
      const baseRef = await selectBaseRefForUnpublished();
      if (baseRef) {
        const countRaw = await git
          .raw(['rev-list', '--count', 'HEAD', '--not', baseRef, '--remotes'])
          .then((value) => String(value || '').trim())
          .catch(() => '');
        const count = parseInt(countRaw, 10);
        if (Number.isFinite(count)) {
          ahead = count;
          behind = 0;
          aheadBase = baseRef;
        }
      }
    }

    if (
      !lightMode
      && status.current
      && (!tracking || !tracking.startsWith('upstream/'))
      && await hasRemote(git, directoryPath, 'upstream')
    ) {
      upstreamComparison = await getRemoteBranchComparison(git, 'upstream', status.current);
    }

    let mergeInProgress = null;
    let rebaseInProgress = null;
    const [mergeHeadPath = '', mergeMsgPath = '', rebaseMergePath = '', rebaseApplyPath = ''] = await git
      .raw(['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'MERGE_MSG', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply'])
      .then((value) => String(value || '').split(/\r?\n/).slice(0, 4).map((line) => (
        line.trim() ? path.resolve(repoRoot, normalizeGitOutputPath(line.trim())) : ''
      )))
      .catch(() => []);
    const pathExists = (target: string) => (target ? fsp.stat(target).then(() => true).catch(() => false) : false);

    try {
      if (await pathExists(mergeHeadPath)) {
        const mergeHead = await git.raw(['rev-parse', 'MERGE_HEAD']).catch(() => '');
        const headSha = mergeHead.trim().slice(0, 7);
        if (headSha) {
          const mergeMsg = mergeMsgPath ? await fsp.readFile(mergeMsgPath, 'utf8').catch(() => '') : '';
          mergeInProgress = {
            head: headSha,
            message: mergeMsg.split('\n')[0] || '',
          };
        }
      }
    } catch {
      void 0;
    }

    try {
      const rebaseMergeExists = await pathExists(rebaseMergePath);
      const rebaseApplyExists = await pathExists(rebaseApplyPath);
      
      if (rebaseMergeExists || rebaseApplyExists) {
        const rebasePath = rebaseMergeExists ? rebaseMergePath : rebaseApplyPath;
        const headName = await fsp.readFile(path.join(rebasePath, 'head-name'), 'utf8').catch(() => '');
        const onto = await fsp.readFile(path.join(rebasePath, 'onto'), 'utf8').catch(() => '');
        
        const headNameTrimmed = headName.trim().replace('refs/heads/', '');
        const ontoTrimmed = onto.trim().slice(0, 7);
        
        if (headNameTrimmed || ontoTrimmed) {
          rebaseInProgress = {
            headName: headNameTrimmed,
            onto: ontoTrimmed,
          };
        }
      }
    } catch {
      void 0;
    }

    return {
      current: status.current,
      tracking,
      unborn: headProbe.exitCode === 1,
      ahead,
      behind,
      aheadBase,
      upstreamComparison,
      files: status.files.map((f) => ({
        path: f.path,
        index: f.index,
        working_dir: f.working_dir,
        previousPath: f.from || undefined,
      })),
      isClean: status.isClean(),
      diffStats: lightMode ? undefined : diffStats,
      mergeInProgress,
      rebaseInProgress,
    };
  } catch (error) {
    if (isNotGitRepositoryError(error) || isMissingDirectoryError(error)) {
      await assertRepositoryReachable(normalizedDirectory);
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    }
    console.error('Failed to get Git status:', error);
    throw error;
  }
}

const getNoIndexDiff = async (repoRoot: string, repoPath: string, contextLines: number) => {
  const args = ['diff', '--no-color', '--full-index', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
  if (Number.isFinite(contextLines)) {
    args.push(`-U${Math.max(0, contextLines)}`);
  }
  args.push('--no-index', '--', '/dev/null', repoPath);
  const result = await runGitCommand(repoRoot, args);
  if (result.exitCode === 0 || result.exitCode === 1) {
    return result.stdout;
  }
  throw new Error(result.stderr || result.message || 'Failed to get untracked Git diff');
};

export async function getDiff(directory: string, { path: filePath, staged = false, contextLines = 3, previousPath }: DiffOptions = {}) {
  const context = await createRepositoryGitContext(directory);
  const fileContext = filePath
    ? await resolveGitFileContext(context.directoryPath, context.directoryGit, filePath, context.repoRoot)
    : null;
  return readDiff(context, fileContext, { staged, contextLines, previousPath });
}

export async function getPathDiff(directory: string, { path: filePath, staged = false, contextLines = 3, previousPath }: DiffOptions = {}) {
  const context = await createRepositoryGitContext(directory);
  const fileContext = await resolveGitFileContext(context.directoryPath, context.directoryGit, filePath, context.repoRoot);
  const diff = await readDiff(context, fileContext, { staged, contextLines, previousPath });
  if (!fileContext.isSubmodule) return { diff, submodule: null };
  return { diff, submodule: await readSubmoduleState(context.repoRoot, fileContext) };
}

const GIT_PATH_ERROR_CODES = new Set(['path_not_found', 'nested_repository', 'untracked_directory']);

export async function getPathDiffs(directory: string, { paths: filePaths = [], staged = false, contextLines = 3, concurrency = 8 }: { paths?: string[]; staged?: boolean; contextLines?: number; concurrency?: number } = {}) {
  const paths = Array.isArray(filePaths) ? filePaths : [];
  if (paths.length === 0) return [];

  const context = await createRepositoryGitContext(directory);
  const results = new Array<PathDiffResult>(paths.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      const filePath = paths[index];
      try {
        const fileContext = await resolveGitFileContext(context.directoryPath, context.directoryGit, filePath, context.repoRoot);
        const diff = await readDiff(context, fileContext, { staged, contextLines });
        const submodule = fileContext.isSubmodule ? await readSubmoduleState(context.repoRoot, fileContext) : null;
        results[index] = { path: filePath, diff, submodule };
      } catch (error) {
        const errorCode = errorField(error, 'code');
        const code = isPrimitiveString(errorCode) && GIT_PATH_ERROR_CODES.has(errorCode) ? errorCode : null;
        results[index] = { path: filePath, error: errorField(error, 'message') || 'Failed to get git diff', code };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results;
}

async function readDiff({ repoRoot, git }: RepositoryGitContext, fileContext: GitFileContext | null, { staged, contextLines, previousPath }: { staged: boolean; contextLines: number; previousPath?: string | undefined }) {
  try {
    const args = ['diff', '--no-color', '--full-index', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

    if (!Number.isNaN(contextLines)) {
      args.push(`-U${Math.max(0, contextLines)}`);
    }

    if (staged) {
      args.push('--cached');
    }

    if (fileContext) {
      args.push('--', ...[previousPath, fileContext.repoPath].filter(Boolean).map((value) => `:(literal)${value}`));
    }

    const diff = await git.raw(args);
    if (diff && diff.trim().length > 0) {
      return diff;
    }

    if (staged) {
      return diff;
    }

    if (!fileContext) {
      return diff;
    }

    try {
      await git.raw(['ls-files', '--error-unmatch', '--', fileContext.repoPath]);
      return diff;
    } catch {
      if (fileContext.isSymbolicLink) {
        const target = await fsp.readlink(fileContext.absolutePath);
        return [
          `diff --git a/${fileContext.repoPath} b/${fileContext.repoPath}`,
          'new file mode 120000',
          '--- /dev/null',
          `+++ b/${fileContext.repoPath}`,
          '@@ -0,0 +1 @@',
          `+${target}`,
          '\\ No newline at end of file',
          '',
        ].join('\n');
      }

      return await getNoIndexDiff(repoRoot, fileContext.repoPath, contextLines);
    }
  } catch (error) {
    console.error('Failed to get Git diff:', error);
    throw error;
  }
}

export async function listUntrackedPaths(directory: string) {
  const { repoRoot } = await createRepositoryGitContext(directory);
  const result = await runGitCommand(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
  ]);
  if (!result.success) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function getUntrackedDiffs(directory: string, filePaths: string[] = [], { concurrency = 8, contextLines = 3 } = {}) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter((value) => isPrimitiveString(value) && value);
  if (paths.length === 0) return [];

  const { directoryPath, directoryGit, repoRoot } = await createRepositoryGitContext(directory);
  const results = new Array<string>(paths.length).fill('');
  let cursor = 0;

  const worker = async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      try {
        const fileContext = await resolveGitFileContext(directoryPath, directoryGit, paths[index], repoRoot);
        results[index] = await getNoIndexDiff(repoRoot, fileContext.repoPath, contextLines);
      } catch {
        results[index] = '';
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return results;
}

const refResolvesToCommit = async (git: SimpleGit, ref: string) => git
  .raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  .then((value) => Boolean(String(value || '').trim()))
  .catch(() => false);
export const refreshRemoteRef = createRemoteRefRefresher({ createRepositoryGitContext, runGitCommand });

async function assertRangeRefsResolve(git: SimpleGit, repoRoot: string, refs: string[]) {
  for (const ref of refs) {
    if (await refResolvesToCommit(git, ref)) continue;
    const remoteRef = parseRemoteBranchRef(ref);
    const remotes = remoteRef ? await git.getRemotes().catch(() => []) : [];
    if (remoteRef && remoteRef.branch !== 'HEAD' && remotes.some((entry) => entry?.name === remoteRef.remote)) {
      await fetchRemoteBranchRef(repoRoot, remoteRef.remote, remoteRef.branch).catch(() => undefined);
      if (await refResolvesToCommit(git, ref)) continue;
    }
    throw new Error(`Ref "${ref}" is not available locally. Fetch it before comparing.`);
  }
}

async function runWorkingTreeRangeDiff(context: RepositoryGitContext, baseRef: string, headRef: string, args: string[], paths: string[] = []) {
  const { git, repoRoot } = context;
  const readHead = async () => {
    const commit = (await git.raw(['rev-parse', '--verify', 'HEAD'])).trim();
    const ref = (await git.raw(['symbolic-ref', '--quiet', 'HEAD'])).trim();
    return `${commit}\n${ref}`;
  };
  const startingHead = await readHead();
  const [headCommit = '', currentRef] = startingHead.split('\n');
  const requestedRef = (await git.raw(['rev-parse', '--verify', '--symbolic-full-name', '--end-of-options', headRef])).trim();
  if (requestedRef !== currentRef) {
    throw new Error('Working-tree comparisons require the checked-out branch. Refresh and try again.');
  }
  const mergeBase = (await git.raw(['merge-base', baseRef, headCommit])).trim();
  const readDiff = async (comparisonGit: SimpleGit) => {
    const output = await comparisonGit.raw([...args, mergeBase, '--', ...paths]);
    if (await readHead() !== startingHead) {
      throw new Error('The checked-out branch changed during comparison. Refresh and try again.');
    }
    return { output, mergeBase };
  };
  const untracked = await git.raw(['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]);
  if (!untracked) return readDiff(git);

  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-branch-diff-'));
  try {
    const indexPath = (await git.raw(['rev-parse', '--git-path', 'index'])).trim();
    const temporaryIndex = path.join(temporaryDirectory, 'index');
    await fsp.copyFile(path.resolve(repoRoot, indexPath), temporaryIndex);
    const pathspecFile = path.join(temporaryDirectory, 'paths');
    await fsp.writeFile(pathspecFile, untracked);
    const comparisonGit = await createGit(repoRoot, {
      extraEnv: { GIT_INDEX_FILE: temporaryIndex, GIT_LITERAL_PATHSPECS: '1' },
    });
    await comparisonGit.raw(['add', '--intent-to-add', '--pathspec-from-file=' + pathspecFile, '--pathspec-file-nul']);
    return await readDiff(comparisonGit);
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function getRangeDiff(directory: string, { base, head, path: filePath, previousPath, contextLines = 3, includeWorkingTree = false }: RangeOptions = {}) {
  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
  const baseRef = isPrimitiveString(base) ? base.trim() : '';
  const headRef = isPrimitiveString(head) ? head.trim() : '';
  if (!baseRef || !headRef) {
    throw new Error('base and head are required');
  }

  await assertRangeRefsResolve(git, repoRoot, [baseRef, headRef]);

  const args = ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];
  if (!Number.isNaN(contextLines)) {
    args.push(`-U${Math.max(0, contextLines)}`);
  }
  const paths = [];
  if (filePath) {
    try {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
      paths.push(...[previousPath, fileContext.repoPath].filter((value): value is string => Boolean(value)));
    } catch (error) {
      if (errorField(error, 'code') !== GIT_PATH_NOT_FOUND) throw error;
      const mergeBase = (await git.raw(['merge-base', baseRef, headRef])).trim();
      for (const root of new Set([repoRoot, directoryPath])) {
        const target = path.resolve(root, filePath);
        if (!isInsideOrSameDirectory(repoRoot, target)) continue;
        const repoPath = toGitPath(path.relative(repoRoot, target));
        const exists = await git.raw(['cat-file', '-e', `${mergeBase}:${repoPath}`]).then(() => true).catch(() => false);
        if (exists) {
          paths.push(repoPath);
          break;
        }
      }
      if (paths.length === 0) throw error;
    }
  }
  if (includeWorkingTree) {
    return (await runWorkingTreeRangeDiff({ git, repoRoot }, baseRef, headRef, args, paths)).output;
  }
  args.push(`${baseRef}...${headRef}`, '--', ...paths);
  const diff = await git.raw(args);
  return diff;
}

export async function getRangeFileVersions(directory: string, { base, head, path: filePath, previousPath, includeWorkingTree = false }: RangeOptions = {}) {
  const { directoryPath, repoRoot, git } = await createRepositoryGitContext(directory);
  const baseRef = String(base ?? '').trim();
  const headRef = String(head ?? '').trim();
  if (!baseRef || !headRef || !filePath) throw new Error('base, head and path are required');
  await assertRangeRefsResolve(git, repoRoot, [baseRef, headRef]);
  const headCommit = (await git.raw(['rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`])).trim();
  const mergeBase = (await git.raw(['merge-base', baseRef, headCommit])).trim();
  const absolutePath = path.resolve(directoryPath, filePath);
  const candidates = new Set([path.resolve(repoRoot, filePath), absolutePath]);
  const repoPaths = Array.from(candidates)
    .filter((candidate) => isInsideOrSameDirectory(repoRoot, candidate))
    .map((candidate) => toGitPath(path.relative(repoRoot, candidate)));
  const readRevision = async (revision: string, repoPath: string) => {
    try {
      const { stdout } = await execFileAsync(getGitBinary(), ['show', `${revision}:${repoPath}`], {
        cwd: repoRoot,
        encoding: 'buffer',
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
      });
      return stdout.length > 0 ? `data:application/octet-stream;base64,${stdout.toString('base64')}` : '';
    } catch {
      return '';
    }
  };
  for (const repoPath of repoPaths) {
    const basePath = previousPath ? toGitPath(path.relative(repoRoot, path.resolve(path.dirname(path.join(repoRoot, repoPath)), path.relative(path.dirname(filePath), previousPath)))) : repoPath;
    const original = await readRevision(mergeBase, basePath);
    let modified = '';
    if (includeWorkingTree) {
      modified = await fsp.readFile(path.join(repoRoot, repoPath))
        .then((bytes) => `data:application/octet-stream;base64,${bytes.toString('base64')}`)
        .catch(() => '');
    } else {
      modified = await readRevision(headCommit, repoPath);
    }
    if (modified || (original && !previousPath)) return { original, modified };
  }
  return { original: '', modified: '' };
}

export function parseBranchCreationSource(reflogText: string) {
  const { source, rebased } = readBranchCreation(reflogText);
  return rebased ? null : source;
}

function readBranchCreation(reflogText: string) {
  const lines = String(reflogText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const rebased = lines.some((line) => /^rebase(?:\s|\()/.test(line));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]?.match(BRANCH_CREATION_SOURCE_RE);
    if (!match) continue;
    const source = (match[1] ?? '').trim();
    if (!source || /^HEAD(@|$)/.test(source) || /^[0-9a-f]{7,40}$/i.test(source)) {
      return { source: null, rebased };
    }
    return { source, rebased };
  }
  return { source: null, rebased };
}

const branchParentKey = (branch: string) => `branch.${branch}.gh-merge-base`;

async function localBranchNameOf(directory: string, ref: string) {
  const result = await runGitCommand(directory, ['rev-parse', '--symbolic-full-name', ref]);
  const fullName = String(result.stdout || '').trim();
  return result.success && fullName.startsWith('refs/heads/') ? fullName.slice('refs/heads/'.length) : null;
}

async function recordBranchParent(directory: string, branch: string, parent: string | null) {
  if (!parent || parent === branch) return;
  await runGitCommand(directory, ['config', branchParentKey(branch), parent]);
}

async function findNearerStackLayer(git: SimpleGit, repoRoot: string, branchName: string, lowerRef: string) {
  const lowerCommit = await git
    .raw(['rev-parse', '--verify', '--quiet', `${lowerRef}^{commit}`])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  if (!lowerCommit) return null;
  const listed = await git
    .raw(['for-each-ref', '--format=%(refname)%00%(objectname)', '--merged', `refs/heads/${branchName}`, '--contains', lowerCommit, 'refs/heads/'])
    .catch(() => '');
  const candidates = String(listed || '').split('\n').filter(Boolean)
    .map((line) => {
      const [ref = '', commit] = line.split('\0');
      return { name: ref.slice('refs/heads/'.length), commit };
    })
    .filter(({ name, commit }) => name !== branchName && commit !== lowerCommit);
  if (candidates.length === 0) return null;

  const line = String(await git
    .raw(['rev-list', '--first-parent', `${lowerCommit}..refs/heads/${branchName}`])
    .catch(() => '')).split('\n').map((value) => value.trim()).filter(Boolean);
  let lowerTips: Set<string> | null = null;
  const isOnLowerParent = async (commit: string) => {
    lowerTips ??= new Set(String(await git.raw(['reflog', 'show', '--format=%H', lowerRef]).catch(() => ''))
      .split('\n').map((value) => value.trim()).filter(Boolean));
    return lowerTips.has(commit) || (await runGitCommand(repoRoot, ['merge-base', '--is-ancestor', commit, lowerCommit])).success;
  };
  const isLowerLayer = async (name: string) => {
    const recorded = await git.raw(['config', '--get', branchParentKey(name)]).then((value) => String(value || '').trim()).catch(() => '');
    if (recorded) return recorded !== branchName;
    const entries = String(await git.raw(['reflog', 'show', '--format=%H%x00%gs', name]).catch(() => ''))
      .split('\n').filter(Boolean).map((entry) => entry.split('\0'));
    const { source } = readBranchCreation(entries.map(([, subject]) => subject).join('\n'));
    const fullName = source
      ? await git.raw(['rev-parse', '--symbolic-full-name', source]).then((value) => String(value || '').trim()).catch(() => '')
      : '';
    if (fullName.startsWith('refs/heads/')) return fullName !== `refs/heads/${branchName}`;
    if (fullName.startsWith('refs/remotes/')) return !(await isOwnRemoteCopy(git, fullName, branchName));
    const created = entries.at(-1);
    if (!created || !BRANCH_CREATION_SOURCE_RE.test(created[1] ?? '')) return false;
    return isOnLowerParent(created[0] ?? '');
  };
  for (const commit of line) {
    const named = candidates.filter((candidate) => candidate.commit === commit);
    if (named.length === 0) continue;
    const layers = [];
    for (const { name } of named) {
      if (await isLowerLayer(name)) layers.push(name);
    }
    if (layers.length > 0) return layers.length === 1 ? layers[0] : null;
  }
  return null;
}

export async function getBranchBase(directory: string, branch: string) {
  const branchName = String(branch || '').trim();
  if (!branchName) {
    throw new Error('branch is required');
  }

  const { git, repoRoot } = await createRepositoryGitContext(directory);
  return readBranchBase(git, repoRoot, branchName);
}

async function readBranchBase(git: SimpleGit, repoRoot: string, branchName: string) {
  const recordedParent = await git
    .raw(['config', '--get', branchParentKey(branchName)])
    .then((value) => String(value || '').trim())
    .catch(() => '');
  if (recordedParent && recordedParent !== branchName) {
    const remotes = await git.raw(['remote']).then((value) => String(value || '').split('\n').map((name) => name.trim()).filter(Boolean)).catch(() => []);
    const recordedRefs = [];
    for (const ref of [`refs/heads/${recordedParent}`, ...remotes.map((remote) => `refs/remotes/${remote}/${recordedParent}`)]) {
      const resolves = await git
        .raw(['rev-parse', '--verify', '--quiet', ref])
        .then((value) => Boolean(String(value || '').trim()))
        .catch(() => false);
      if (resolves) recordedRefs.push(ref);
    }
    const [recordedRef] = recordedRefs;
    if (recordedRef) {
      const restacked = await findRestackedParent(git, branchName, recordedRefs);
      if (restacked) return { base: restacked };
      return { base: (await findNearerStackLayer(git, repoRoot, branchName, recordedRef)) ?? recordedParent };
    }
  }

  let reflog = '';
  try {
    reflog = await git.raw(['reflog', 'show', '--format=%gs', branchName]);
  } catch {
    return { base: null };
  }

  const { source: createdFrom, rebased } = readBranchCreation(reflog);
  const resolves = createdFrom && createdFrom !== branchName && /^refs\/(heads|remotes)\//.test(await git
    .raw(['rev-parse', '--symbolic-full-name', createdFrom])
    .then((value) => String(value || '').trim())
    .catch(() => ''));
  const source = resolves && !(await isOwnRemoteCopy(git, createdFrom, branchName)) ? createdFrom : null;

  const restacked = rebased ? await findRestackedParent(git, branchName, source ? [source] : []) : undefined;
  if (restacked) return { base: restacked };
  if (!source) return { base: null };
  const nearer = await findNearerStackLayer(git, repoRoot, branchName, source);
  if (nearer) return { base: nearer };
  return { base: restacked === null ? null : source };
}

export async function getRangeFiles(directory: string, { base, head, includeWorkingTree = false }: RangeOptions = {}) {
  const { git, repoRoot } = await createRepositoryGitContext(directory);
  const baseRef = isPrimitiveString(base) ? base.trim() : '';
  const headRef = isPrimitiveString(head) ? head.trim() : '';
  if (!baseRef || !headRef) {
    throw new Error('base and head are required');
  }

  await assertRangeRefsResolve(git, repoRoot, [baseRef, headRef]);

  const args = ['diff', '--name-status', '-z', '-C'];
  const workingTree = includeWorkingTree
    ? await runWorkingTreeRangeDiff({ git, repoRoot }, baseRef, headRef, args)
    : null;
  const raw = workingTree ? workingTree.output : await git.raw([...args, `${baseRef}...${headRef}`, '--']);
  const tokens = String(raw || '').split('\0');
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = (tokens[index] || '').trim();
    if (!status) continue;
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const previousPath = isRenameOrCopy ? tokens[index + 1] || undefined : undefined;
    const path = isRenameOrCopy ? (tokens[index + 2] || '') : (tokens[index + 1] || '');
    index += isRenameOrCopy ? 2 : 1;
    if (path) {
      files.push({ path, status: status.charAt(0), previousPath });
    }
  }
  if (!workingTree) return files;
  return Promise.all(files.map(async (file) => ({
    ...file,
    revision: `${workingTree.mergeBase}:${await readWorkingFileSignature(path.join(repoRoot, file.path))}`,
  })));
}

async function readWorkingFileSignature(absolutePath: string) {
  try {
    const stat = await fsp.lstat(absolutePath, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.ino}`;
  } catch {
    return 'missing';
  }
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];

const OFFICE_DOCUMENT_EXTENSIONS = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'];

const BINARY_SNIFF_BYTES = 8192;

function isImageFile(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

function isOfficeDocument(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return OFFICE_DOCUMENT_EXTENSIONS.includes(ext || '');
}

function getImageMimeType(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeMap = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
  };
  const isMimeExtension = (value: unknown): value is keyof typeof mimeMap => isPrimitiveString(value) && Object.hasOwn(mimeMap, value);
  return isMimeExtension(ext) ? mimeMap[ext] : 'application/octet-stream';
}

const parseIsBinaryFromNumstat = (raw: string | undefined) => {
  const text = String(raw || '').trim();
  if (!text) {
    return false;
  }

  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const [added, deleted] = firstLine.split('\t');
  return added === '-' || deleted === '-';
};

const looksBinaryBySniff = async (absolutePath: string) => {
  try {
    const handle = await fsp.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
      if (bytesRead <= 0) {
        return false;
      }
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

const isBinaryDiff = async (directoryPath: string, filePath: string, staged: boolean) => {
  const args = ['diff', '--numstat'];
  if (staged) {
    args.push('--cached');
  }
  args.push('--', filePath);

  const result = await runGitCommand(directoryPath, args);
  if (parseIsBinaryFromNumstat(result.stdout)) {
    return true;
  }

  if (!staged) {
    const tracked = await runGitCommand(directoryPath, ['ls-files', '--error-unmatch', '--', filePath]).then((r) => r.success);
    if (!tracked) {
      const noIndex = await runGitCommand(directoryPath, ['diff', '--no-index', '--numstat', '--', '/dev/null', filePath]);
      if (parseIsBinaryFromNumstat(noIndex.stdout) || parseIsBinaryFromNumstat(noIndex.stderr) || parseIsBinaryFromNumstat(noIndex.message)) {
        return true;
      }
      const text = `${noIndex.stdout || ''}\n${noIndex.stderr || ''}\n${noIndex.message || ''}`.toLowerCase();
      if (text.includes('binary files') || text.includes('git binary patch')) {
        return true;
      }
    }
  }

  return false;
};

export async function getFileDiff(directory: string, { path: filePath, staged = false, previousPath }: DiffOptions = {}) {
  if (!directory || !filePath) {
    throw new Error('directory and path are required for getFileDiff');
  }

  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
  const isImage = isImageFile(filePath) || isOfficeDocument(filePath);
  const mimeType = isImage ? getImageMimeType(filePath) : null;
  const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
  const { absolutePath, repoPath, isSymbolicLink } = fileContext;
  const originalRepoPath = previousPath || repoPath;

  if (fileContext.isSubmodule) {
    const submodule = await readSubmoduleState(repoRoot, fileContext);
    const describeCommit = (commit: string | null) => (commit ? `Subproject commit ${commit}\n` : '');
    return {
      original: describeCommit(submodule.headCommit),
      modified: describeCommit(staged ? submodule.indexCommit : submodule.worktreeCommit),
      path: filePath,
      isBinary: false,
      submodule,
    };
  }

  if (!isImage && !isSymbolicLink) {
    const isBinaryBySniff = await looksBinaryBySniff(absolutePath);
    const isBinary = isBinaryBySniff || (await isBinaryDiff(repoRoot, repoPath, staged));
    if (isBinary) {
      return {
        original: '',
        modified: '',
        path: filePath,
        isBinary: true,
      };
    }
  }

  const originalRevisions = staged
    ? [`HEAD:${originalRepoPath}`]
    : [...new Set([`:${repoPath}`, `:${originalRepoPath}`, `HEAD:${originalRepoPath}`])];
  let original = '';
  for (const revision of originalRevisions) {
    try {
      if (isImage) {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', revision], {
          cwd: repoRoot,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024,
        });
        if (stdout && stdout.length > 0) {
          original = `data:${mimeType};base64,${stdout.toString('base64')}`;
          break;
        }
      } else {
        original = await git.show([revision]);
        break;
      }
    } catch {
      void 0;
    }
  }

  let modified = '';
  try {
    if (staged) {
      if (isImage) {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', `:${repoPath}`], {
          cwd: repoRoot,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024,
        });
        if (stdout && stdout.length > 0) {
          modified = `data:${mimeType};base64,${stdout.toString('base64')}`;
        }
      } else {
        modified = await git.show([`:${repoPath}`]);
      }
    } else {
      if (isSymbolicLink) {
        modified = await fsp.readlink(absolutePath);
      } else {
        const stat = await fsp.stat(absolutePath);
        if (!stat.isFile()) {
          return {
            original: original.replace(/\r\n/g, '\n'),
            modified: '',
            path: filePath,
            isBinary: false,
          };
        }
        if (isImage) {
          const buffer = await fsp.readFile(absolutePath);
          modified = `data:${mimeType};base64,${buffer.toString('base64')}`;
        } else {
          modified = await fsp.readFile(absolutePath, 'utf8');
        }
      }
    }
  } catch (error) {
    if (error && isObjectValue(error) && errorField(error, 'code') === 'ENOENT') {
      modified = '';
    } else {
      console.error('Failed to read modified file contents for diff:', error);
      throw error;
    }
  }

  return {
    original: original.replace(/\r\n/g, '\n'),
    modified: modified.replace(/\r\n/g, '\n'),
    path: filePath,
    isBinary: false,
  };
}

export async function revertFile(directory: string, filePath: string, options: { scope?: unknown } = {}) {
  return withGitIndexMutationQueue(directory, async () => {
    const scope = options?.scope === 'working' ? 'working' : 'all';
    const directoryPath = normalizeDirectoryPath(directory);
    const directoryGit = await createGit(directoryPath);
    const repoRoot = await resolveGitRepositoryRoot(directoryPath, directoryGit);
    const { absolutePath, repoPath } = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
    const git = await createGit(repoRoot);

    const isTracked = await git
      .raw(['ls-files', '--error-unmatch', '--', repoPath])
      .then(() => true)
      .catch(() => false);

    if (!isTracked) {
      try {
        await git.raw(['clean', '-f', '-d', '--', repoPath]);
        return;
      } catch {
        try {
          await fsp.rm(absolutePath, { recursive: true, force: true });
          return;
        } catch (fsError) {
          if (fsError && isObjectValue(fsError) && errorField(fsError, 'code') === 'ENOENT') {
            return;
          }
          console.error('Failed to remove untracked file during revert:', fsError);
          throw fsError;
        }
      }
    }

    if (scope === 'all') {
      try {
        await git.raw(['restore', '--staged', '--', repoPath]);
      } catch {
        await git.raw(['reset', 'HEAD', '--', repoPath]).catch(() => {});
      }
    }

    try {
      await git.raw(['restore', '--', repoPath]);
    } catch {
      try {
        await git.raw(['checkout', '--', repoPath]);
      } catch (fallbackError) {
        console.error('Failed to revert git file:', fallbackError);
        throw fallbackError;
      }
    }
  });
}

const HUNK_ACTION_FLAGS = {
  stage: ['--cached'],
  unstage: ['--cached', '--reverse'],
  discard: ['--reverse'],
} satisfies Record<HunkAction, string[]>;

const parsePatchPathToken = (line: string): string | null => {
  const value = String(line || '').replace(/^(?:-{3}|\+{3})\s+/, '');
  if (!value || value === '/dev/null') {
    return null;
  }

  if (value.startsWith('"')) {
    let token = '"';
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const char = value[index];
      token += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }

    try {
      const parsed: unknown = JSON.parse(token);
      if (isPrimitiveString(parsed)) return parsed;
      throw new TypeError('Invalid quoted patch path');
    } catch {
      return token.slice(1, token.endsWith('"') ? -1 : undefined);
    }
  }

  return value.split('\t', 1)[0] || null;
};

const normalizePatchTargetPath = (value: string | null) => {
  if (!value || value === '/dev/null') {
    return null;
  }
  return value.replace(/^[ab]\//, '');
};

const extractPatchTargetPath = (patch: string) => {
  const firstHunk = patch.search(/^@@\s/m);
  const header = firstHunk < 0 ? patch : patch.slice(0, firstHunk);
  const matches = [...header.matchAll(/^(?:-{3}|\+{3})\s+.+$/gm)];
  const realTargets = matches
    .map((match) => normalizePatchTargetPath(parsePatchPathToken(match[0])))
    .filter(Boolean);
  return realTargets.at(-1) || null;
};

const writeTempPatchFile = async (patch: string) => {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `openchamber-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  await fsp.writeFile(tmpPath, patch, 'utf8');
  return tmpPath;
};

export async function applyHunk(directory: string, filePath: string, options: { action?: HunkAction; patch?: string } = {}) {
  const action = options?.action;
  if (!action || !HUNK_ACTION_FLAGS[action]) {
    throw new Error('Invalid hunk action');
  }
  const patch = isPrimitiveString(options?.patch) ? options.patch : '';
  if (!patch.trim()) {
    throw new Error('patch is required to apply a hunk');
  }
  if (!/^@@\s/m.test(patch)) {
    throw new Error('patch does not contain a hunk header');
  }

  return withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
    validateRepositoryFilePaths(repoRoot, [fileContext.repoPath]);

    const current = await getDiff(directory, { path: filePath, staged: action === 'unstage', contextLines: 3 });
    const starts = [...current.matchAll(/^@@\s/gm)].map((match) => match.index);
    const header = current.slice(0, starts[0] ?? 0);
    const isCurrentHunk = starts.some((start, index) => (
      header + current.slice(start, starts[index + 1] ?? current.length) === patch
    ));
    if (!isCurrentHunk) {
      const targetPath = extractPatchTargetPath(patch);
      if (targetPath && targetPath !== fileContext.repoPath && targetPath !== filePath) {
        throw new Error('patch target path does not match the requested file');
      }
      throw new Error('Hunk no longer applies — refresh and try again.');
    }

    const flags = HUNK_ACTION_FLAGS[action];
    let tmpPath = null;
    try {
      tmpPath = await writeTempPatchFile(patch);

      try {
        await git.raw(['apply', ...flags, '--check', tmpPath]);
      } catch (checkError) {
        const text = parseGitErrorText(checkError);
        throw new Error(
          text
            ? `Hunk no longer applies — refresh and try again.\n${text}`
            : 'Hunk no longer applies — refresh and try again.'
        );
      }

      await git.raw(['apply', ...flags, tmpPath]);
    } finally {
      if (tmpPath) {
        await fsp.rm(tmpPath, { force: true }).catch(() => {});
      }
    }
  });
}

async function _collectDiffs(directory: string, files: string[] = []) {
  const results = [];
  for (const filePath of files) {
    try {
      const diff = await getDiff(directory, { path: filePath });
      if (diff && diff.trim().length > 0) {
        results.push({ path: filePath, diff });
      }
    } catch (error) {
      console.error(`Failed to diff ${filePath}:`, error);
    }
  }
  return results;
}

export async function listStashes(directory: string) {
  const { git } = await createRepositoryGitContext(directory);
  const output = await git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cr%x1f%H']);
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref = '', message = '', relativeTime = '', hash = ''] = line.split('\x1f');
      return { ref, message, relativeTime, hash };
    })
    .filter((entry) => entry.ref);
}

export async function countStashFiles<Refs>(directory: string, refs?: Refs) {
  const { git } = await createRepositoryGitContext(directory);
  const uniqueRefs = Array.from(new Set((Array.isArray(refs) ? refs : []).map((ref) => String(ref || '').trim()).filter(Boolean)));
  const counts: Record<string, number> = {};
  const concurrency = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < uniqueRefs.length) {
      const ref = uniqueRefs[cursor++];
      if (!ref) continue;
      try {
        const names = await git.raw(['stash', 'show', '--include-untracked', '--name-only', ref]);
        counts[ref] = String(names || '').split('\n').map((line) => line.trim()).filter(Boolean).length;
      } catch {
        counts[ref] = 0;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()));
  return counts;
}
export async function stashPush(directory: string, options: { message?: unknown; paths?: unknown } = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const message = isPrimitiveString(options.message) && options.message.trim()
    ? options.message.trim()
    : `OpenChamber stash ${new Date().toISOString()}`;
  const paths = Array.isArray(options.paths) ? options.paths : [];
  const output = await git.raw(paths.length > 0
    ? ['--literal-pathspecs', 'stash', 'push', '--include-untracked', '-m', message, '--', ...paths]
    : ['stash', 'push', '--include-untracked', '-m', message]);
  return {
    success: true,
    created: !/no local changes/i.test(String(output || '')),
    message,
    output: String(output || '').trim(),
  };
}

export async function stashApply(directory: string, options: { ref?: unknown } = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const ref = isPrimitiveString(options.ref) && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await git.raw(['stash', 'apply', '--index', ref]).catch(async () => {
    await git.raw(['stash', 'apply', ref]);
  });
  return { success: true, ref };
}

export async function stashDrop(directory: string, options: { ref?: unknown } = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const ref = isPrimitiveString(options.ref) && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await git.raw(['stash', 'drop', ref]);
  return { success: true, ref };
}

export async function stashPop(directory: string, options: { ref?: unknown } = {}) {
  const ref = isPrimitiveString(options.ref) && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await stashApply(directory, { ref });
  await stashDrop(directory, { ref });
  return { success: true, ref };
}

async function _stageFile(directory: string, filePath: string) {
  await stageFiles(directory, [filePath]);
}

export async function stageFiles<Paths>(directory: string, paths: Paths) {
  if (!directory) {
    throw new Error('directory and path are required for stageFile');
  }

  const filePaths = normalizeFilePathList(paths);
  if (filePaths.length === 0) {
    throw new Error('directory and path are required for stageFile');
  }
  validateRepositoryFilePaths(normalizeDirectoryPath(directory), filePaths);

  await withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const repoPaths = Array.from(new Set(await Promise.all(filePaths.map(async (filePath) => {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot, { acceptUntrackedDirectory: true });
      return fileContext.repoPath;
    }))));
    validateRepositoryFilePaths(repoRoot, repoPaths);
    await git.raw(['add', '--', ...repoPaths]).catch(async (error) => {
      const gitErrorText = parseGitErrorText(error);
      const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
      if (!isPathspecError) {
        throw error;
      }

      for (const repoPath of repoPaths) {
        await git.raw(['add', '--', repoPath]).catch((perPathError) => {
          const perPathText = parseGitErrorText(perPathError);
          const perPathIsPathspecError =
            perPathText.includes('pathspec') && perPathText.includes('did not match any files');
          if (!perPathIsPathspecError) {
            throw perPathError;
          }
        });
      }
    });
  });
}

async function _unstageFile(directory: string, filePath: string) {
  await unstageFiles(directory, [filePath]);
}

export async function unstageFiles<Paths>(directory: string, paths: Paths) {
  if (!directory) {
    throw new Error('directory and path are required for unstageFile');
  }

  const filePaths = normalizeFilePathList(paths);
  if (filePaths.length === 0) {
    throw new Error('directory and path are required for unstageFile');
  }
  validateRepositoryFilePaths(normalizeDirectoryPath(directory), filePaths);

  await withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const repoPaths = Array.from(new Set(await Promise.all(filePaths.map(async (filePath) => {
      const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
      return fileContext.repoPath;
    }))));
    validateRepositoryFilePaths(repoRoot, repoPaths);
    await git.raw(['restore', '--staged', '--', ...repoPaths]).catch(async () => {
      await git.raw(['reset', 'HEAD', '--', ...repoPaths]);
    });
  });
}

export async function commit(directory: string, message: string, options: { files?: unknown; stageFiles?: unknown; addAll?: unknown } = {}) {
  return withGitIndexMutationQueue(directory, async () => {
    const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);
    const [localUserName, localUserEmail] = await Promise.all([
      git.getConfig('user.name', 'local').catch(() => null),
      git.getConfig('user.email', 'local').catch(() => null),
    ]);
    if (!localUserName?.value?.trim() || !localUserEmail?.value?.trim()) {
      const [globalUserName, globalUserEmail] = await Promise.all([
        git.getConfig('user.name', 'global').catch(() => null),
        git.getConfig('user.email', 'global').catch(() => null),
      ]);
      if (!globalUserName?.value?.trim() || !globalUserEmail?.value?.trim()) {
        throw new Error('No Git author is configured. Choose an identity for this repository, or set user.name and user.email on this computer.');
      }
    }
    let temporarilyUnstagedFiles: string[] = [];

    try {
      const requestedFiles = Array.isArray(options.files)
        ? options.files
          .map((value) => String(value || '').trim())
          .filter(Boolean)
        : [];
      const requestedStageFiles = Array.isArray(options.stageFiles)
        ? options.stageFiles
          .map((value) => String(value || '').trim())
          .filter(Boolean)
        : null;
      let filesToCommit: string[] = [];
      let commitFromIndexOnly = false;

      if (options.addAll) {
        await git.add('.');
      } else if (requestedFiles.length > 0) {
        filesToCommit = Array.from(new Set(await Promise.all(requestedFiles.map(async (filePath) => {
          const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot, { acceptUntrackedDirectory: true });
          return fileContext.repoPath;
        }))));

        const stageFilesToCommit = requestedStageFiles
          ? Array.from(new Set(await Promise.all(requestedStageFiles.map(async (filePath) => {
            const fileContext = await resolveGitFileContext(directoryPath, directoryGit, filePath, repoRoot);
            return fileContext.repoPath;
          }))))
          : null;

        const status = await git.status();
        const fileStatusByPath = new Map(status.files.map((file) => [file.path, file]));
        filesToCommit = expandDirectoryEntries(filesToCommit, status.files.map((file) => file.path));

        if (filesToCommit.length === 0) {
          throw new Error('No selected files are available to commit. Refresh git status and try again.');
        }

        if (requestedStageFiles) {
          commitFromIndexOnly = true;
          const selectedFileSet = new Set(filesToCommit);
          temporarilyUnstagedFiles = status.files
            .filter((file) => {
              const indexStatus = (file.index || '').trim();
              return indexStatus && indexStatus !== '?' && !selectedFileSet.has(file.path);
            })
            .map((file) => file.path);

          if (temporarilyUnstagedFiles.length > 0) {
            await git.raw(['restore', '--staged', '--', ...temporarilyUnstagedFiles]);
          }
        }

        const filesNeedingAdd = requestedStageFiles
          ? (stageFilesToCommit || []).filter((filePath) => fileStatusByPath.has(filePath))
          : filesToCommit.filter((filePath) => {
            const fileStatus = fileStatusByPath.get(filePath);
            if (!fileStatus) {
              return false;
            }

            const alreadyFullyStaged = fileStatus.index !== ' ' && fileStatus.working_dir === ' ';
            return !alreadyFullyStaged;
          });

        if (filesNeedingAdd.length > 0) {
          await git.raw(['add', '--', ...filesNeedingAdd]);
        }
      }

      const commitArgs =
        !commitFromIndexOnly && !options.addAll && filesToCommit.length > 0
          ? filesToCommit
          : undefined;

      let result;
      try {
        result = await git.commit(message, commitArgs);
      } catch (error) {
        const gitErrorText = parseGitErrorText(error);
        const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
        if (!isPathspecError || !commitArgs || commitArgs.length === 0) {
          throw error;
        }

        result = await git.commit(message);
      }

      if (temporarilyUnstagedFiles.length > 0) {
        await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
          console.error('Failed to restore temporarily unstaged files:', restoreError);
        });
      }

      return {
        success: true,
        commit: result.commit,
        branch: result.branch,
        summary: result.summary
      };
    } catch (error) {
      if (temporarilyUnstagedFiles.length > 0) {
        await git.raw(['add', '--', ...temporarilyUnstagedFiles]).catch((restoreError) => {
          console.error('Failed to restore temporarily unstaged files after commit failure:', restoreError);
        });
      }
      console.error('Failed to commit:', error);
      throw error;
    }
  });
}

const withoutDetachedHeadEntry = (summary: BranchSummary) => {
  if (!summary.detached) {
    return { all: summary.all, branches: summary.branches };
  }
  const index = summary.all.indexOf(summary.current);
  const all = summary.all.filter((_, entryIndex) => entryIndex !== index);
  const branches = { ...summary.branches };
  if (!all.includes(summary.current)) {
    delete branches[summary.current];
  }
  return { all, branches };
};

export async function getBranches(directory: string, { remote = 'local' } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const result = await git.branch();
    const { all: allBranches, branches } = withoutDetachedHeadEntry(result);
    const remoteBranches = allBranches.filter(branch => branch.startsWith('remotes/'));
    const activeRemoteBranches = remote === 'local'
      ? remoteBranches
      : await filterActiveRemoteBranches(git, directory, remoteBranches);
    const defaultBranches = await getRemoteDefaultBranches(git);

    return {
      all: [
        ...allBranches.filter(branch => !branch.startsWith('remotes/')),
        ...activeRemoteBranches,
      ],
      current: result.current,
      branches,
      defaultBranches,
    };
  } catch (error) {
    console.error('Failed to get branches:', error);
    throw error;
  }
}

export async function getUnpushedBranchCounts(directory: string, branchNames: string[]) {
  const { git } = await createRepositoryGitContext(directory);
  const requested = [...new Set(Array.isArray(branchNames) ? branchNames : [])]
    .filter((name) => isPrimitiveString(name) && name.length > 0)
    .slice(0, 5);
  if (requested.length === 0) return { counts: {} };

  const local = new Set((await git.branchLocal()).all);
  const counts: Record<string, number> = {};
  await Promise.all(requested.map(async (branch) => {
    if (!local.has(branch)) return;
    const upstream = await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])
      .then((value) => value.trim())
      .catch(() => '');
    if (!upstream) return;
    const count = await git.raw(['rev-list', '--count', `${upstream}..${branch}`])
      .then((value) => Number.parseInt(value.trim(), 10))
      .catch(() => 0);
    if (Number.isFinite(count) && count > 0) counts[branch] = count;
  }));
  return { counts };
}

async function getRemoteDefaultBranches(git: SimpleGit) {
  let defaults: Record<string, string> = {};

  try {
    const refs = await git.raw([
      'for-each-ref',
      '--format=%(refname) %(symref)',
      'refs/remotes',
    ]);
    defaults = Object.fromEntries(
      refs.trim().split('\n').flatMap((line): [string, string][] => {
        const [ref = '', symbolicRef] = line.split(' ');
        const match = ref.match(/^refs\/remotes\/([^/]+)\/HEAD$/);
        const prefix = match ? `refs/remotes/${match[1]}/` : '';
        return match && symbolicRef !== undefined && symbolicRef.startsWith(prefix)
          ? [[match[1] ?? '', symbolicRef.slice(prefix.length)]]
          : [];
      })
    );
  } catch {
    defaults = {};
  }

  return defaults;
}

const REMOTE_HEADS_TTL_MS = 30_000;
const remoteHeadsCache = new Map<string, { at: number; localKey: string; heads: Promise<Set<string>> }>();

const readRemoteHeads = (git: SimpleGit, directory: string, remote: RemoteWithRefs, localRefs: string[]) => {
  const key = `${directory}\0${remote.name}\0${remote.refs?.fetch ?? ''}`;
  const localKey = localRefs.join('\n');
  const cached = remoteHeadsCache.get(key);
  if (cached && cached.localKey === localKey && Date.now() - cached.at < REMOTE_HEADS_TTL_MS) return cached.heads;
  const heads = git.raw(['ls-remote', '--heads', '--', remote.name]).then((output) => {
    const names = new Set<string>();
    for (const line of output.trim().split('\n')) {
      if (line.includes('\trefs/heads/')) names.add((line.split('\t')[1] ?? '').replace('refs/heads/', ''));
    }
    return names;
  });
  const entry = { at: Date.now(), localKey, heads };
  remoteHeadsCache.set(key, entry);
  heads.catch(() => { if (remoteHeadsCache.get(key) === entry) remoteHeadsCache.delete(key); });
  return heads;
};

async function filterActiveRemoteBranches(git: SimpleGit, directory: string, remoteBranches: string[]) {
  try {
    const remotes = await git.getRemotes(true);
    const branchesByRemote = new Map<string, Set<string>>();

    const unreachableRemotes = new Set<string>();

    await Promise.all(remotes.map(async (remote) => {
      try {
        const localRefs = remoteBranches.filter((branch) => branch.startsWith(`remotes/${remote.name}/`));
        branchesByRemote.set(remote.name, await readRemoteHeads(git, directory, remote, localRefs));
      } catch {
        unreachableRemotes.add(remote.name);
      }
    }));

    const activeBranches = remoteBranches.filter(remoteBranch => {
      const match = remoteBranch.match(/^remotes\/[^/]+\/(.+)$/);
      if (!match) return false;
      const remoteName = remoteBranch.split('/')[1] ?? '';
      const branchName = match[1] ?? '';
      if (unreachableRemotes.has(remoteName)) return true;
      return branchesByRemote.get(remoteName)?.has(branchName) ?? false;
    });

    const seenBranches = new Set(activeBranches);
    for (const [remoteName, actualRemoteBranches] of branchesByRemote) {
      for (const branchName of actualRemoteBranches) {
        const qualifiedBranch = `remotes/${remoteName}/${branchName}`;
        if (!seenBranches.has(qualifiedBranch)) {
          seenBranches.add(qualifiedBranch);
          activeBranches.push(qualifiedBranch);
        }
      }
    }

    return activeBranches;
  } catch (error) {
    console.warn('Failed to filter active remote branches, returning all:', errorField(error, 'message'));
    return remoteBranches;
  }
}

export async function createBranch(directory: string, branchName: string, options: { startPoint?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.checkoutBranch(branchName, options.startPoint || 'HEAD');
    return { success: true, branch: branchName };
  } catch (error) {
    console.error('Failed to create branch:', error);
    throw error;
  }
}

const gitRefExists = async (git: SimpleGit, ref: string) => {
  try {
    const output = await git.raw(['show-ref', '--verify', ref]);
    return String(output).trim().length > 0;
  } catch {
    return false;
  }
};

const resolveBranchCheckoutTarget = async (git: SimpleGit, branchName: string) => {
  const requested = String(branchName || '').trim();
  if (!requested) {
    throw new Error('Branch name is required');
  }

  const asRequested = { branch: requested, remoteRef: null };

  if (await gitRefExists(git, `refs/heads/${requested}`)) {
    return asRequested;
  }

  const remoteRef = requested.replace(/^remotes\//, '');
  const remotes = await git.getRemotes();
  const remote = remotes.find((entry) => entry?.name && remoteRef.startsWith(`${entry.name}/`));
  if (!remote) {
    return asRequested;
  }

  const localBranch = remoteRef.slice(remote.name.length + 1);
  if (!localBranch || localBranch === 'HEAD') {
    return asRequested;
  }

  if (!(await gitRefExists(git, `refs/remotes/${remoteRef}`))) {
    try {
      await git.fetch(remote.name, localBranch);
    } catch (error) {
      throw new Error(`Failed to fetch ${localBranch} from ${remote.name}: ${errorField(error, 'message') || error}`);
    }
    if (!(await gitRefExists(git, `refs/remotes/${remoteRef}`))) {
      throw new Error(`Branch ${localBranch} no longer exists on remote ${remote.name}`);
    }
  }

  const localExists = await gitRefExists(git, `refs/heads/${localBranch}`);
  return { branch: localBranch, remoteRef: localExists ? null : remoteRef };
};

export async function checkoutBranch(directory: string, branchName: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const target = await resolveBranchCheckoutTarget(git, branchName);
    if (target.remoteRef) {
      await git.raw(['checkout', '-b', target.branch, '--track', target.remoteRef]);
    } else {
      await git.checkout(target.branch);
    }
    return { success: true, branch: target.branch };
  } catch (error) {
    console.error('Failed to checkout branch:', error);
    throw error;
  }
}

export async function checkoutCommit(directory: string, hash: string) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);
  try {
    await git.checkout(hash);
    return { success: true };
  } catch (error) {
    console.error('Failed to checkout commit:', error);
    throw error;
  }
}

export async function cherryPick(directory: string, hash: string) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);
  try {
    await git.raw(['cherry-pick', hash]);
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = String(errorField(error, 'message') || error || '').toLowerCase();
    const isConflict =
      errorMessage.includes('conflict') ||
      errorMessage.includes('patch does not apply');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || [],
      };
    }

    console.error('Failed to cherry-pick:', error);
    throw error;
  }
}

export async function revertCommit(directory: string, hash: string) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);
  try {
    await git.raw(['revert', '--no-commit', hash]);
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = String(errorField(error, 'message') || error || '').toLowerCase();
    const isConflict =
      errorMessage.includes('conflict') ||
      errorMessage.includes('revert failed');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || [],
      };
    }

    console.error('Failed to revert commit:', error);
    throw error;
  }
}

export async function resetToCommit(directory: string, hash: string, mode: string, force = false) {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const { git } = await createRepositoryGitContext(directory);

  if (mode === 'hard' && !force) {
    const status = await git.status();
    const isDirty = !status.isClean();
    if (isDirty) {
      throw new Error('Cannot hard reset: uncommitted changes in working tree. Stash or commit first, or use force.');
    }
  }

  try {
    await git.raw(['reset', `--${mode}`, hash]);
    return { success: true };
  } catch (error) {
    console.error('Failed to reset to commit:', error);
    throw error;
  }
}

const resolveWorktreeListingDirectory = async (directoryPath: string) => {
  try {
    const directoryGit = await createGit(directoryPath);
    return await resolveGitRepositoryRoot(directoryPath, directoryGit);
  } catch (error) {
    const probe = await runGitCommand(directoryPath, ['rev-parse', '--git-dir']);
    if (probe.success) {
      return directoryPath;
    }
    throw error;
  }
};

export async function getWorktrees(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !await directoryExists(directoryPath)) {
    if (directoryPath) await assertPathReachable(path.resolve(directoryPath));
    return [];
  }
  await assertLinkedRepositoryReachable(directoryPath);
  try {
    const listingDirectory = await resolveWorktreeListingDirectory(directoryPath);
    const entries = await listWorktreeEntries(listingDirectory);
    const [titles, pins, commonDirectory] = await Promise.all([
      readBranchTitles(listingDirectory),
      readBranchPins(listingDirectory),
      runGitCommandOrThrow(listingDirectory, ['rev-parse', '--git-common-dir'], 'Failed to read the repository'),
    ]);
    const rows = entries
      .filter((entry) => entry.bare !== true)
      .map((entry) => {
        const title = entry.branch ? titles.get(entry.branch) : undefined;
        const pin = entry.branch ? pins.get(entry.branch) : undefined;
        return {
          head: entry.head || '',
          name: path.basename(entry.worktree || ''),
          branch: entry.branch || '',
          path: entry.worktree,
          prunable: entry.prunable === true,
          title: title || undefined,
          pinnedAt: pin?.pinnedAt,
          pinList: pin?.list,
        };
      });
    return await flagIntegrateCheckouts(listingDirectory, commonDirectory.stdout, rows, () => integration.resumeFinishing(listingDirectory));
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      await assertRepositoryReachable(directoryPath);
      return [];
    }
    throw error;
  }
}

const TASK_TITLE_MAX_LENGTH = 120;
const BRANCH_TITLE_KEY_PATTERN = '^branch\\..*\\.description$';

export const toTaskTitle = (description: string | undefined) => {
  const firstLine = String(description || '').split(/\r?\n/).find((line) => line.trim()) || '';
  return firstLine.trim().slice(0, TASK_TITLE_MAX_LENGTH);
};

const readBranchTitles = async (repositoryDirectory: string) => {
  const titles = new Map<string, string>();
  const result = await runGitCommand(repositoryDirectory, ['config', '-z', '--get-regexp', BRANCH_TITLE_KEY_PATTERN]);
  if (!result.success) return titles;
  for (const record of String(result.stdout || '').split('\0')) {
    const newline = record.indexOf('\n');
    if (newline <= 0) continue;
    const branch = record.slice('branch.'.length, newline - '.description'.length);
    const title = toTaskTitle(record.slice(newline + 1));
    if (branch && title) titles.set(branch, title);
  }
  return titles;
};

const BRANCH_PIN_KEY_PATTERN = '^branch\\..*\\.openchamberpinned$';
const BRANCH_PIN_KEY_SUFFIX = '.openchamberpinned';

const readBranchPins = async (repositoryDirectory: string) => {
  const pins = new Map<string, NonNullable<ReturnType<typeof parseBranchPin>>>();
  const result = await runGitCommand(repositoryDirectory, ['config', '-z', '--get-regexp', BRANCH_PIN_KEY_PATTERN]);
  if (!result.success) return pins;
  for (const record of String(result.stdout || '').split('\0')) {
    const newline = record.indexOf('\n');
    if (newline <= 0) continue;
    const branch = record.slice('branch.'.length, newline - BRANCH_PIN_KEY_SUFFIX.length);
    const pin = parseBranchPin(record.slice(newline + 1));
    if (branch && pin) pins.set(branch, pin);
  }
  return pins;
};

const parseBranchPin = (value: string) => {
  const [at, list] = String(value || '').trim().split(/\s+/, 2);
  const pinnedAt = Number(at);
  if (!Number.isFinite(pinnedAt) || pinnedAt <= 0) return null;
  return { pinnedAt, list: list || undefined };
};
const PIN_LIST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export async function setWorktreePinned(directory: string, pinned: boolean, list: string | null = null, now = Date.now()) {
  if (list !== null && !PIN_LIST_ID_PATTERN.test(list)) {
    const error: Error & { status?: number } = new Error('The pin list id is not valid');
    error.status = 400;
    throw error;
  }
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !await directoryExists(directoryPath)) {
    const error: Error & { status?: number } = new Error('The worktree folder does not exist');
    error.status = 404;
    throw error;
  }
  const head = await runGitCommandOrThrow(directoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'The worktree is not on a branch')
    .catch((cause) => {
      const error: Error & { status?: number } = new Error('The worktree is not on a branch, so it cannot be pinned');
      error.status = 409;
      error.cause = cause;
      throw error;
    });
  const branch = String(head.stdout || '').trim();
  const key = `branch.${branch}.openchamberPinned`;
  const current = parseBranchPin(await readGitConfigValue(directoryPath, key));
  const next = pinned ? [String(current?.pinnedAt ?? now), ...(list ? [list] : [])].join(' ') : '';
  const stored = current ? [String(current.pinnedAt), ...(current.list ? [current.list] : [])].join(' ') : '';
  if (next !== stored) {
    await writeGitConfigValue(directoryPath, key, next);
    void publishWorktreeTopologyChange(directoryPath);
  }
  return { pinned, branch };
}

export async function isWorktreeDirectoryPinned(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !await directoryExists(directoryPath)) return false;
  const result = await runGitCommand(directoryPath, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD']);
  if (!result.success) return false;
  const [gitDir, commonDir, branch] = String(result.stdout || '').split(/\r?\n/);
  if (!gitDir || !commonDir || gitDir === commonDir || !branch || branch === 'HEAD') return false;
  return parseBranchPin(await readGitConfigValue(directoryPath, `branch.${branch}.openchamberPinned`)) !== null;
}

export const readGitConfigValue = async (directory: string, key: string) => {
  const result = await runGitCommand(directory, ['config', '--get', key]);
  return result.success ? String(result.stdout || '').replace(/\r?\n$/, '') : '';
};

const CONFIG_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];
const isConfigLockError = (result: GitCommandResult) => /could not lock config file/i.test([result?.message, result?.stderr].filter(Boolean).join('\n'));
const runGitConfigWrite = async (directory: string, args: string[]) => {
  for (let attempt = 0; ; attempt += 1) {
    const result = await runGitCommand(directory, ['config', ...args]);
    const delay = CONFIG_LOCK_RETRY_DELAYS_MS[attempt];
    if (result.success || delay === undefined || !isConfigLockError(result)) return result;
    await wait(delay);
  }
};

export const writeGitConfigValue = async (directory: string, key: string, value: string) => {
  if (value) {
    const result = await runGitConfigWrite(directory, [key, value]);
    if (!result.success) throw new Error(result.message || `Failed to write ${key}`);
    return;
  }
  const result = await runGitConfigWrite(directory, ['--unset', key]);
  if (!result.success && result.exitCode !== 5) throw new Error(`Failed to clear ${key}`);
};

export async function setWorktreeTaskTitle(directory: string, input: { by?: string; title?: string } = {}) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !await directoryExists(directoryPath)) {
    const error: Error & { status?: number } = new Error('The worktree folder does not exist');
    error.status = 404;
    throw error;
  }
  const by = input?.by === 'agent' ? 'agent' : 'user';
  const title = toTaskTitle(input?.title);
  if (by === 'agent' && !title) {
    const error: Error & { status?: number } = new Error('title is required');
    error.status = 400;
    throw error;
  }
  const head = await runGitCommandOrThrow(directoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 'The worktree is not on a branch')
    .catch((cause) => {
      const error: Error & { status?: number } = new Error('The worktree is not on a branch, so it has no task title');
      error.status = 409;
      error.cause = cause;
      throw error;
    });
  const branch = String(head.stdout || '').trim();
  return applyBranchTaskTitle(directoryPath, branch, by, title);
}

const applyBranchTaskTitle = async (directory: string, branch: string, by: string, title: string) => {
  const descriptionKey = `branch.${branch}.description`;
  const agentTitleKey = `branch.${branch}.openchamberAgentTitle`;
  const current = toTaskTitle(await readGitConfigValue(directory, descriptionKey));
  if (by === 'agent') {
    const agentTitle = toTaskTitle(await readGitConfigValue(directory, agentTitleKey));
    if (current && current !== agentTitle) return { applied: false, title: current, branch, by: 'user' };
    if (current === title) return { applied: true, title, branch, by: 'agent' };
    await writeGitConfigValue(directory, descriptionKey, title);
    await writeGitConfigValue(directory, agentTitleKey, title);
  } else {
    if (current === title && !(await readGitConfigValue(directory, agentTitleKey))) {
      return { applied: true, title, branch, by: 'user' };
    }
    await writeGitConfigValue(directory, descriptionKey, title);
    await writeGitConfigValue(directory, agentTitleKey, '');
  }
  void publishWorktreeTopologyChange(directory);
  return { applied: true, title, branch, by };
};

export async function markGeneratedBranchName(directory: string, branch: string, prefix: string | null = null) {
  const branchName = String(branch || '').trim();
  const directoryPath = normalizeDirectoryPath(directory);
  if (!branchName || !directoryPath) return;
  const keep = String(prefix || '').trim();
  try {
    await writeGitConfigValue(directoryPath, `branch.${branchName}.openchamberGeneratedName`, branchName);
    if (keep && keep.length < branchName.length && branchName.startsWith(keep)) {
      await writeGitConfigValue(directoryPath, `branch.${branchName}.openchamberGeneratedPrefix`, keep);
    }
  } catch (error) {
    console.warn('Failed to mark a generated branch name:', error instanceof Error ? error.message : String(error));
  }
}

export async function readRenameableGeneratedBranch(directory: string, checkedOutBranch: string | null = null) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) return null;
  let branch = String(checkedOutBranch || '').trim();
  if (!branch) {
    const head = await runGitCommand(directoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    branch = head.success ? String(head.stdout || '').trim() : '';
  }
  if (!branch) return null;
  if ((await readGitConfigValue(directoryPath, `branch.${branch}.openchamberGeneratedName`)).trim() !== branch) return null;
  if ((await readGitConfigValue(directoryPath, `branch.${branch}.remote`)).trim()) return null;
  const remote = await runGitCommand(directoryPath, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`]);
  if (!remote.success || String(remote.stdout || '').trim()) return null;
  return branch;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const withItemKey = (requested: string, prefix: string) => {
  const key = prefix.replace(/^issue-/, '').replace(/-+$/, '').toLowerCase();
  if (!key || !requested) return requested;
  if (new RegExp(`(^|[/-])${escapeRegExp(key)}($|[/-])`, 'i').test(requested)) return requested;
  const segments = requested.split('/');
  const last = segments.pop();
  return [...segments, `${key}-${last}`].join('/');
};

export async function renameGeneratedWorktreeBranch(directory: string, newName: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  const current = directoryPath ? await readRenameableGeneratedBranch(directoryPath) : null;
  if (!current) return null;
  const prefix = (await readGitConfigValue(directoryPath, `branch.${current}.openchamberGeneratedPrefix`)).trim();
  const name = withItemKey(String(newName || '').trim(), prefix);
  const fail = (message: string, status: number) => Object.assign(new Error(message), { status });
  if (!name || name === current) throw fail(`Name the branch after the task, not \`${current}\``, 400);
  const valid = await runGitCommand(directoryPath, ['check-ref-format', '--branch', name]);
  if (!valid.success) throw fail(`\`${name}\` is not a valid branch name`, 400);
  await renameBranch(directoryPath, current, name).catch((error) => {
    throw fail(error instanceof Error ? error.message : String(error), error?.statusCode ?? 500);
  });
  return { from: current, to: name };
}

export async function seedBranchTaskTitle(directory: string, branch: string, rawTitle: string) {
  const title = toTaskTitle(rawTitle);
  const branchName = String(branch || '').trim();
  if (!title || !branchName) return;
  await applyBranchTaskTitle(normalizeDirectoryPath(directory), branchName, 'agent', title).catch((error) => {
    console.warn('Failed to seed the worktree task title:', error instanceof Error ? error.message : String(error));
  });
}

const MAX_TRACKED_WORKTREE_DIRECTORIES = 500;
const MAX_TRACKED_WORKTREE_REPOSITORIES = 200;
const MAX_DIRECTORIES_PER_WORKTREE_REPOSITORY = 100;
const worktreeTopologyListeners = new Set<(event: WorktreeTopologyEvent) => void>();
const worktreeRepositoryKeyByDirectory = new Map<string, string>();
const worktreeTopologyByRepository = new Map<string, WorktreeTopologyEntry>();

export function subscribeWorktreeTopologyChanges(listener: (event: WorktreeTopologyEvent) => void) {
  worktreeTopologyListeners.add(listener);
  return () => {
    worktreeTopologyListeners.delete(listener);
  };
}

const rememberWorktreeRepositoryKey = (directoryPath: string, key: string) => {
  worktreeRepositoryKeyByDirectory.delete(directoryPath);
  worktreeRepositoryKeyByDirectory.set(directoryPath, key);
  while (worktreeRepositoryKeyByDirectory.size > MAX_TRACKED_WORKTREE_DIRECTORIES) {
    const oldest = worktreeRepositoryKeyByDirectory.keys().next().value;
    if (oldest === undefined) break;
    worktreeRepositoryKeyByDirectory.delete(oldest);
  }
};

const resolveWorktreeRepositoryKey = async (directoryPath: string) => {
  const cached = worktreeRepositoryKeyByDirectory.get(directoryPath);
  if (cached) {
    rememberWorktreeRepositoryKey(directoryPath, cached);
    return cached;
  }
  const result = await runGitCommand(directoryPath, ['rev-parse', '--git-common-dir']);
  const rawCommonDir = String(result.stdout || '').trim();
  if (!result.success || !rawCommonDir) {
    return null;
  }
  const commonDir = path.resolve(directoryPath, rawCommonDir);
  let key = commonDir;
  try {
    key = await promisify(fs.realpath)(commonDir);
  } catch {
    void 0;
  }
  rememberWorktreeRepositoryKey(directoryPath, key);
  return key;
};

const trackWorktreeTopologyDirectory = (repositoryKey: string, directoryPath: string) => {
  let entry = worktreeTopologyByRepository.get(repositoryKey);
  if (!entry) {
    entry = { directories: new Set(), fingerprint: null };
  }
  worktreeTopologyByRepository.delete(repositoryKey);
  worktreeTopologyByRepository.set(repositoryKey, entry);
  while (worktreeTopologyByRepository.size > MAX_TRACKED_WORKTREE_REPOSITORIES) {
    const oldest = worktreeTopologyByRepository.keys().next().value;
    if (oldest === undefined) break;
    worktreeTopologyByRepository.delete(oldest);
  }
  if (entry.directories.size < MAX_DIRECTORIES_PER_WORKTREE_REPOSITORY) {
    entry.directories.add(directoryPath);
  }
  return entry;
};

const notifyWorktreeTopologyChanged = (entry: WorktreeTopologyEntry) => {
  const event = { directories: [...entry.directories], at: Date.now() };
  for (const listener of worktreeTopologyListeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('Worktree topology listener failed:', errorField(error, 'message') || error);
    }
  }
};

export async function observeWorktreeTopology(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || await directoryReachability.isUnreachable(directoryPath)) return;
  try {
    const repositoryKey = await resolveWorktreeRepositoryKey(directoryPath);
    if (!repositoryKey) return;
    const entry = trackWorktreeTopologyDirectory(repositoryKey, directoryPath);
    const fingerprint = await readWorktreeTopologyFingerprint(repositoryKey);
    const missedRead = await integration.takeMissedRead(directoryPath);
    if (entry.fingerprint === fingerprint && !missedRead) return;
    const hadBaseline = entry.fingerprint !== null || missedRead;
    entry.fingerprint = fingerprint;
    if (hadBaseline) notifyWorktreeTopologyChanged(entry);
  } catch (error) {
    console.warn('Failed to observe worktree topology:', errorField(error, 'message') || error);
  }
}

const publishWorktreeTopologyChange = async (directory: string) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) return;
  try {
    const repositoryKey = await resolveWorktreeRepositoryKey(directoryPath);
    if (!repositoryKey) return;
    const entry = trackWorktreeTopologyDirectory(repositoryKey, directoryPath);
    entry.fingerprint = await readWorktreeTopologyFingerprint(repositoryKey);
    notifyWorktreeTopologyChanged(entry);
  } catch (error) {
    console.warn('Failed to publish worktree topology change:', errorField(error, 'message') || error);
  }
};

export async function validateWorktreeCreate(directory: string, input: WorktreeCreateInput = {}, { bootstrapStore }: BootstrapOptions = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const errors: Array<{ code: string; message: string; setupFailed?: true }> = [];

  try {
    const context = await resolveWorktreeProjectContext(directory);
    const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
    const startRef = normalizeStartRef(input?.startRef);
    const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
    const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
    const contributorFork = input?.contributorFork === true;
    const _requestedExistingBranch = String(input?.existingBranch || '').trim();
    let remoteCollision = false;
    if (contributorFork && ensureRemoteName && ensureRemoteUrl) {
      const existingRemote = await captureRemoteUrl(context.primaryWorktree, ensureRemoteName);
      remoteCollision = existingRemote.exists
        && !(await isSameRemoteUrl(context.primaryWorktree, existingRemote.url, ensureRemoteUrl));
      if (remoteCollision) {
        errors.push({
          code: 'remote_name_collision',
          message: `Remote ${ensureRemoteName} already exists with a different endpoint`,
        });
      }
    }
    const contributorNeedsTransfer = (contributorFork || input?.changeRequestTransfer === true)
      && input?.contributorTransferComplete !== true;

    let localBranch = '';
    let inferredUpstream = null;

    if (mode === 'existing') {
      if (contributorNeedsTransfer) {
        errors.push({
          code: 'contributor_transfer_unavailable',
          message: 'Contributor worktree transfer requires managed credentials',
        });
      } else if (!remoteCollision) {
        try {
          const resolved = await resolveExistingWorktreeSource(context.primaryWorktree, input, 'validate');
          localBranch = resolved.localBranch || '';
          if (resolved.upstream) {
            inferredUpstream = {
              remote: resolved.upstream.remote,
              branch: resolved.upstream.branch,
            };
          }
        } catch (error) {
          errors.push({
            code: 'branch_not_found',
            message: error instanceof Error ? error.message : 'Existing branch not found',
          });
        }
      }
    } else if (contributorFork) {
      errors.push({
        code: 'contributor_transfer_unavailable',
        message: 'Contributor worktree transfer requires managed credentials',
      });
    } else {
      if (preferredBranchName) {
        const exists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${preferredBranchName}`]);
        if (exists.success) {
          errors.push({
            code: 'branch_exists',
            message: `Branch already exists: ${preferredBranchName}`,
          });
        }
        localBranch = preferredBranchName;
      }

      const parsedRemoteRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
      if (startRef && startRef !== 'HEAD') {
        if (parsedRemoteRef && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedRemoteRef.remote) {
          const remoteCheck = await checkLocalRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch
          );
          if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch is not available locally: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else if (parsedRemoteRef) {
          const remoteCheck = await ensureLocalRemoteBranchRef(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch
          );
          if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch not found: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else {
          const startRefExists = await runGitCommand(context.primaryWorktree, ['rev-parse', '--verify', '--quiet', startRef]);
          if (!startRefExists.success) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Start ref not found: ${startRef}`,
            });
          }
        }
      }

      if (parsedRemoteRef) {
        inferredUpstream = {
          remote: parsedRemoteRef.remote,
          branch: parsedRemoteRef.branch,
        };
      }
    }

    if (localBranch) {
      const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
      if (inUse) {
        const branchInUse: (typeof errors)[number] = {
          code: 'branch_in_use',
          message: `Branch is already checked out in ${inUse.worktree}`,
        };
        if (inUse.worktree && await readFailedWorktreeSetup(context.primaryWorktree, inUse.worktree, bootstrapStore)) {
          branchInUse.setupFailed = true;
        }
        errors.push(branchInUse);
      }
    }

    if ((ensureRemoteName && !ensureRemoteUrl) || (!ensureRemoteName && ensureRemoteUrl)) {
      errors.push({
        code: 'invalid_remote_config',
        message: 'Both ensureRemoteName and ensureRemoteUrl are required together',
      });
    }

    const shouldSetUpstream = Boolean(input?.setUpstream);
    if (contributorFork && shouldSetUpstream) {
      errors.push({
        code: 'contributor_upstream_forbidden',
        message: 'Contributor worktrees cannot configure upstream tracking',
      });
    }
    if (shouldSetUpstream) {
      const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
      const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

      if (!upstreamRemote || !upstreamBranch) {
        errors.push({
          code: 'upstream_incomplete',
          message: 'upstreamRemote and upstreamBranch are required when setUpstream is true',
        });
      } else {
        const remoteExists = await runGitCommand(context.primaryWorktree, ['remote', 'get-url', '--', upstreamRemote]);
        if (!remoteExists.success && (!ensureRemoteName || ensureRemoteName !== upstreamRemote)) {
          errors.push({
            code: 'remote_not_found',
            message: `Remote not found: ${upstreamRemote}`,
          });
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      resolved: {
        mode,
        localBranch: localBranch || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        code: 'validation_failed',
        message: error instanceof Error ? error.message : 'Failed to validate worktree creation',
      }],
    };
  }
}

const assertWorktreeCreatePreflight = async (directory: string, input: WorktreeCreateInput = {}) => {
  const validation = await validateWorktreeCreate(directory, input);
  if (validation?.ok) {
    return;
  }

  const message = validation?.errors
    ?.map((error) => error?.message)
    .filter(Boolean)
    .join('\n') || 'Failed to validate worktree creation';
  const collision = validation?.errors?.find((error) => error?.code === 'remote_name_collision');
  if (collision) {
    throw Object.assign(new Error(collision.message), {
      code: 'CONTRIBUTOR_REMOTE_COLLISION',
      status: 409,
      remoteName: String(input?.ensureRemoteName || '').trim(),
    });
  }
  if (validation?.errors?.some((error) => error?.code === 'contributor_transfer_unavailable')) {
    throw Object.assign(new Error('Contributor worktree transfer requires managed credentials'), {
      code: 'CONTRIBUTOR_MANAGED_TRANSFER_REQUIRED', status: 409,
    });
  }
  throw new Error(message);
};

export async function previewWorktreeCreate(directory: string, input: WorktreeCreateInput = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);
  await fsp.mkdir(context.worktreeRoot, { recursive: true });
  context.worktreeRoot = await fsp.realpath(context.worktreeRoot);

  const preferredName = String(input?.worktreeName || input?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  return {
    name: candidate.name,
    branch: mode === 'new' ? candidate.branch : preferredBranchName,
    path: candidate.directory,
  };
}

const readLocalBranchTip = async (primaryWorktree: string, branch: string) => {
  const result = await runGitCommand(primaryWorktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  return result.success ? String(result.stdout || '').trim() : '';
};

const prepareChangeRequestLocalBranch = async (primaryWorktree: string, input: WorktreeCreateInput = {}) => {
  const expectedRevision = String(input?.expectedRevision || '').trim();
  if (input?.changeRequestTransfer !== true || !expectedRevision) return null;
  const remoteRef = await resolveRemoteBranchRef(primaryWorktree, String(input?.existingBranch || '').trim());
  const branch = cleanBranchName(String(input?.branchName || '').trim() || remoteRef?.branch || '');
  if (!remoteRef || !branch) return null;
  const tip = await readLocalBranchTip(primaryWorktree, branch);
  if (!tip || await findBranchInUse(primaryWorktree, branch)) return null;
  if (await isAncestorRef(primaryWorktree, tip, expectedRevision)) return { branch, tip, backupBranch: null };

  const backupBranch = `${branch}-backup-${tip.slice(0, 7)}`;
  const backupTip = await readLocalBranchTip(primaryWorktree, backupBranch);
  if (backupTip && backupTip !== tip) {
    throw new Error(`Branch ${branch} has commits the change request no longer has, and ${backupBranch} already exists`);
  }
  if (!backupTip) {
    await runGitCommandOrThrow(primaryWorktree, ['branch', '--no-track', backupBranch, tip], `Failed to keep ${branch} as ${backupBranch}`);
  }
  return { branch, tip, backupBranch };
};

const branchNameClashesWithExistingRef = async (primaryWorktree: string, branchName: string) => {
  const segments = String(branchName || '').split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const candidates = segments.map((_, index) => `refs/heads/${segments.slice(0, index + 1).join('/')}`);
  const target = candidates[candidates.length - 1];
  const result = await runGitCommand(primaryWorktree, ['for-each-ref', '--format=%(refname)', ...candidates]);
  if (!result.success) return false;
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).some((ref) => (
    candidates.includes(ref) || ref.startsWith(`${target}/`)
  ));
};

const readFailedWorktreeSetup = async (primaryWorktree: string, directory: string, bootstrapStore?: BootstrapStore) => {
  if (await canonicalPath(directory) === await canonicalPath(primaryWorktree)) return null;
  if (await hasActiveWorktreeBootstrap(directory)) return null;
  const state = await getWorktreeBootstrapStatus(directory, { bootstrapStore });
  return state.status === WORKTREE_BOOTSTRAP_FAILED ? state : null;
};

const { resumeFailedChangeRequestWorktree } = createWorktreeResume({
  ...remoteProvisioning, runGitCommand, runGitCommandOrThrow, findBranchInUse, readFailedWorktreeSetup,
  startWorktreeBootstrap, normalizeGitOutputPath, checkPathExists,
});

async function attachGitWorktreeToCandidateWithoutRemoteRollback(context: WorktreeProjectContext, candidate: WorktreeCandidate, input: WorktreeCreateInput = {}, serverOptions: WorktreeServerOptions = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const startRef = normalizeStartRef(input?.startRef);
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

  let localBranch = '';
  let inferredUpstream = null;
  let shouldSetUpstream = input?.contributorFork === true ? false : Boolean(input?.setUpstream);
  let checkoutRemoteName = '';
  const expectedRevision = String(input?.expectedRevision || '').trim();
  const contributorFork = input?.contributorFork === true;
  const contributorSource = serverOptions.contributorSource;
  if (contributorFork && (!ensureRemoteName || !ensureRemoteUrl || !expectedRevision
    || !contributorSource || !(serverOptions.contributorProvenance?.compareAndSwap instanceof Function))) {
    throw Object.assign(new Error('Contributor worktree provenance requirements are incomplete'), {
      code: 'INVALID_CONTRIBUTOR_WORKTREE', status: 400,
    });
  }
  let createdLocalBranch = false;
  let parsedStartBranch = null;
  let movedLocalBranch = null;
  const worktreeAddArgs = ['worktree', 'add', '--no-checkout'];
  const createCommand = contributorFork ? '' : String(input?.createCommand || '').trim();
  let branchStart: BranchStart | null = null;

  if (mode === 'existing') {
    const resolved = await resolveExistingWorktreeSource(context.primaryWorktree, input, 'create');
    localBranch = resolved.localBranch;
    shouldSetUpstream = resolved.setUpstream;

    const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
    if (inUse) {
      throw new Error(`Branch is already checked out in ${inUse.worktree}`);
    }

    const reusedBranch = serverOptions.changeRequestLocalBranch;
    if (resolved.createLocalBranch && reusedBranch?.branch === localBranch) {
      if (await readLocalBranchTip(context.primaryWorktree, localBranch) !== reusedBranch.tip) {
        throw new Error(`Branch ${localBranch} changed during worktree creation`);
      }
      worktreeAddArgs.push('-B', localBranch);
      movedLocalBranch = reusedBranch;
    } else if (resolved.createLocalBranch) {
      worktreeAddArgs.push('-b', localBranch);
      createdLocalBranch = true;
    }
    const checkoutStart = expectedRevision && resolved.createLocalBranch
      ? expectedRevision
      : resolved.checkoutRef;
    worktreeAddArgs.push(candidate.directory, checkoutStart);
    if (resolved.createLocalBranch) branchStart = { start: checkoutStart, force: Boolean(movedLocalBranch) };
    if (movedLocalBranch && contributorFork) {
      await runGitCommand(context.primaryWorktree, ['config', '--unset-all', `branch.${localBranch}.remote`]);
      await runGitCommand(context.primaryWorktree, ['config', '--unset-all', `branch.${localBranch}.merge`]);
    }

    if (resolved.upstream) {
      inferredUpstream = {
        remote: resolved.upstream.remote,
        branch: resolved.upstream.branch,
      };
    }
    if (resolved.createLocalBranch && resolved.upstream
      && (contributorFork || (ensureRemoteName && ensureRemoteUrl))) {
      checkoutRemoteName = resolved.upstream.remote;
    }
  } else {
    localBranch = candidate.branch;
    if (!localBranch) {
      throw new Error('Failed to resolve branch name for new worktree');
    }

    const branchExists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`]);
    if (branchExists.success) {
      throw new Error(`Branch already exists: ${localBranch}`);
    }

    const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
    if (inUse) {
      throw new Error(`Branch is already checked out in ${inUse.worktree}`);
    }

    worktreeAddArgs.push('-b', localBranch, candidate.directory);
    if (startRef && startRef !== 'HEAD') {
      worktreeAddArgs.push(startRef);
    }

    const parsedRemoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
    if (parsedRemoteStartRef) {
      parsedStartBranch = parsedRemoteStartRef.branch;
      worktreeAddArgs.splice(2, 0, '--no-track');
      inferredUpstream = {
        remote: parsedRemoteStartRef.remote,
        branch: parsedRemoteStartRef.branch,
      };
      checkoutRemoteName = parsedRemoteStartRef.remote;
    }
    branchStart = { start: startRef && startRef !== 'HEAD' ? startRef : 'HEAD', noTrack: Boolean(parsedRemoteStartRef) };
  }

  if (mode === 'existing' && ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrlUnlocked(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }
  if (!checkoutRemoteName) {
    checkoutRemoteName = await resolveCheckoutRemoteName(context.primaryWorktree, mode === 'existing' ? localBranch : startRef) ?? '';
  }
  checkoutRemoteName = await networkRemoteName(context.primaryWorktree, checkoutRemoteName);

  const branchNameConflict = (mode === 'new' || createdLocalBranch)
    && await branchNameClashesWithExistingRef(context.primaryWorktree, localBranch);

  const releaseLocalBranch = async () => {
    if (createdLocalBranch) return (await runGitCommand(context.primaryWorktree, ['branch', '-D', localBranch])).success;
    if (movedLocalBranch) {
      return (await runGitCommand(context.primaryWorktree, ['branch', '-f', localBranch, movedLocalBranch.tip])).success;
    }
    return true;
  };

  try {
    if (createCommand) {
      const directory = await createWorktreeWithCommand({
        primaryWorktree: context.primaryWorktree,
        directory: candidate.directory,
        branch: localBranch,
        branchStart,
        command: createCommand,
      }).catch(async (error) => {
        if (error?.branchMade && !(await findBranchInUse(context.primaryWorktree, localBranch))) {
          if (mode === 'new') await runGitCommand(context.primaryWorktree, ['branch', '-D', localBranch]);
          else await releaseLocalBranch();
        }
        throw error;
      });
      candidate = { ...candidate, directory };
    } else {
      await worktreeRegistry.add(context.primaryWorktree, worktreeAddArgs, candidate.directory, 'Failed to create git worktree');
    }
  } catch (error) {
    if (branchNameConflict && !errorField(error, 'code')) {
      if (!hasErrorFields(error)) throw error;
      throw Object.assign(error, { code: 'BRANCH_NAME_CONFLICT' });
    }
    throw error;
  }
  await publishWorktreeTopologyChange(context.primaryWorktree);
  if (mode === 'new') {
    const parent = parsedStartBranch ?? await localBranchNameOf(context.primaryWorktree, startRef);
    await recordBranchParent(context.primaryWorktree, localBranch, parent);
  }

  if (expectedRevision) {
    const createdHead = await runGitCommand(candidate.directory, ['rev-parse', '--verify', 'HEAD']);
    if (!createdHead.success || String(createdHead.stdout || '').trim() !== expectedRevision) {
      const removed = await runGitCommand(context.primaryWorktree, ['worktree', 'remove', '--force', candidate.directory]);
      if (removed.success && !(await releaseLocalBranch())) {
        throw new Error('Created worktree revision does not match the requested change request head, and the local branch could not be restored safely');
      }
      if (!removed.success) {
        throw new Error('Created worktree revision does not match the requested change request head, and the worktree could not be removed safely');
      }
      throw new Error('Created worktree revision does not match the requested change request head');
    }
  }

  let provenanceRecord = null;
  if (contributorFork && contributorSource && serverOptions.contributorProvenance) {
    try {
      provenanceRecord = await serverOptions.contributorProvenance.compareAndSwap(candidate.directory, 0, {
        kind: 'contributor-fork',
        remoteName: ensureRemoteName,
        endpointFingerprint: fingerprintRemoteUrl(ensureRemoteUrl),
        sourceSha: expectedRevision.toLowerCase(),
        sourceRef: contributorSource.headRef,
        sourceProjectId: contributorSource.sourceProject.id,
        targetProjectId: contributorSource.targetProject.id,
        provider: contributorSource.context.provider,
        instance: contributorSource.context.instance,
        accountId: contributorSource.context.accountId,
        bindingRevision: contributorSource.context.bindingRevision,
        primaryRemote: contributorSource.context.primaryRemote,
        projectId: context.projectID,
        setupCommand: String(input?.startCommand || '').trim(),
      });
    } catch (error) {
      const removed = await runGitCommand(context.primaryWorktree, ['worktree', 'remove', '--force', candidate.directory]);
      if (removed.success) await releaseLocalBranch();
      throw error;
    }
  }

  const upstreamRemote = shouldSetUpstream
    ? String(input?.upstreamRemote || inferredUpstream?.remote || '').trim()
    : '';
  const upstreamBranch = shouldSetUpstream
    ? String(input?.upstreamBranch || inferredUpstream?.branch || '').trim()
    : '';

  const bootstrapStatus = await startWorktreeBootstrap({
    directory: candidate.directory,
    projectDirectory: context.requestedDirectory,
    primaryWorktree: context.primaryWorktree,
    localBranch,
    setUpstream: shouldSetUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand: input?.startCommand,
    contributorFork,
    hydrateCheckout: serverOptions.hydrateCheckout,
    checkoutRemoteName,
    bootstrapStore: serverOptions.bootstrapStore,
    populated: Boolean(createCommand),
  });

  const headResult = await runGitCommand(candidate.directory, ['rev-parse', 'HEAD']);
  const head = String(headResult.stdout || '').trim();

  const result: WorktreeCreateResult = {
    head,
    name: candidate.name,
    branch: localBranch,
    path: candidate.directory,
    directoryCreated: true,
    bootstrapStatus,
  };
  if (provenanceRecord) result.provenance = contributorProvenanceResult(provenanceRecord.revision);
  return result;
}

async function attachGitWorktreeToCandidate(context: WorktreeProjectContext, candidate: WorktreeCandidate, input: WorktreeCreateInput = {}, serverOptions: WorktreeServerOptions = {}) {
  const remoteName = String(input?.ensureRemoteName || '').trim();
  const remoteUrl = String(input?.ensureRemoteUrl || '').trim();
  if (!remoteName || !remoteUrl) {
    return attachGitWorktreeToCandidateWithoutRemoteRollback(context, candidate, input, serverOptions);
  }
  return withRemoteProvisioningQueue(context.primaryWorktree, remoteName, async () => {
    const previous = await captureRemoteUrl(context.primaryWorktree, remoteName);
    try {
      return await attachGitWorktreeToCandidateWithoutRemoteRollback(context, candidate, input, serverOptions);
    } catch (error) {
      if (previous.exists && previous.url !== remoteUrl) throw error;
      try {
        await restoreProvisionedRemote(context.primaryWorktree, remoteName, remoteUrl, previous);
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`${error instanceof Error ? error.message : String(error)}, and the provisioned remote could not be restored: ${detail}`);
      }
      throw error;
    }
  });
}

const fetchRemoteBranchRef = async (primaryWorktree: string, remoteName: string, branchName: string) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return;
  }

  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  await runGitCommandOrThrow(
    primaryWorktree,
    ['fetch', '--', remote, refspec],
    `Failed to fetch ${remote}/${branch}`
  );
};

const isAncestorRef = async (cwd: string, ancestor: string, descendant: string) => {
  const result = await runGitCommand(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.success;
};

const resolvePublishedLocalBranchUpstream = async (primaryWorktree: string, startRef: string) => {
  const branch = String(startRef || '').trim().replace(/^refs\/heads\//, '');
  if (!branch || branch === 'HEAD') return null;
  const localRef = `refs/heads/${branch}`;
  const refs = await runGitCommand(primaryWorktree, [
    'for-each-ref',
    '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
    localRef,
  ]);
  if (!refs.success) return null;
  const line = refs.stdout.split('\n').find((entry) => entry.startsWith(`${localRef}\0`));
  if (!line) return null;
  const [, trackingRef, remote, remoteRef] = line.split('\0');
  const remoteBranch = String(remoteRef || '').replace(/^refs\/heads\//, '');
  if (!remote || !remoteBranch || trackingRef !== `refs/remotes/${remote}/${remoteBranch}`) return null;
  if (!(await isAncestorRef(primaryWorktree, localRef, trackingRef))) return null;
  return { remote, branch: remoteBranch, localRef, trackingRef };
};

const sourceFetchFailure = <Failure>(error: Failure) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const access = errorField(error, 'reason') === 'needs-attention' || errorField(error, 'code') === 'AUTHENTICATION_REQUIRED'
    || /authentication failed|could not read username|permission denied/i.test(message);
  return access ? { sourceFetchFailed: true, sourceFetchReason: 'access' } : { sourceFetchFailed: true };
};

const preparePublishedLocalBranchSource = async (context: WorktreeProjectContext, input: WorktreeCreateInput, startRef: string) => {
  const upstream = await resolvePublishedLocalBranchUpstream(context.primaryWorktree, startRef);
  if (!upstream) return { input, sourceFetchFailed: false };
  try {
    await fetchRemoteBranchRef(context.primaryWorktree, upstream.remote, upstream.branch);
  } catch (error) {
    return { input, ...sourceFetchFailure(error) };
  }
  if (!(await isAncestorRef(context.primaryWorktree, upstream.localRef, upstream.trackingRef))) {
    return { input, sourceFetchFailed: false };
  }
  return {
    input: { ...input, startRef: `remotes/${upstream.remote}/${upstream.branch}` },
    sourceFetchFailed: false,
  };
};

const prepareWorktreeCreateSource = async (context: WorktreeProjectContext, input: WorktreeCreateInput = {}) => {
  if (input?.mode === 'existing') {
    return { input, sourceFetchFailed: false };
  }

  const startRef = normalizeStartRef(input?.startRef);
  const remoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
  if (!remoteStartRef) {
    return preparePublishedLocalBranchSource(context, input, startRef);
  }

  const status = await getStatus(context.primaryWorktree, { mode: 'light' }).catch(() => null);
  const trackingRef = status?.tracking
    ? await resolveRemoteBranchRef(context.primaryWorktree, status.tracking)
    : null;
  const canFallbackToLocal = Boolean(
    status?.current
    && status.ahead === 0
    && trackingRef?.fullRef === remoteStartRef.fullRef
  );

  try {
    await fetchRemoteBranchRef(context.primaryWorktree, remoteStartRef.remote, remoteStartRef.branch);
    return { input, sourceFetchFailed: false };
  } catch (error) {
    if (canFallbackToLocal) {
      return {
        input: { ...input, startRef: status?.current ?? null },
        ...sourceFetchFailure(error),
      };
    }

    const refExists = await runGitCommand(
      context.primaryWorktree,
      ['show-ref', '--verify', '--quiet', remoteStartRef.fullRef]
    );
    if (!refExists.success) {
      throw error;
    }
    console.warn(`Worktree create: failed to refresh ${remoteStartRef.remote}/${remoteStartRef.branch}, proceeding with the existing remote-tracking ref`);
    return { input, sourceFetchFailed: false };
  }
};

export async function createWorktree(directory: string, input: WorktreeCreateInput = {}, serverOptions: WorktreeServerOptions = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);

  const resumed = await resumeFailedChangeRequestWorktree(context, input, serverOptions);
  if (resumed) return resumed;

  if (input?.returnAfterDirectoryCreated === true || input?.contributorFork === true) {
    await assertWorktreeCreatePreflight(directory, input);
  }

  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
  if (mode !== 'existing' && ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }
  const prepared = await prepareWorktreeCreateSource(context, input);
  const preparedInput = prepared.input;
  const changeRequestLocalBranch = mode === 'existing'
    ? await prepareChangeRequestLocalBranch(context.primaryWorktree, preparedInput)
    : null;
  const attachOptions = changeRequestLocalBranch ? { ...serverOptions, changeRequestLocalBranch } : serverOptions;
  const withBranchBackup = (result: WorktreeCreateResult) => (changeRequestLocalBranch?.backupBranch
    ? { ...result, branchBackup: changeRequestLocalBranch.backupBranch }
    : result);

  await fsp.mkdir(context.worktreeRoot, { recursive: true });
  context.worktreeRoot = await fsp.realpath(context.worktreeRoot);

  const preferredName = String(preparedInput?.worktreeName || preparedInput?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(preparedInput?.branchName || '').trim());

  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  const usesCreateCommand = preparedInput?.contributorFork !== true && Boolean(String(preparedInput?.createCommand || '').trim());
  if (preparedInput?.returnAfterDirectoryCreated === true && preparedInput?.contributorFork !== true && !usesCreateCommand) {
    await fsp.mkdir(candidate.directory, { recursive: false });

    let bootstrapStatus;
    try {
      bootstrapStatus = await setWorktreeBootstrapState(
        candidate.directory,
        WORKTREE_BOOTSTRAP_PENDING,
        WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
        null,
        undefined,
        undefined,
        serverOptions.bootstrapStore,
      );
    } catch (error) {
      if (!isBootstrapPersistenceFailure(error)) throw error;
      bootstrapStatus = error.bootstrapStatus;
    }
    const localBranch = mode === 'existing'
      ? cleanBranchName(String(preparedInput?.branchName || preparedInput?.existingBranch || candidate.branch || '').trim())
      : candidate.branch;

    if (bootstrapStatus === null) throw new TypeError('Missing worktree bootstrap state');
    const task = bootstrapStatus.status === WORKTREE_BOOTSTRAP_PENDING
      ? attachGitWorktreeToCandidate(context, candidate, preparedInput, attachOptions).catch(async (error) => {
      const failureCode = bootstrapFailureCode(
        error,
        isFilenameTooLongError(error instanceof Error ? error.message : error),
      );
      await setWorktreeBootstrapState(
        candidate.directory,
        WORKTREE_BOOTSTRAP_FAILED,
        WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
        worktreeBootstrapFailureMessage(failureCode)
          ?? 'Worktree creation failed. Inspect the checkout and repair it before use.',
        undefined,
        failureCode,
        serverOptions.bootstrapStore,
      ).catch(() => {});
      await cleanupFailedFastWorktreeCreate(context, candidate, serverOptions.bootstrapStore);
      console.warn('Background worktree creation failed:', error instanceof Error ? error.message : String(error));
      })
      : null;
    if (task) trackWorktreeBootstrapTask(candidate.directory, task);

    const result: WorktreeCreateResult = {
      head: '',
      name: candidate.name,
      branch: localBranch,
      path: candidate.directory,
      directoryCreated: true,
      bootstrapStatus,
    };
    if (prepared.sourceFetchFailed) {
      result.sourceFetchFailed = true;
      if (prepared.sourceFetchReason) result.sourceFetchReason = prepared.sourceFetchReason;
    }
    return withBranchBackup(result);
  }

  const result = withBranchBackup(await attachGitWorktreeToCandidate(context, candidate, preparedInput, attachOptions));
  if (!prepared.sourceFetchFailed) return result;
  return prepared.sourceFetchReason
    ? { ...result, sourceFetchFailed: true, sourceFetchReason: prepared.sourceFetchReason }
    : { ...result, sourceFetchFailed: true };
}

const bootstrapFailureCode = <Failure>(error: Failure, pathLengthFailure: boolean) => {
  if (hasErrorFields(error) && error.hydration) return error.code;
  if (pathLengthFailure) return 'PATH_LENGTH_LIMIT';
  if (errorField(error, 'reason') === 'needs-attention' || errorField(error, 'code') === 'AUTHENTICATION_REQUIRED') return 'AUTHENTICATION_REQUIRED';
  return knownWorktreeBootstrapFailureCode(errorField(error, 'code')) ?? 'UNKNOWN';
};

const inspectWorktreeBootstrapRecovery = async (directory: string) => {
  const attached = await runGitCommand(directory, ['rev-parse', '--is-inside-work-tree']);
  if (!attached.success || String(attached.stdout || '').trim() !== 'true') {
    return createWorktreeBootstrapState(
      WORKTREE_BOOTSTRAP_FAILED,
      WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
      WORKTREE_BOOTSTRAP_RECOVERY_ERROR,
      undefined,
      'OUTCOME_UNKNOWN',
    );
  }
  const head = await runGitCommand(directory, ['rev-parse', '--verify', 'HEAD']);
  const indexMatchesHead = await runGitCommand(directory, ['diff', '--cached', '--quiet', 'HEAD', '--']);
  const deleted = await runGitCommand(directory, ['ls-files', '--deleted', '-z']);
  const checkoutPopulated = head.success && String(head.stdout || '').trim()
    && indexMatchesHead.success && deleted.success && !String(deleted.stdout || '');
  return createWorktreeBootstrapState(
    WORKTREE_BOOTSTRAP_FAILED,
    checkoutPopulated ? WORKTREE_BOOTSTRAP_PHASE_GIT_READY : WORKTREE_BOOTSTRAP_PHASE_DIRECTORY_CREATED,
    WORKTREE_BOOTSTRAP_RECOVERY_ERROR,
    undefined,
    'OUTCOME_UNKNOWN',
  );
};

const notBootstrappedHere = () => createWorktreeBootstrapState(
  WORKTREE_BOOTSTRAP_READY,
  WORKTREE_BOOTSTRAP_PHASE_SETUP_READY,
);

const adoptPersistedBootstrapState = async (key: string, persisted: WorktreeBootstrapState, bootstrapStore: BootstrapStore) => {
  const current = worktreeBootstrapState.get(key);
  if (persisted.status === WORKTREE_BOOTSTRAP_FAILED && isRolledBackAttemptFailure(current)) {
    return current ?? persisted;
  }
  if (persisted.status !== WORKTREE_BOOTSTRAP_PENDING || await hasActiveWorktreeBootstrap(key)) {
    worktreeBootstrapState.set(key, persisted);
    if (persisted.status === WORKTREE_BOOTSTRAP_FAILED && !await hasActiveWorktreeBootstrap(key)
      && await forgetMissingWorktreeFailure(key, bootstrapStore)) {
      return worktreeBootstrapState.get(key) ?? notBootstrappedHere();
    }
    return persisted;
  }
  const blocker = await inspectWorktreeBootstrapRecovery(key);
  worktreeBootstrapState.set(key, blocker);
  await bootstrapStore.write(key, blocker);
  return blocker;
};

export async function getWorktreeBootstrapStatus(directory: string, { bootstrapStore }: BootstrapOptions = {}) {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) {
    throw new Error('Worktree directory is required');
  }

  if (bootstrapStore) {
    try {
      const persisted = await bootstrapStore.read(key);
      if (!persisted) {
        if (isReclaimableFailure(worktreeBootstrapState.get(key)) && !await hasActiveWorktreeBootstrap(key)) {
          await forgetMissingWorktreeFailure(key, bootstrapStore);
        }
        return worktreeBootstrapState.get(key) ?? notBootstrappedHere();
      }
      return await adoptPersistedBootstrapState(key, persisted, bootstrapStore);
    } catch {
      const current = worktreeBootstrapState.get(key);
      if (current && isRolledBackAttemptFailure(current)) return current;
      const blocker = await inspectWorktreeBootstrapRecovery(key);
      worktreeBootstrapState.set(key, blocker);
      return blocker;
    }
  }
  if (isReclaimableFailure(worktreeBootstrapState.get(key)) && !await hasActiveWorktreeBootstrap(key)) {
    await forgetMissingWorktreeFailure(key);
  }
  return worktreeBootstrapState.get(key) ?? notBootstrappedHere();
}

const worktreeBootstrapGateLoads = new Map<string, Promise<void>>();

export async function getWorktreeBootstrapGateStatus(directory: string, { bootstrapStore }: BootstrapOptions = {}) {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) {
    throw new Error('Worktree directory is required');
  }
  if (bootstrapStore && !worktreeBootstrapState.has(key)) {
    let load = worktreeBootstrapGateLoads.get(key);
    if (!load) {
      load = (async () => {
        try {
          const persisted = await bootstrapStore.read(key);
          if (persisted && !worktreeBootstrapState.has(key)) {
            await adoptPersistedBootstrapState(key, persisted, bootstrapStore);
          }
        } catch (error) {
          if (errorField(error, 'code') === DIRECTORY_UNREACHABLE) worktreeBootstrapGateLoads.delete(key);
          console.warn(`[git] Could not read the saved setup state of ${key}:`, errorField(error, 'message') ?? error);
        }
      })();
      worktreeBootstrapGateLoads.set(key, load);
    }
    await load;
  }
  const current = worktreeBootstrapState.get(key);
  if (isReclaimableFailure(current) && !await hasActiveWorktreeBootstrap(key)
    && await directoryIsGone(key)) {
    try {
      await forgetMissingWorktreeFailure(key, bootstrapStore);
    } catch {
      void 0;
    }
    return worktreeBootstrapState.get(key) ?? notBootstrappedHere();
  }
  return current ?? notBootstrappedHere();
}

export async function completeWorktreeCheckoutHydration(directory: string, { bootstrapStore, disposeInstance }: BootstrapOptions & Pick<WorktreeRemovalInput, 'disposeInstance'> = {}) {
  const key = await toCanonicalBootstrapStateKey(directory);
  if (!key) throw new Error('Worktree directory is required');
  const recorded = bootstrapStore ? await bootstrapStore.read(key) : worktreeBootstrapState.get(key);
  if (recorded?.status === WORKTREE_BOOTSTRAP_FAILED && recorded.hydration) {
    await disposeWorktreeInstanceBestEffort(disposeInstance, directory);
  }
  if (bootstrapStore) {
    const completed = await bootstrapStore.completeHydration(key);
    if (completed) worktreeBootstrapState.set(key, completed);
    return completed;
  }
  const current = worktreeBootstrapState.get(key);
  if (current?.status !== WORKTREE_BOOTSTRAP_FAILED || !current.hydration
    || ['succeeded', 'not-needed'].some((status) => status === errorField(current.hydration, 'status'))) return null;
  const completed = createWorktreeBootstrapState(
    WORKTREE_BOOTSTRAP_READY,
    WORKTREE_BOOTSTRAP_PHASE_SETUP_READY,
  );
  worktreeBootstrapState.set(key, completed);
  return completed;
}

const disposeWorktreeInstanceBestEffort = async (disposeInstance: WorktreeRemovalInput['disposeInstance'], worktreeDirectory: string) => {
  if (!disposeInstance) {
    return;
  }
  try {
    await disposeInstance(worktreeDirectory);
  } catch (error) {
    console.warn(
      `Failed to dispose the OpenCode instance for worktree ${worktreeDirectory}:`,
      error instanceof Error ? error.message : String(error)
    );
  }
};

const worktreeRemovalsInProgress = new Set<{ root: string; settled: Promise<void> }>();

const canonicalPathOfExistingAncestor = async (input: string) => {
  const absolutePath = path.resolve(input);
  for (let current = absolutePath; ; current = path.dirname(current)) {
    const realPath = await realpathOf(current).catch(() => null);
    if (realPath !== null || path.dirname(current) === current) {
      const normalized = path.normalize(path.join(realPath ?? current, path.relative(current, absolutePath)));
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }
  }
};

const trackWorktreeRemoval = (canonicalDirectory: string) => {
  let settle: (() => void) | undefined;
  const removal = { root: canonicalDirectory, settled: new Promise<void>((resolve) => { settle = resolve; }) };
  worktreeRemovalsInProgress.add(removal);
  return () => {
    worktreeRemovalsInProgress.delete(removal);
    settle?.();
  };
};

export async function waitForWorktreeRemoval(directory: string) {
  if (worktreeRemovalsInProgress.size === 0) return;
  const key = toBootstrapStateKey(directory);
  if (!key) return;
  const target = await canonicalPathOfExistingAncestor(key);
  const pending = [...worktreeRemovalsInProgress]
    .filter((removal) => isInsideOrSameDirectory(removal.root, target))
    .map((removal) => removal.settled);
  await Promise.all(pending);
}

const WORKTREE_BUSY_RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const WORKTREE_BUSY_MESSAGE = 'The worktree folder is still in use by another process (a running session, terminal or editor). Stop it and try again.';

const isWorktreeBusyError = <Text>(text: Text) => process.platform === 'win32'
  && /Permission denied|EBUSY|EPERM|resource busy|being used by another process/i.test(String(text || ''));

const removeBusyDirectory = async (targetDirectory: string) => {
  try {
    await fsp.rm(targetDirectory, { recursive: true, force: true, maxRetries: WORKTREE_BUSY_RETRY_DELAYS_MS.length, retryDelay: WORKTREE_BUSY_RETRY_DELAYS_MS[0] });
  } catch (error) {
    if (isWorktreeBusyError(errorField(error, 'code')) || isWorktreeBusyError(errorField(error, 'message'))) {
      throw new Error(WORKTREE_BUSY_MESSAGE);
    }
    throw error;
  }
};

const isSameFilesystemEntry = (current: fs.Stats | null, original: fs.Stats) => current?.dev === original.dev && current?.ino === original.ino;

const replaceWorktreeGitDirectoryLink = async (primaryWorktree: string, worktreePath: string) => {
  const gitEntry = path.join(worktreePath, '.git');
  const linkStat = await fsp.lstat(gitEntry).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!linkStat?.isSymbolicLink() || !(await fsp.stat(gitEntry)).isDirectory()) return null;

  const linkTarget = await fsp.readlink(gitEntry, { encoding: 'buffer' });
  const metadataDirectory = await fsp.realpath(gitEntry);
  const commonResult = await runGitCommandOrThrow(primaryWorktree, ['rev-parse', '--git-common-dir']);
  const commonDirectory = await canonicalPath(path.resolve(primaryWorktree, commonResult.stdout.trim()));
  const metadataRoot = await canonicalPath(path.join(commonDirectory, 'worktrees'));
  if (await canonicalPath(path.dirname(metadataDirectory)) !== metadataRoot) {
    throw new Error('Worktree .git symlink target is outside this repository\'s worktree metadata');
  }

  const commonDir = (await fsp.readFile(path.join(metadataDirectory, 'commondir'), 'utf8')).trim();
  if (!commonDir || await canonicalPath(path.resolve(metadataDirectory, commonDir)) !== commonDirectory) {
    throw new Error('Worktree .git symlink metadata has a different common directory');
  }

  const backlink = (await fsp.readFile(path.join(metadataDirectory, 'gitdir'), 'utf8')).trim();
  const backlinkPath = path.resolve(metadataDirectory, backlink);
  if (!backlink || path.basename(backlinkPath) !== '.git'
    || await canonicalPath(path.dirname(backlinkPath)) !== await canonicalPath(worktreePath)) {
    throw new Error('Worktree .git symlink metadata backlink does not name this worktree');
  }

  const worktreeStat = await fsp.stat(worktreePath);
  const metadataStat = await fsp.stat(metadataDirectory);
  const sameDirectoriesExist = async () => {
    const [currentWorktree, currentMetadata] = await Promise.all([
      fsp.stat(worktreePath).catch(() => null),
      fsp.stat(metadataDirectory).catch(() => null),
    ]);
    return currentWorktree?.isDirectory() && isSameFilesystemEntry(currentWorktree, worktreeStat)
      && currentMetadata?.isDirectory() && isSameFilesystemEntry(currentMetadata, metadataStat);
  };
  const restoreClaimedEntry = async (claimedEntry: string) => {
    const claimedStat = await fsp.lstat(claimedEntry);
    if (claimedStat.isSymbolicLink()) {
      const claimedTarget = await fsp.readlink(claimedEntry, { encoding: 'buffer' });
      await fsp.symlink(claimedTarget, gitEntry);
      const currentLink = await fsp.lstat(claimedEntry).catch(() => null);
      return currentLink?.isSymbolicLink() && isSameFilesystemEntry(currentLink, claimedStat)
        && (await fsp.readlink(claimedEntry, { encoding: 'buffer' })).equals(claimedTarget);
    }
    if (claimedStat.isFile()) {
      await fsp.link(claimedEntry, gitEntry);
      return true;
    }
    return false;
  };
  const contents = `gitdir: ${process.platform === 'win32' ? toGitPath(metadataDirectory) : metadataDirectory}\n`;
  const temporaryEntry = `${gitEntry}.openchamber-${crypto.randomUUID()}`;
  const claimedLinkEntry = `${gitEntry}.openchamber-${crypto.randomUUID()}`;
  let temporaryIdentity;
  let claimedLink = false;
  let releaseLinkClaim: boolean | undefined = false;
  try {
    await fsp.writeFile(temporaryEntry, contents, { flag: 'wx', mode: 0o600 });
    temporaryIdentity = await getFileIdentity(temporaryEntry);
    const currentLink = await fsp.lstat(gitEntry);
    if (!currentLink.isSymbolicLink() || !isSameFilesystemEntry(currentLink, linkStat)
      || !(await fsp.readlink(gitEntry, { encoding: 'buffer' })).equals(linkTarget)) {
      throw new Error('Worktree .git entry changed before removal');
    }
    await fsp.rename(gitEntry, claimedLinkEntry);
    claimedLink = true;
    const capturedLink = await fsp.lstat(claimedLinkEntry);
    if (!capturedLink.isSymbolicLink() || !isSameFilesystemEntry(capturedLink, linkStat)
      || !(await fsp.readlink(claimedLinkEntry, { encoding: 'buffer' })).equals(linkTarget)
      || !await sameDirectoriesExist()) {
      throw new Error('Worktree .git entry changed before removal');
    }
    await fsp.link(temporaryEntry, gitEntry);
    releaseLinkClaim = true;
  } catch (error) {
    if (claimedLink && await sameDirectoriesExist()) {
      try {
        releaseLinkClaim = await restoreClaimedEntry(claimedLinkEntry);
      } catch (restoreError) {
        if (errorField(restoreError, 'code') !== 'EEXIST') {
          console.warn('Failed to restore claimed worktree .git entry before removal:', restoreError);
        }
      }
    }
    throw error;
  } finally {
    if (claimedLink) {
      if (releaseLinkClaim) {
        await fsp.unlink(claimedLinkEntry).catch((error) => {
          if (error?.code !== 'ENOENT') {
            console.warn(`Failed to clean up worktree .git recovery entry: ${claimedLinkEntry}`, error);
          }
        });
      } else {
        console.warn(`Check worktree .git recovery entry: ${claimedLinkEntry}`);
      }
    }
    await fsp.rm(temporaryEntry, { force: true }).catch((error) => {
      console.warn('Failed to clean up temporary worktree gitdir file:', error);
    });
  }

  return async () => {
    const isTemporaryFile = async (entry: string) => {
      const stat = await fsp.lstat(entry).catch(() => null);
      return stat?.isFile() && await getFileIdentity(entry) === temporaryIdentity
        && await fsp.readFile(entry, 'utf8') === contents;
    };
    if (!await sameDirectoriesExist() || !await isTemporaryFile(gitEntry)) return;

    const claimedEntry = `${gitEntry}.openchamber-${crypto.randomUUID()}`;
    try {
      await fsp.rename(gitEntry, claimedEntry);
    } catch (error) {
      if (errorField(error, 'code') === 'ENOENT') return;
      throw error;
    }

    let releaseClaim: boolean | undefined = false;
    try {
      if (!await sameDirectoriesExist()) return;
      if (!await isTemporaryFile(claimedEntry)) {
        releaseClaim = await restoreClaimedEntry(claimedEntry);
        return;
      }
      try {
        await fsp.symlink(linkTarget, gitEntry, 'dir');
        releaseClaim = true;
      } catch (error) {
        if (errorField(error, 'code') === 'EEXIST') {
          releaseClaim = await isTemporaryFile(claimedEntry);
          return;
        }
        if (await sameDirectoriesExist()) {
          await fsp.link(claimedEntry, gitEntry);
          releaseClaim = true;
        }
        throw error;
      }
    } finally {
      if (releaseClaim) {
        await fsp.unlink(claimedEntry);
      } else {
        console.warn(`Check worktree .git recovery entry: ${claimedEntry}`);
      }
    }
  };
};

const removeGitWorktreeWhenFree = async (primaryWorktree: string, worktreePath: string, targetCanonical: string, releaseInstance: () => Promise<void>, overrideLock = false) => {
  const removeArgs = ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', ...(overrideLock ? ['--force'] : []), worktreePath];
  for (let attempt = 0; ; attempt += 1) {
    await directoryReachability.assertReachable(worktreePath);
    await worktreeRegistry.assertEnumerable(primaryWorktree);
    const result = await runGitCommand(primaryWorktree, removeArgs);
    if (result.success) return true;
    const busy = isWorktreeBusyError(result.message);
    if (!busy && result.exitCode === 128) {
      throw new Error(result.message || 'Failed to remove git worktree');
    }
    const stillRegistered = await (async () => {
      for (const entry of await listWorktreeEntries(primaryWorktree)) {
        if (entry?.worktree && await canonicalPath(entry.worktree) === targetCanonical) return true;
      }
      return false;
    })();
    if (!stillRegistered) {
      await releaseInstance();
      return false;
    }
    if (!busy) {
      throw new Error(result.message || 'Failed to remove git worktree');
    }
    const delay = WORKTREE_BUSY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) throw new Error(WORKTREE_BUSY_MESSAGE);
    await releaseInstance();
    await wait(delay);
  }
};

const WORKTREE_TEARDOWN_TIMEOUT_MS = 5 * 60 * 1000;
const WORKTREE_TEARDOWN_OUTPUT_MAX_CHARS = 2000;

const WORKTREE_TEARDOWN_FAILED = 'WORKTREE_TEARDOWN_FAILED';

const runWorktreeTeardown = async (worktreeDirectory: string, command: string | undefined, isContributorCheckout: WorktreeRemovalInput['isContributorCheckout']) => {
  if (!String(command || '').trim()) return;
  if (!(await checkPathExists(worktreeDirectory))) return;
  const bootstrap = worktreeBootstrapState.get(await toCanonicalBootstrapStateKey(worktreeDirectory));
  if (bootstrap?.status === WORKTREE_BOOTSTRAP_FAILED) return;
  if (isContributorCheckout instanceof Function) {
    const contributor = await isContributorCheckout(worktreeDirectory).catch((error) => {
      throw Object.assign(new Error(`Could not tell whether this checkout holds a contributor's code, so no teardown command ran and the worktree was kept: ${error?.message || error}`), { code: WORKTREE_TEARDOWN_FAILED });
    });
    if (contributor) return;
  }
  const result = await runWorktreeStartCommand(worktreeDirectory, command, { timeoutMs: WORKTREE_TEARDOWN_TIMEOUT_MS });
  if (!result.success) {
    const shown = shownCommandFailure(result, WORKTREE_TEARDOWN_OUTPUT_MAX_CHARS);
    throw Object.assign(new Error(`Worktree teardown command failed, so the worktree was kept: ${shown}`), { code: WORKTREE_TEARDOWN_FAILED });
  }
};

export async function teardownWorktree(directory: string, input: WorktreeRemovalInput = {}) {
  const targetDirectory = input?.directory === undefined ? undefined : normalizeDirectoryPath(input.directory);
  if (!targetDirectory) throw new Error('Worktree directory is required');
  await directoryReachability.assertReachable(targetDirectory);
  const targetCanonical = await canonicalPath(targetDirectory);
  await waitForActiveWorktreeBootstrap(targetDirectory);
  await waitForActiveWorktreeBootstrap(targetCanonical);
  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  if (targetCanonical === await canonicalPath(context.primaryWorktree)) {
    throw new Error('Cannot tear down the primary workspace');
  }
  const entry = await findRegisteredWorktree(context.primaryWorktree, targetCanonical);
  if (entry?.worktree) await runWorktreeTeardown(entry.worktree, input?.teardownCommand, input?.isContributorCheckout);
  return true;
}

export async function removeWorktree(directory: string, input: WorktreeRemovalInput = {}, { bootstrapStore }: BootstrapOptions = {}) {
  const targetDirectory = input?.directory === undefined ? undefined : normalizeDirectoryPath(input.directory);
  if (!targetDirectory) {
    throw new Error('Worktree directory is required');
  }
  await directoryReachability.assertReachable(targetDirectory);
  await worktreeRegistry.assertEnumerable(directory);

  const targetCanonical = await canonicalPath(targetDirectory);
  if (input?.cancelSetup === true) await cancelWorktreeSetup(targetDirectory);
  await waitForActiveWorktreeBootstrap(targetDirectory);
  await waitForActiveWorktreeBootstrap(targetCanonical);

  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  const deleteLocalBranch = input?.deleteLocalBranch === true;

  const primaryCanonical = await canonicalPath(context.primaryWorktree);
  if (targetCanonical === primaryCanonical) {
    throw new Error('Cannot remove the primary workspace');
  }
  const worktreeRootCanonical = await canonicalPath(context.worktreeRoot);
  const legacyWorktreeRootCanonical = context.legacyWorktreeRoot
    ? await canonicalPath(context.legacyWorktreeRoot)
    : null;

  const entries = await listWorktreeEntries(context.primaryWorktree);
  const matchedEntry = await (async () => {
    for (const entry of entries) {
      if (!entry?.worktree) {
        continue;
      }
      const entryCanonical = await canonicalPath(entry.worktree);
      if (entryCanonical === targetCanonical) {
        return entry;
      }
    }
    return null;
  })();

  const removeManagedOrphan = async ({ registered }: { registered: boolean }) => {
    const insideLegacyRoot = legacyWorktreeRootCanonical !== null
      && targetCanonical !== legacyWorktreeRootCanonical
      && isInsideOrSameDirectory(legacyWorktreeRootCanonical, targetCanonical);
    const insideConfiguredRoot = targetCanonical !== worktreeRootCanonical
      && isInsideOrSameDirectory(worktreeRootCanonical, targetCanonical);
    const isManagedOrphan = insideLegacyRoot || (registered && insideConfiguredRoot);

    await clearWorktreeBootstrapState(targetDirectory, bootstrapStore);
    const targetExists = await checkPathExists(targetDirectory);
    if (targetExists && isManagedOrphan) {
      await removeBusyDirectory(targetDirectory);
    }
    await worktreeRegistry.forget(context.primaryWorktree, targetDirectory).catch((error) => console.warn('Failed to forget the worktree:', error));
  };

  if (!matchedEntry?.worktree) {
    await removeManagedOrphan({ registered: false });
    return true;
  }

  await runWorktreeTeardown(matchedEntry.worktree, input?.teardownCommand, input?.isContributorCheckout);

  await clearWorktreeBootstrapState(matchedEntry.worktree, bootstrapStore);
  const createdByCommand = await readWorktreeCreatedByCommand(matchedEntry.worktree);
  const settleRemoval = trackWorktreeRemoval(targetCanonical);
  const releaseInstance = () => disposeWorktreeInstanceBestEffort(input?.disposeInstance, matchedEntry.worktree);
  try {
    await releaseInstance();

    const restoreGitDirectoryLink = await replaceWorktreeGitDirectoryLink(context.primaryWorktree, matchedEntry.worktree);
    try {
      const overrideLock = matchedEntry.locked === true && createdByCommand !== null;
      const removedByGit = await removeGitWorktreeWhenFree(context.primaryWorktree, matchedEntry.worktree, targetCanonical, releaseInstance, overrideLock);
      if (!removedByGit) {
        await removeManagedOrphan({ registered: true });
      }
      await removeCreateCommandLink(createdByCommand?.link, matchedEntry.worktree);
    } catch (error) {
      if (restoreGitDirectoryLink) {
        await restoreGitDirectoryLink().catch((restoreError) => {
          console.warn('Failed to restore worktree .git symlink after removal failed:', restoreError);
        });
      }
      throw error;
    }
  } finally {
    settleRemoval();
  }
  await publishWorktreeTopologyChange(context.primaryWorktree);

  if (deleteLocalBranch) {
    const branchName = cleanBranchName(String(matchedEntry.branchRef || matchedEntry.branch || '').trim());
    if (branchName && !(await isBranchKeptOnWorktreeRemoval(context.primaryWorktree, branchName))) {
      await runGitCommandOrThrow(
        context.primaryWorktree,
        ['branch', '-D', branchName],
        `Failed to delete local branch ${branchName}`
      );
    }
  }

  return true;
}

const RUN_SNAPSHOT_REF_PATTERN = /^refs\/openchamber\/runs\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const assertRunSnapshotRef = <Ref>(ref: Ref) => {
  const value = isPrimitiveString(ref) ? ref.trim() : '';
  if (!RUN_SNAPSHOT_REF_PATTERN.test(value) || value.includes('..')) {
    throw new Error('Invalid snapshot ref');
  }
  return value;
};

const SNAPSHOT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'OpenChamber',
  GIT_AUTHOR_EMAIL: 'snapshot@openchamber.local',
  GIT_COMMITTER_NAME: 'OpenChamber',
  GIT_COMMITTER_EMAIL: 'snapshot@openchamber.local',
};

const readWorktreeStateTree = async (worktreeDirectory: string) => {
  const head = (await runGitCommandOrThrow(worktreeDirectory, ['rev-parse', '--verify', 'HEAD'], 'Worktree has no HEAD commit')).stdout.trim();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-'));
  const env = { ...(await buildGitEnv(worktreeDirectory)), GIT_INDEX_FILE: path.join(tempDir, 'index') };
  try {
    for (const args of [['read-tree', head], ['add', '-A']]) {
      const result = await runGitCommand(worktreeDirectory, args, { env });
      if (!result.success) throw new Error(result.message || 'Failed to read the worktree state');
    }
    const tree = await runGitCommand(worktreeDirectory, ['write-tree'], { env });
    if (!tree.success) throw new Error(tree.message || 'Failed to read the worktree state');
    return { head, tree: tree.stdout.trim() };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const commitSnapshot = async (directory: string, { ref, message, oldValue, head, tree }: SnapshotOptions & { head: string; tree: string }) => {
  const env = { ...(await buildGitEnv(directory)), ...SNAPSHOT_IDENTITY_ENV };
  const commit = await runGitCommand(directory, ['commit-tree', tree, '-p', head, '-m', message], { env });
  if (!commit.success) throw new Error(commit.message || 'Failed to write snapshot commit');
  const commitSha = commit.stdout.trim();
  await runGitCommandOrThrow(directory, ['update-ref', ref, commitSha, ...(oldValue === undefined ? [] : [oldValue])], 'Failed to store snapshot ref');
  return { ref, commit: commitSha, head };
};

const writeWorktreeSnapshot = async (worktreeDirectory: string, options: SnapshotOptions) => (
  commitSnapshot(worktreeDirectory, { ...options, ...(await readWorktreeStateTree(worktreeDirectory)) })
);

export async function snapshotWorktree(directory: string, input: { ref?: unknown } = {}) {
  const worktreeDirectory = normalizeDirectoryPath(directory);
  if (!worktreeDirectory) {
    throw new Error('Worktree directory is required');
  }
  const ref = assertRunSnapshotRef(input?.ref);
  return writeWorktreeSnapshot(worktreeDirectory, { ref, message: 'OpenChamber run snapshot' });
}

const WORKTREE_ARCHIVE_REF_PREFIX = 'refs/openchamber/archive/';
const WORKTREE_ARCHIVE_SUBJECT = 'OpenChamber worktree archive';
const WORKTREE_ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

const worktreeArchiveIdSchema = z.string().trim().regex(WORKTREE_ARCHIVE_ID_PATTERN);

const assertWorktreeArchiveId = <Id>(id: Id) => {
  const parsed = worktreeArchiveIdSchema.safeParse(id);
  if (!parsed.success) throw new Error('Invalid worktree archive id');
  return parsed.data;
};

const sessionIdListSchema = z.array(z.unknown()).catch([])
  .transform((entries) => entries.flatMap((entry) => {
    const parsed = z.string().min(1).safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }));

const worktreeArchiveRecordSchema = z.object({
  path: z.string().min(1),
  branch: z.string().catch(''),
  title: z.string().catch(''),
  archivedAt: z.number().finite().catch(0),
  sessionIds: sessionIdListSchema,
});

const parseWorktreeArchiveMessage = (message: string) => {
  const text = String(message || '');
  if (!text.startsWith(WORKTREE_ARCHIVE_SUBJECT)) return null;
  try {
    return worktreeArchiveRecordSchema.safeParse(JSON.parse(text.slice(WORKTREE_ARCHIVE_SUBJECT.length).trim())).data ?? null;
  } catch {
    return null;
  }
};

const readWorktreeArchives = async (primaryWorktree: string) => {
  const listing = await runGitCommandOrThrow(primaryWorktree, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(parent)%00%(contents)%1e',
    WORKTREE_ARCHIVE_REF_PREFIX,
  ], 'Failed to list worktree archives');
  const branches = await runGitCommand(primaryWorktree, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  const localBranches = new Set(branches.success ? String(branches.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean) : []);
  return String(listing.stdout || '').split('\x1e').flatMap((chunk) => {
    const [ref = '', commit = '', head = '', message = ''] = chunk.replace(/^\n/, '').split('\0');
    if (!ref.startsWith(WORKTREE_ARCHIVE_REF_PREFIX)) return [];
    const record = parseWorktreeArchiveMessage(message);
    if (!record) return [];
    const id = ref.slice(WORKTREE_ARCHIVE_REF_PREFIX.length);
    return [{ id, ref, commit, head: head.split(' ')[0] || '', ...record, branchExists: Boolean(record.branch) && localBranches.has(record.branch) }];
  }).sort((a, b) => b.archivedAt - a.archivedAt);
};

const readWorktreeArchive = async <Id>(primaryWorktree: string, id: Id) => {
  const archiveId = assertWorktreeArchiveId(id);
  const archive = (await readWorktreeArchives(primaryWorktree)).find((entry) => entry.id === archiveId);
  if (!archive) throw Object.assign(new Error('Worktree archive not found'), { code: 'WORKTREE_ARCHIVE_NOT_FOUND' });
  return archive;
};

export async function listWorktreeArchives(directory: string) {
  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  return readWorktreeArchives(context.primaryWorktree);
}

const worktreeArchivesInFlight = new Set<string>();

const worktreeArchiveError = (message: string, code: string) => Object.assign(new Error(message), { code });

export async function archiveWorktree(directory: string, input: WorktreeArchiveInput = {}, options: BootstrapOptions = {}) {
  const id = assertWorktreeArchiveId(input?.id);
  const worktreeDirectory = input?.directory === undefined ? undefined : normalizeDirectoryPath(input.directory);
  if (!worktreeDirectory) throw new Error('Worktree directory is required');
  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  const targetCanonical = await canonicalPath(worktreeDirectory);
  if (targetCanonical === await canonicalPath(context.primaryWorktree)) {
    throw new Error('Cannot archive the primary workspace');
  }
  if (worktreeArchivesInFlight.has(targetCanonical)) {
    throw worktreeArchiveError('This worktree is already being archived', 'WORKTREE_ARCHIVE_IN_PROGRESS');
  }
  worktreeArchivesInFlight.add(targetCanonical);
  try {
    return await archiveRegisteredWorktree({ directory, id, worktreeDirectory, targetCanonical, context, input, options });
  } finally {
    worktreeArchivesInFlight.delete(targetCanonical);
  }
}

const findRegisteredWorktree = async (primaryWorktree: string, targetCanonical: string) => {
  const entries = await listWorktreeEntries(primaryWorktree);
  const registered = await Promise.all(entries.map(async (entry) => (entry?.worktree ? canonicalPath(entry.worktree) : null)));
  return entries[registered.indexOf(targetCanonical)] ?? null;
};

const archiveRegisteredWorktree = async ({ directory, id, worktreeDirectory, targetCanonical, context, input, options }: { directory: string; id: string; worktreeDirectory: string; targetCanonical: string; context: WorktreeProjectContext; input: WorktreeArchiveInput; options: BootstrapOptions }) => {
  const entry = await findRegisteredWorktree(context.primaryWorktree, targetCanonical);
  if (!entry) throw new Error('Not a worktree of this repository');
  await waitForActiveWorktreeBootstrap(worktreeDirectory);
  const bootstrap = worktreeBootstrapState.get(await toCanonicalBootstrapStateKey(worktreeDirectory));
  if (bootstrap?.status === WORKTREE_BOOTSTRAP_FAILED && !bootstrap.hydration) {
    throw new Error('The worktree did not finish setting up, so it cannot be archived. Delete it instead.');
  }
  const branch = entry.branch ?? '';
  const title = (branch ? toTaskTitle(await readGitConfigValue(context.primaryWorktree, `branch.${branch}.description`)) : '')
    || toTaskTitle(z.string().catch('').parse(input?.title));
  const record = {
    path: worktreeDirectory,
    branch,
    title,
    archivedAt: Date.now(),
    sessionIds: sessionIdListSchema.parse(input?.sessionIds),
  };
  const ref = `${WORKTREE_ARCHIVE_REF_PREFIX}${id}`;
  const message = `${WORKTREE_ARCHIVE_SUBJECT}\n\n${JSON.stringify(record)}`;
  const folderGone = entry.prunable === true && !(await checkPathExists(worktreeDirectory));
  const snapshot = folderGone
    ? await commitSnapshot(context.primaryWorktree, {
      ref,
      message,
      oldValue: '',
      head: entry.head ?? '',
      tree: (await runGitCommandOrThrow(context.primaryWorktree, ['rev-parse', `${entry.head}^{tree}`], 'Failed to read the worktree head')).stdout.trim(),
    })
    : await writeWorktreeSnapshot(worktreeDirectory, { ref, message, oldValue: '' });
  try {
    await removeWorktree(directory, {
      directory: worktreeDirectory,
      deleteLocalBranch: false,
      disposeInstance: input?.disposeInstance,
    }, options);
  } catch (error) {
    const snapshotTree = (await runGitCommand(context.primaryWorktree, ['rev-parse', `${snapshot.commit}^{tree}`])).stdout?.trim();
    const intact = await checkPathExists(worktreeDirectory)
      && await findRegisteredWorktree(context.primaryWorktree, targetCanonical)
      && (await readWorktreeStateTree(worktreeDirectory).catch(() => null))?.tree === snapshotTree;
    if (intact) {
      await runGitCommand(context.primaryWorktree, ['update-ref', '-d', ref, snapshot.commit]);
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw worktreeArchiveError(
      reason === WORKTREE_BUSY_MESSAGE
        ? `The worktree folder could not be removed completely (${reason}). It is archived; restore it once nothing holds the folder.`
        : `The worktree is archived, but its folder ${worktreeDirectory} could not be deleted completely: ${reason}`,
      'WORKTREE_ARCHIVE_PARTIAL',
    );
  }
  return { id, ref, commit: snapshot.commit, head: snapshot.head, ...record, branchExists: Boolean(branch) };
};

export async function restoreWorktreeArchive(directory: string, input: { id?: unknown } = {}) {
  const worktreeDirectory = normalizeDirectoryPath(directory);
  if (!worktreeDirectory) throw new Error('Worktree directory is required');
  const context = await resolveWorktreeProjectContext(worktreeDirectory, { tolerateWorktreeRootConfigError: true });
  const archive = await readWorktreeArchive(context.primaryWorktree, input?.id);
  await waitForActiveWorktreeBootstrap(worktreeDirectory);
  const bootstrap = worktreeBootstrapState.get(await toCanonicalBootstrapStateKey(worktreeDirectory));
  if (bootstrap?.status === WORKTREE_BOOTSTRAP_FAILED) {
    throw new Error('The worktree did not finish setting up, so its archived changes were not applied. The archive is kept.');
  }

  const trees = await runGitCommandOrThrow(worktreeDirectory, ['rev-parse', `${archive.commit}^{tree}`, `${archive.head}^{tree}`], 'Failed to read the worktree archive');
  const [snapshotTree, headTree] = String(trees.stdout || '').trim().split('\n');
  let conflicts = false;
  if (snapshotTree !== headTree) {
    const env = { ...(await buildGitEnv(worktreeDirectory)), ...SNAPSHOT_IDENTITY_ENV };
    const applied = await runGitCommand(worktreeDirectory, ['cherry-pick', '--no-commit', archive.commit], { env });
    if (applied.success) {
      await runGitCommandOrThrow(worktreeDirectory, ['reset', '--quiet'], 'Failed to unstage the restored changes');
    } else {
      const unmerged = await runGitCommand(worktreeDirectory, ['ls-files', '--unmerged']);
      if (!unmerged.success || !String(unmerged.stdout || '').trim()) {
        throw worktreeArchiveError(
          `The archived changes could not be applied (${applied.message || 'git refused'}). The archive is kept.`,
          'WORKTREE_ARCHIVE_NOT_APPLIED',
        );
      }
      conflicts = true;
    }
  }
  await runGitCommand(context.primaryWorktree, ['update-ref', '-d', archive.ref, archive.commit]);
  await publishWorktreeTopologyChange(context.primaryWorktree);
  return { id: archive.id, conflicts };
}

export async function deleteWorktreeArchive(directory: string, input: { id?: unknown; deleteBranch?: boolean } = {}) {
  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  const archive = await readWorktreeArchive(context.primaryWorktree, input?.id);
  await runGitCommandOrThrow(context.primaryWorktree, ['update-ref', '-d', archive.ref, archive.commit], 'Failed to delete the worktree archive');
  let branchDeleted = false;
  if (input?.deleteBranch === true && archive.branchExists) {
    const checkedOut = (await listWorktreeEntries(context.primaryWorktree))
      .some((entry) => cleanBranchName(String(entry.branchRef || entry.branch || '').trim()) === archive.branch);
    if (!checkedOut) {
      const removed = await runGitCommand(context.primaryWorktree, ['branch', '-D', archive.branch]);
      branchDeleted = removed.success;
    }
  }
  return { id: archive.id, branchDeleted };
}

export async function deleteBranch(directory: string, branch: string, options: { ifExists?: boolean; force?: unknown } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const branchName = branch.startsWith('refs/heads/')
      ? branch.substring('refs/heads/'.length)
      : branch;
    if (options.ifExists) {
      const found = await runGitCommand(directory, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], { timeoutMs: GIT_PROBE_TIMEOUT_MS });
      if (!found.success) {
        if (found.exitCode === 1 && !found.stderr.trim()) return { success: true };
        throw new Error(found.message || 'Failed to check branch before deletion');
      }
    }
    const args = ['branch', options.force ? '-D' : '-d', branchName];
    await git.raw(args);
    return { success: true };
  } catch (error) {
    console.error('Failed to delete branch:', error);
    throw error;
  }
}

export async function resolveBaseRefForLog(from: string | undefined, checkRef: (ref: string) => Promise<boolean>) {
  const normalized = isPrimitiveString(from) ? from.trim() : undefined;
  if (!normalized) return undefined;

  if (await checkRef(normalized)) return normalized;

  const originRef = `refs/remotes/origin/${normalized}`;
  if (await checkRef(originRef)) return `origin/${normalized}`;

  return normalized;
}

export async function getLog(directory: string, options: LogOptions = {}) {
  const { directoryPath, directoryGit, repoRoot, git } = await createRepositoryGitContext(directory);

  try {
    const maxCount = options.maxCount || 50;

    if (options.all) {
      const logArgs = [
        'log',
        `--max-count=${maxCount}`,
        '--all',
        '--topo-order',
        '--date=iso',
        '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
        '--shortstat',
      ];

      const rawLog = await git.raw(logArgs);
      const records = rawLog
        .split('\x1e')
        .map((e) => e.trim())
        .filter(Boolean);

      const entries = [];
      for (const record of records) {
        const lines = record.split('\n').filter((l) => l.trim().length > 0);
        const header = lines.shift() || '';
        const [hash, parentsRaw, author_name, author_email, date, message, refsRaw] =
          header.split('\x1f');
        if (!hash) continue;

        const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
        const refs = refsRaw ? refsRaw.trim() : '';

        let filesChanged = 0;
        let insertions = 0;
        let deletions = 0;
        for (const line of lines) {
          const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
          const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
          const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);
          if (filesMatch) filesChanged = parseInt(filesMatch[1] ?? '', 10);
          if (insertMatch) insertions = parseInt(insertMatch[1] ?? '', 10);
          if (deleteMatch) deletions = parseInt(deleteMatch[1] ?? '', 10);
        }

        entries.push({
          hash,
          date: date || '',
          message: message || '',
          refs,
          body: '',
          author_name: author_name || '',
          author_email: author_email || '',
          filesChanged,
          insertions,
          deletions,
          parents,
        });
      }

      return { all: entries, latest: entries[0] || null, total: entries.length };
    }

    const filePath = options.file
      ? (await resolveGitFileContext(directoryPath, directoryGit, options.file, repoRoot)).repoPath
      : undefined;

    const checkRef = async (ref: string) => {
      try {
        const out = await git.raw(['rev-parse', '--verify', ref]);
        return Boolean(out && out.trim());
      } catch {
        return false;
      }
    };
    if (!options.to && !(await checkRef('HEAD'))) {
      const unborn = await git.raw(['symbolic-ref', '-q', 'HEAD']).then(() => true, () => false);
      if (unborn) return { all: [], latest: null, total: 0 };
    }

    const resolvedFrom = await resolveBaseRefForLog(options.from, checkRef);

    if (options.to) {
      const probe = await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${options.to}^{commit}`]);
      if (!probe.success && probe.exitCode === 1) {
        throw Object.assign(new Error(`Revision '${options.to}' not found`), { code: 'revision_not_found' });
      }
      if (!probe.success) throw new Error(probe.message || 'Failed to verify revision');
    }

    const baseLog = options.to && !resolvedFrom
      ? await git.log([`--max-count=${maxCount}`, options.to, ...(filePath ? ['--', filePath] : [])])
      : await git.log({ maxCount, from: resolvedFrom, to: options.to, file: filePath, symmetric: false });

    const logArgs = [
      'log',
      `--max-count=${maxCount}`,
      '--date=iso',
      '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s',
      '--shortstat'
    ];

    if (resolvedFrom && options.to) {
      logArgs.push(`${resolvedFrom}..${options.to}`);
    } else if (resolvedFrom) {
      logArgs.push(`${resolvedFrom}..HEAD`);
    } else if (options.to) {
      logArgs.push(options.to);
    }

    if (filePath) {
      logArgs.push('--', filePath);
    }

    const rawLog = await git.raw(logArgs);
    const records = rawLog
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const statsMap = new Map<string, DiffStats & { filesChanged: number; parents: string[] }>();

    records.forEach((record) => {
      const lines = record.split('\n').filter((line) => line.trim().length > 0);
      const header = lines.shift() || '';
      const [hash, parentsRaw] = header.split('\x1f');
      const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
      if (!hash) {
        return;
      }

      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;

      lines.forEach((line) => {
        const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
        const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
        const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);

        if (filesMatch) {
          filesChanged = parseInt(filesMatch[1] ?? '', 10);
        }
        if (insertMatch) {
          insertions = parseInt(insertMatch[1] ?? '', 10);
        }
        if (deleteMatch) {
          deletions = parseInt(deleteMatch[1] ?? '', 10);
        }
      });

      statsMap.set(hash, { filesChanged, insertions, deletions, parents });
    });

    const merged = baseLog.all.map((entry) => {
      const stats = statsMap.get(entry.hash) || { filesChanged: 0, insertions: 0, deletions: 0, parents: [] };
      return {
        hash: entry.hash,
        date: entry.date,
        message: entry.message,
        refs: entry.refs || '',
        body: entry.body || '',
        author_name: entry.author_name,
        author_email: entry.author_email,
        filesChanged: stats.filesChanged,
        insertions: stats.insertions,
        deletions: stats.deletions,
        parents: stats.parents || [],
      };
    });

    return {
      all: merged,
      latest: merged[0] || null,
      total: baseLog.total
    };
  } catch (error) {
    if (errorField(error, 'code') !== 'revision_not_found') console.error('Failed to get log:', error);
    throw error;
  }
}

export async function isLinkedWorktree(directory: string) {
  const git = await createGit(directory);
  try {
    const [gitDir, gitCommonDir] = await Promise.all([
      git.raw(['rev-parse', '--git-dir']).then((output) => output.trim()),
      git.raw(['rev-parse', '--git-common-dir']).then((output) => output.trim())
    ]);
    return gitDir !== gitCommonDir;
  } catch (error) {
    console.error('Failed to determine worktree type:', error);
    return false;
  }
}

export async function validateWorktreeDirectory(directory: string, worktreeRoot: string) {
  const directoryPath = normalizeDirectoryPath(directory);
  const rootPath = normalizeDirectoryPath(worktreeRoot);

  if (!directoryPath || !rootPath) {
    return {
      valid: false,
      insideWorktreeRoot: false,
      resolvedWorktreeRoot: null,
      resolvedCwd: null,
    };
  }

  const isRepo = await isGitRepository(directoryPath);
  if (!isRepo) {
    return {
      valid: false,
      insideWorktreeRoot: false,
      resolvedWorktreeRoot: null,
      resolvedCwd: null,
    };
  }

  const resolvedCwd = await canonicalPath(directoryPath);
  const resolvedRoot = await canonicalPath(rootPath);

  const inside = resolvedCwd.startsWith(resolvedRoot + path.sep) || resolvedCwd === resolvedRoot;

  return {
    valid: true,
    insideWorktreeRoot: inside,
    resolvedWorktreeRoot: resolvedRoot,
    resolvedCwd,
  };
}

export async function canonicalizeWorktreeState(directory: string) {
  const directoryPath = normalizeDirectoryPath(directory);

  if (!directoryPath) {
    return {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      legacy: false,
      degraded: false,
      attentionReason: null,
    };
  }

  const isRepo = await isGitRepository(directoryPath);
  if (!isRepo) {
    return {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      legacy: false,
      degraded: false,
      attentionReason: null,
    };
  }

  const cwd = await canonicalPath(directoryPath);
  const git = await createGit(directoryPath);
  const repoRoot = await resolveGitRepositoryRoot(directoryPath, git).catch(() => directoryPath);

  let worktreeRoot = null;
  let worktreeStatus = 'ready';
  let headState: 'branch' | 'detached' | 'unborn' = 'branch';
  let branch = null;
  let attentionReason: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null = null;

  try {
    const context = await resolveWorktreeProjectContext(directoryPath, { tolerateWorktreeRootConfigError: true });
    worktreeRoot = await canonicalPath(context.worktreeRoot);
  } catch {
    worktreeStatus = 'invalid';
  }

  try {
    const symbolicRef = await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    if (symbolicRef.trim()) {
      headState = 'branch';
      branch = cleanBranchName(symbolicRef.trim());
    } else {
      const revParse = await git.raw(['rev-parse', 'HEAD']).catch(() => '');
      if (!revParse.trim()) {
        headState = 'unborn';
        branch = null;
      } else {
        headState = 'detached';
        branch = revParse.trim().slice(0, 7);
      }
    }
  } catch {
    headState = 'unborn';
    branch = null;
  }

  try {
    const status = await git.status(['-unormal']);
    if (status.current && (await git.raw(['rev-parse', '--verify', 'MERGE_HEAD']).then(() => true).catch(() => false))) {
      attentionReason = 'merge';
    } else {
      const rebaseMergePath = await resolveGitInternalPath(repoRoot, git, 'rebase-merge').catch(() => '');
      const rebaseApplyPath = await resolveGitInternalPath(repoRoot, git, 'rebase-apply').catch(() => '');
      const rebaseMerge = rebaseMergePath ? await fsp.stat(rebaseMergePath).then(() => true).catch(() => false) : false;
      const rebaseApply = rebaseApplyPath ? await fsp.stat(rebaseApplyPath).then(() => true).catch(() => false) : false;
      if (rebaseMerge || rebaseApply) {
        attentionReason = 'rebase';
      } else if (status.conflicted && status.conflicted.length > 0) {
        const cherryPickHeadPath = await resolveGitInternalPath(repoRoot, git, 'CHERRY_PICK_HEAD').catch(() => '');
        const revertHeadPath = await resolveGitInternalPath(repoRoot, git, 'REVERT_HEAD').catch(() => '');
        const cherryPickHead = cherryPickHeadPath ? await fsp.stat(cherryPickHeadPath).then(() => true).catch(() => false) : false;
        const revertHead = revertHeadPath ? await fsp.stat(revertHeadPath).then(() => true).catch(() => false) : false;
        if (cherryPickHead) attentionReason = 'cherry-pick';
        else if (revertHead) attentionReason = 'revert';
      }
    }
  } catch {
    void 0;
  }

  return {
    worktreeRoot,
    cwd,
    branch,
    headState,
    worktreeStatus,
    legacy: false,
    degraded: false,
    attentionReason,
  };
}

async function resolveCommitHash(git: SimpleGit, hash: CommitDiffOptions['hash']) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(hash))) throw new Error('A commit hash is required');
  return (await git.raw(['rev-parse', '--verify', '--end-of-options', `${hash}^{commit}`])).trim();
}

const commitShowArgs = (hash: string) => ['show', '--format=', '--root', '--diff-merges=first-parent', '--find-renames', hash];

export async function getCommitDiff(directory: string, { hash, path: filePath, previousPath, contextLines = 3 }: CommitDiffOptions = {}) {
  const { git } = await createRepositoryGitContext(directory);
  const commit = await resolveCommitHash(git, hash);
  const paths = [filePath, previousPath].filter(Boolean).map((value) => `:(literal)${value}`);
  return git.raw([
    ...commitShowArgs(commit), '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `-U${Math.max(0, contextLines)}`,
    '--', ...paths,
  ]);
}

export async function getCommitFiles<Hash>(directory: string, commitHash: Hash) {
  const { git } = await createRepositoryGitContext(directory);
  const hash = await resolveCommitHash(git, commitHash);
  const [numstat, nameStatus] = await Promise.all([
    git.raw([...commitShowArgs(hash), '--numstat', '-z', '--']),
    git.raw([...commitShowArgs(hash), '--name-status', '-z', '--']),
  ]);
  const stats = new Map<string | undefined, DiffStats & { isBinary: boolean }>();
  const tokens = numstat.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(String(tokens[index]));
    if (!match) continue;
    let destination = match[3];
    if (!destination) {
      destination = tokens[index + 2];
      index += 2;
    }
    stats.set(destination, {
      insertions: Number.parseInt(match[1] ?? '', 10) || 0,
      deletions: Number.parseInt(match[2] ?? '', 10) || 0,
      isBinary: match[1] === '-',
    });
  }
  const files = [];
  const names = nameStatus.split('\0');
  for (let index = 0; index < names.length; index += 1) {
    const changeType = names[index]?.charAt(0);
    if (!changeType) continue;
    const renamed = changeType === 'R' || changeType === 'C';
    const previousPath = renamed ? names[++index] : undefined;
    const filePath = names[++index];
    const fileStats = stats.get(filePath);
    if (!filePath || !fileStats) throw new Error('Incomplete commit file statistics');
    const entry: CommitFile = { path: filePath, ...fileStats, changeType };
    if (previousPath) entry.previousPath = previousPath;
    files.push(entry);
  }
  return { files };
}

export async function renameBranch(directory: string, oldName: string, newName: string) {
  const { git, repoRoot } = await createRepositoryGitContext(directory);

  try {
    const normalizedOldName = cleanBranchName(String(oldName || '').trim());
    const normalizedNewName = cleanBranchName(String(newName || '').trim());

    const previousRemote = await git
      .raw(['config', '--get', `branch.${normalizedOldName}.remote`])
      .then((value) => String(value || '').trim())
      .catch(() => '');
    const previousMerge = await git
      .raw(['config', '--get', `branch.${normalizedOldName}.merge`])
      .then((value) => String(value || '').trim())
      .catch(() => '');

    const worktrees = await listWorktreeEntries(repoRoot);
    const takenBy = worktrees.find((entry) => entry.branch === normalizedNewName);
    if (takenBy) {
      const error: Error & { statusCode?: number } = new Error(`Branch ${normalizedNewName} is already checked out in ${takenBy.worktree}`);
      error.statusCode = 409;
      throw error;
    }
    const existing = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${normalizedNewName}`]);
    if (existing.success) {
      const error: Error & { statusCode?: number } = new Error(`A branch named ${normalizedNewName} already exists`);
      error.statusCode = 409;
      throw error;
    }

    await git.raw(['branch', '-m', oldName, newName]);

    if (worktrees.some((entry) => entry.branch === normalizedOldName)) {
      await publishWorktreeTopologyChange(repoRoot);
    }

    if (previousRemote && previousMerge && normalizedNewName) {
      const previousMergeBranch = cleanBranchName(previousMerge);
      const nextMergeBranch =
        previousMergeBranch === normalizedOldName
          ? normalizedNewName
          : previousMergeBranch;
      const upstream = normalizeUpstreamTarget(previousRemote, nextMergeBranch);

      if (upstream) {
        try {
          await runGitCommandOrThrow(
            repoRoot,
            ['branch', `--set-upstream-to=${upstream.full}`, normalizedNewName],
            `Failed to set upstream to ${upstream.full}`
          );
        } catch {
          void 0;
        }
      }
    }

    return { success: true, branch: newName };
  } catch (error) {
    if (errorField(error, 'statusCode') !== 409) console.error('Failed to rename branch:', error);
    throw error;
  }
}

export async function getRemotes(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const remotes = await git.getRemotes(true);
    
    return remotes.map((remote) => ({
      name: remote.name,
      fetchUrl: remote.refs.fetch,
      pushUrl: remote.refs.push
    }));
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      await assertRepositoryReachable(directory);
      return [];
    }
    console.error('Failed to get remotes:', error);
    throw error;
  }
}

export async function removeRemote(directory: string, options: { remote?: string } = {}) {
  const remoteName = String(options.remote || '').trim();
  if (!remoteName) {
    throw new Error('remote is required to remove a remote');
  }
  if (remoteName === 'origin') {
    throw new Error('Cannot remove origin remote');
  }

  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.raw(['remote', 'remove', '--', remoteName]);
    return { success: true };
  } catch (error) {
    console.error('Failed to remove remote:', error);
    throw error;
  }
}

async function readRebaseParent(git: SimpleGit, repoRoot: string, onto: string) {
  const branch = await localBranchNameOf(repoRoot, 'HEAD');
  if (!branch) return null;
  const fullName = String(await git.raw(['rev-parse', '--symbolic-full-name', onto])).trim();
  if (fullName.startsWith('refs/heads/')) return { branch, parent: fullName.slice('refs/heads/'.length) };
  if (!fullName.startsWith('refs/remotes/') || await isOwnRemoteCopy(git, fullName, branch)) return null;
  const remoteRef = fullName.slice('refs/remotes/'.length);
  const remotes = String(await git.raw(['remote'])).split('\n').map((name) => name.trim()).filter(Boolean);
  const remote = remotes.filter((name) => remoteRef.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? { branch, parent: remoteRef.slice(remote.length + 1) } : null;
}

const REBASE_PARENT_FILE = 'openchamber-parent.json';

async function rebaseStateDirectory(git: SimpleGit, repoRoot: string) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const directory = await resolveGitInternalPath(repoRoot, git, name).catch(() => null);
    if (directory && await fsp.stat(directory).then(() => true, () => false)) return directory;
  }
  return null;
}

export async function rebase(directory: string, options: { onto?: string } = {}) {
  const { git, repoRoot } = await createRepositoryGitContext(directory);
  const { onto } = options;
  const parentRecord = onto ? await readRebaseParent(git, repoRoot, onto).catch(() => null) : null;

  try {
    if (!onto) {
      throw new Error('onto parameter is required for rebase');
    }

    await git.rebase([onto]);
    if (parentRecord) await recordBranchParent(repoRoot, parentRecord.branch, parentRecord.parent);

    return {
      success: true,
      conflict: false
    };
  } catch (error) {
    const errorMessage = String(errorField(error, 'message') || error || '').toLowerCase();
    const isConflict = errorMessage.includes('conflict') || 
                       errorMessage.includes('could not apply') ||
                       errorMessage.includes('merge conflict');

    if (isConflict) {
      const stateDirectory = parentRecord ? await rebaseStateDirectory(git, repoRoot) : null;
      if (stateDirectory) {
        await fsp.writeFile(path.join(stateDirectory, REBASE_PARENT_FILE), JSON.stringify(parentRecord)).catch(() => {});
      }
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    console.error('Failed to rebase:', error);
    throw error;
  }
}

export async function abortRebase(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.rebase(['--abort']);
    return { success: true };
  } catch (error) {
    console.error('Failed to abort rebase:', error);
    throw error;
  }
}

export async function merge(directory: string, options: { branch?: string } = {}) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const { branch } = options;
    if (!branch) {
      throw new Error('branch parameter is required for merge');
    }

    await git.merge([branch]);

    return {
      success: true,
      conflict: false
    };
  } catch (error) {
    const errorMessage = String(errorField(error, 'message') || error || '').toLowerCase();
    const isConflict = errorMessage.includes('conflict') || 
                       errorMessage.includes('merge conflict') ||
                       errorMessage.includes('automatic merge failed');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    console.error('Failed to merge:', error);
    throw error;
  }
}

export async function abortMerge(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    await git.merge(['--abort']);
    return { success: true };
  } catch (error) {
    console.error('Failed to abort merge:', error);
    throw error;
  }
}

export async function continueRebase(directory: string) {
  const { git, repoRoot } = await createRepositoryGitContext(directory);
  const stateDirectory = await rebaseStateDirectory(git, repoRoot);
  const pending: unknown = stateDirectory
    ? await fsp.readFile(path.join(stateDirectory, REBASE_PARENT_FILE), 'utf8').then(JSON.parse).catch(() => null)
    : null;
  const result = await continueRebaseSteps(git, repoRoot);
  if (result.success && errorField(pending, 'branch') && errorField(pending, 'parent') && !(await rebaseStateDirectory(git, repoRoot))) {
    await recordBranchParent(repoRoot, String(errorField(pending, 'branch')), String(errorField(pending, 'parent')));
  }
  return result;
}

async function continueRebaseSteps(git: SimpleGit, repoRoot: string) {
  try {
    await runGitCommandWithoutEditor(repoRoot, ['rebase', '--continue']);
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = String(errorField(error, 'message') || error || '').toLowerCase();

    if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes')) {
      try {
        await runGitCommandWithoutEditor(repoRoot, ['rebase', '--skip']);
        return { success: true, conflict: false };
      } catch {
        const status = await git.status().catch(() => ({ conflicted: [] }));
        if (status.conflicted && status.conflicted.length > 0) {
          return {
            success: false,
            conflict: true,
            conflictFiles: status.conflicted
          };
        }
        return { success: true, conflict: false };
      }
    }

    const isConflict = errorMessage.includes('conflict') ||
                       errorMessage.includes('needs merge') ||
                       errorMessage.includes('unmerged') ||
                       errorMessage.includes('fix conflicts');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    console.error('Failed to continue rebase:', error);
    throw error;
  }
}

export async function continueMerge(directory: string) {
  const { git } = await createRepositoryGitContext(directory);

  try {
    const status = await git.status();
    if (status.conflicted && status.conflicted.length > 0) {
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted
      };
    }

    await git.commit([], { '--no-edit': null });
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = String(errorField(error, 'message') || error || '').toLowerCase();
    const isConflict = errorMessage.includes('conflict') ||
                       errorMessage.includes('needs merge') ||
                       errorMessage.includes('unmerged') ||
                       errorMessage.includes('fix conflicts');

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes added')) {
      return { success: true, conflict: false };
    }

    console.error('Failed to continue merge:', error);
    throw error;
  }
}

export async function getConflictDetails(directory: string) {
  const { repoRoot, git } = await createRepositoryGitContext(directory);

  try {
    const statusPorcelain = await git.raw(['status', '--porcelain']).catch(() => '');

    const unmergedFilesRaw = await git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    const unmergedFiles = unmergedFilesRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const diff = await git.raw(['diff', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']).catch(() => '');

    let operation = 'merge';
    let headInfo = '';

    const mergeHead = (await git.raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')).trim();

    if (mergeHead) {
      operation = 'merge';
      const mergeMsgPath = await resolveGitInternalPath(repoRoot, git, 'MERGE_MSG').catch(() => '');
      const mergeMsg = mergeMsgPath ? await fsp.readFile(mergeMsgPath, 'utf8').catch(() => '') : '';
      headInfo = `MERGE_HEAD: ${mergeHead}\n${mergeMsg}`;
    } else {
      const rebaseHead = (await git.raw(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD']).catch(() => '')).trim();

      if (rebaseHead) {
        operation = 'rebase';
        headInfo = `REBASE_HEAD: ${rebaseHead}`;
      }
    }

    return {
      statusPorcelain: statusPorcelain.trim(),
      unmergedFiles,
      diff: diff.trim(),
      headInfo: headInfo.trim(),
      operation,
    };
  } catch (error) {
    console.error('Failed to get conflict details:', error);
    throw error;
  }
}

export async function getCommitFileDiff(directory: string, hash: string, filePath: string, isBinary: boolean, previousPath?: string) {
  if (!directory || !hash || !filePath) {
    throw new Error('directory, hash, and path are required for getCommitFileDiff');
  }

  const isDocument = isOfficeDocument(filePath);
  if (isBinary && !isDocument) {
    return { original: '', modified: '', isBinary: true };
  }

  const { directoryPath, repoRoot } = await createRepositoryGitContext(directory);
  const candidates = Array.from(new Set([
    toGitPath(path.relative(repoRoot, path.resolve(repoRoot, filePath))),
    toGitPath(path.relative(repoRoot, path.resolve(directoryPath, filePath))),
  ])).filter((candidate) => candidate && !candidate.startsWith('..') && !path.isAbsolute(candidate));

  if (isDocument) {
    const readRevision = async (revision: string, candidate: string) => {
      try {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', `${revision}:${candidate}`], {
          cwd: repoRoot,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024,
        });
        return stdout.length > 0 ? `data:application/octet-stream;base64,${stdout.toString('base64')}` : '';
      } catch {
        return '';
      }
    };
    for (const candidate of candidates) {
      const parentPath = previousPath ? toGitPath(path.relative(repoRoot, path.resolve(path.dirname(path.resolve(repoRoot, candidate)), path.relative(path.dirname(filePath), previousPath)))) : candidate;
      const [original, modified] = await Promise.all([readRevision(`${hash}^`, parentPath), readRevision(hash, candidate)]);
      if (modified || (original && !previousPath)) return { original, modified, isBinary: false };
    }
    return { original: '', modified: '', isBinary: true };
  }

  let originalResult = null;
  let modifiedResult = null;

  for (const candidate of candidates) {
    const [candidateOriginalResult, candidateModifiedResult] = await Promise.all([
      runGitCommand(repoRoot, ['show', `${hash}^:${candidate}`]),
      runGitCommand(repoRoot, ['show', `${hash}:${candidate}`]),
    ]);

    if (candidateOriginalResult.success || candidateModifiedResult.success) {
      originalResult = candidateOriginalResult;
      modifiedResult = candidateModifiedResult;
      break;
    }
  }

  if (!originalResult || !modifiedResult) {
    const resolvedPath = await resolveGitCommitFilePath(repoRoot, hash, candidates);
    [originalResult, modifiedResult] = await Promise.all([
      runGitCommand(repoRoot, ['show', `${hash}^:${resolvedPath}`]),
      runGitCommand(repoRoot, ['show', `${hash}:${resolvedPath}`]),
    ]);
  }

  const original = originalResult.success ? originalResult.stdout : '';
  const modified = modifiedResult.success ? modifiedResult.stdout : '';

  if (!originalResult.success && !modifiedResult.success) {
    throw new Error(`Failed to read file content at commit ${hash}: ${originalResult.stderr || modifiedResult.stderr}`);
  }

  return { original, modified, isBinary: false };
}
