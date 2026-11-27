
import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { execGit as executeGit } from './bridge-git-process-runtime';
import { readWorktreeDirectorySetting } from '../../web/server/lib/opencode/config-files.js';
import { listWorktreeRows } from './gitWorktreeRows';
import { createWorktreeRegistry } from '../../web/server/lib/git/worktree-registry.js';
import { directoryReachability } from '../../web/server/lib/directory-reachability/index.js';
import { assertPathReachable, directoryExists, realpathOf } from '../../web/server/lib/git/reachable-disk.js';
import { isContributorForkGitDirectory } from '../../web/server/lib/git/contributor-provenance-storage.js';
import { readProjectStartCommand } from '../../web/server/lib/opencode/project-start-command.js';
import { readSubmoduleState, resolveGitPathTarget, type GitPathUnavailable, type GitSubmoduleState } from './gitPathDiff';
import { parseGitRemoteListing, type GitRemote } from './gitRemoteListing';
import { recordWorktreeBranchParent } from './worktreeBranchParent';
import {
  parseRawBranchListing,
  parseRemoteDefaultBranches,
  RAW_BRANCH_LISTING_ARGS,
  REMOTE_DEFAULT_BRANCHES_ARGS,
  type GitBranchDetails,
} from './gitBranchListing';
import type { API as GitAPI, Change, Repository, GitExtension, Status } from './git.d';

let gitApi: GitAPI | null = null;
let gitExtensionEnabled = false;

type WorktreeBootstrapStatus = {
  status: 'pending' | 'ready' | 'failed';
  phase: 'directory-created' | 'git-ready' | 'setup-ready';
  error: string | null;
  errorCode?: 'BRANCH_NAME_CONFLICT';
  updatedAt: number;
};

const BRANCH_NAME_CONFLICT_MESSAGE = 'Git could not create the worktree branch: its name clashes with an existing branch (the same name, or one nested inside the other). Rename the branch and create the worktree again.';

const worktreeBootstrapState = new Map<string, WorktreeBootstrapStatus>();
const activeWorktreeBootstrapTasks = new Map<string, Promise<unknown>>();

const WORKTREE_BOOTSTRAP_PENDING = 'pending' as const;
const WORKTREE_BOOTSTRAP_READY = 'ready' as const;
const WORKTREE_BOOTSTRAP_FAILED = 'failed' as const;
const WORKTREE_PHASE_DIRECTORY_CREATED = 'directory-created' as const;
const WORKTREE_PHASE_GIT_READY = 'git-ready' as const;
const WORKTREE_PHASE_SETUP_READY = 'setup-ready' as const;
const WORKTREE_INDEX_LOCK_RETRY_DELAY_MS = 250;
const WORKTREE_INDEX_LOCK_STALE_DELAY_MS = 750;
const GIT_NULL_REF = '0'.repeat(40);

const toBootstrapStateKey = (directory: string): string => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

const setWorktreeBootstrapState = (
  directory: string,
  status: WorktreeBootstrapStatus['status'],
  phase: WorktreeBootstrapStatus['phase'],
  error: string | null = null,
): WorktreeBootstrapStatus | null => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return null;
  }

  const state: WorktreeBootstrapStatus = {
    status,
    phase,
    error: typeof error === 'string' && error.trim().length > 0 ? error.trim() : null,
    updatedAt: Date.now(),
  };
  worktreeBootstrapState.set(key, state);
  return state;
};

const setWorktreeBootstrapFailure = (directory: string, error: unknown): void => {
  const current = worktreeBootstrapState.get(toBootstrapStateKey(directory));
  const branchNameConflict = error instanceof Error && 'code' in error && error.code === 'BRANCH_NAME_CONFLICT';
  const failed = setWorktreeBootstrapState(
    directory,
    WORKTREE_BOOTSTRAP_FAILED,
    current?.phase ?? WORKTREE_PHASE_DIRECTORY_CREATED,
    branchNameConflict
      ? BRANCH_NAME_CONFLICT_MESSAGE
      : error instanceof Error ? error.message : String(error),
  );
  if (failed && branchNameConflict) failed.errorCode = 'BRANCH_NAME_CONFLICT';
};

const clearWorktreeBootstrapState = (directory: string): void => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }
  worktreeBootstrapState.delete(key);
};

const trackWorktreeBootstrapTask = (directory: string, task: Promise<unknown>): void => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }

  activeWorktreeBootstrapTasks.set(key, task);
  const clearTask = () => {
    if (activeWorktreeBootstrapTasks.get(key) === task) {
      activeWorktreeBootstrapTasks.delete(key);
    }
  };
  void task.then(clearTask, clearTask);
};

const waitForActiveWorktreeBootstrap = async (directory: string): Promise<void> => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }

  while (true) {
    const task = activeWorktreeBootstrapTasks.get(key);
    if (!task) {
      return;
    }
    await task.catch(() => undefined);
  }
};

const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];

async function isSocketPath(candidate: string): Promise<boolean> {
  if (!candidate) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(candidate);
    return typeof stat.isSocket === 'function' && stat.isSocket();
  } catch {
    return false;
  }
}

async function resolveSshAuthSock(): Promise<string | undefined> {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return undefined;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const runGpgconf = async (args: string[]): Promise<string> => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args);
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
  }

  return undefined;
}

async function buildGitEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  return env;
}

async function initGitExtension(): Promise<GitAPI | null> {
  if (gitApi && gitExtensionEnabled) {
    return gitApi;
  }

  try {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) {
      console.warn('[GitService] Git extension not found');
      return null;
    }

    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }

    const extension = gitExtension.exports;
    if (!extension.enabled) {
      console.warn('[GitService] Git extension is disabled');
      return null;
    }

    gitApi = extension.getAPI(1);
    gitExtensionEnabled = true;

    extension.onDidChangeEnablement((enabled) => {
      gitExtensionEnabled = enabled;
      if (!enabled) {
        gitApi = null;
      }
    });

    return gitApi;
  } catch (error) {
    console.error('[GitService] Failed to initialize git extension:', error);
    return null;
  }
}

async function getGitApi(): Promise<GitAPI | null> {
  if (gitApi && gitExtensionEnabled) {
    return gitApi;
  }
  return initGitExtension();
}

async function getRepository(directory: string): Promise<Repository | null> {
  const api = await getGitApi();
  if (!api) return null;

  const normalizedDir = normalizePath(directory);
  const uri = vscode.Uri.file(normalizedDir);

  let repo = api.getRepository(uri);
  if (repo) return repo;

  repo = await api.openRepository(uri);
  return repo;
}

function normalizePath(p: string): string {
  let normalized = p;
  if (normalized.startsWith('~')) {
    normalized = path.join(os.homedir(), normalized.slice(1));
  }
  normalized = normalized.replace(/\\/g, '/');
  return normalized;
}

function normalizeDirectoryPath(value: string): string {
  if (typeof value !== 'string') {
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
}

function cleanBranchName(branch: string): string {
  if (!branch) {
    return branch;
  }
  if (branch.startsWith('refs/heads/')) {
    return branch.substring('refs/heads/'.length);
  }
  if (branch.startsWith('heads/')) {
    return branch.substring('heads/'.length);
  }
  if (branch.startsWith('refs/')) {
    return branch.substring('refs/'.length);
  }
  return branch;
}

async function execGit(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return executeGit(args, normalizePath(cwd), { binary: gitApi?.git.path || 'git', env });
}


const GIT_PROBE_TIMEOUT_MS = 30_000;

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  if (!fs.existsSync(normalizePath(directory))) return false;
  const result = await executeGit(['rev-parse', '--is-inside-work-tree', '--is-bare-repository'], normalizePath(directory), {
    binary: gitApi?.git.path || 'git',
    timeoutMs: GIT_PROBE_TIMEOUT_MS,
    env: { LC_ALL: 'C' },
  });
  if (result.exitCode !== 0) {
    if (result.exitCode === 128 && /^fatal: not a git repository\b/i.test(result.stderr.trim())) return false;
    throw Object.assign(new Error(result.stderr.trim() || 'Git could not read this directory.'), { code: 'GIT_REPOSITORY_UNREADABLE' });
  }
  const [insideWorkTree, bare] = result.stdout.split('\n').map((line) => line.trim());
  return insideWorkTree === 'true' || bare === 'true';
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  const gitDir = await execGit(['rev-parse', '--git-dir'], directory);
  const commonDir = await execGit(['rev-parse', '--git-common-dir'], directory);
  
  if (gitDir.exitCode !== 0 || commonDir.exitCode !== 0) {
    return false;
  }
  
  const gitDirPath = path.resolve(directory, gitDir.stdout.trim());
  const commonDirPath = path.resolve(directory, commonDir.stdout.trim());
  
  return gitDirPath !== commonDirPath;
}


interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
  previousPath?: string;
}

interface GitMergeInProgress {
  head: string;
  message: string;
}

interface GitRebaseInProgress {
  headName: string;
  onto: string;
}

export interface GitStatusResult {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitStatusFile[];
  isClean: boolean;
  diffStats?: {
    staged: Record<string, { insertions: number; deletions: number }>;
    working: Record<string, { insertions: number; deletions: number }>;
  };
  mergeInProgress?: GitMergeInProgress | null;
  rebaseInProgress?: GitRebaseInProgress | null;
}

type GitStatusOptions = {
  mode?: 'light';
};

function mapStatus(status: Status): string {
  const statusMap: Record<number, string> = {
    0: 'M',
    1: 'A',
    2: 'D',
    3: 'R',
    4: 'C',
    5: 'M',
    6: 'D',
    7: '?',
    8: '!',
    9: 'A',
    10: 'R',
    11: 'T',
    12: 'U',
    13: 'U',
    14: 'U',
    15: 'U',
    16: 'U',
    17: 'U',
    18: 'U',
  };
  return statusMap[status] || ' ';
}

function getRepositoryRelativePath(repo: Repository, uri: vscode.Uri): string {
  return path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

export async function getGitStatus(directory: string, options?: GitStatusOptions): Promise<GitStatusResult> {
  void options;
  const repo = await getRepository(directory);
  
  if (!repo) {
    return getGitStatusRaw(directory);
  }

  const state = repo.state;
  const head = state.HEAD;
  
  const files: GitStatusFile[] = [];
  const previousPathOf = (change: Change, relativePath: string) => {
    const previousPath = getRepositoryRelativePath(repo, change.originalUri);
    return previousPath !== relativePath ? previousPath : undefined;
  };
  
  for (const change of state.indexChanges) {
    const relativePath = getRepositoryRelativePath(repo, change.uri);
    files.push({
      path: relativePath,
      index: mapStatus(change.status),
      working_dir: ' ',
      previousPath: previousPathOf(change, relativePath),
    });
  }
  
  for (const change of state.workingTreeChanges) {
    const relativePath = getRepositoryRelativePath(repo, change.uri);
    const existing = files.find(f => f.path === relativePath);
    if (existing) {
      existing.working_dir = mapStatus(change.status);
      existing.previousPath ??= previousPathOf(change, relativePath);
    } else {
      files.push({
        path: relativePath,
        index: ' ',
        working_dir: mapStatus(change.status),
        previousPath: previousPathOf(change, relativePath),
      });
    }
  }

  const inProgressState = await checkInProgressOperations(directory);

  return {
    current: head?.name || '',
    tracking: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : null,
    ahead: head?.ahead || 0,
    behind: head?.behind || 0,
    files,
    isClean: files.length === 0,
    ...inProgressState,
  };
}

async function checkInProgressOperations(directory: string): Promise<{
  mergeInProgress?: GitMergeInProgress | null;
  rebaseInProgress?: GitRebaseInProgress | null;
}> {
  const result: {
    mergeInProgress?: GitMergeInProgress | null;
    rebaseInProgress?: GitRebaseInProgress | null;
  } = {};

  const gitDir = path.join(directory, '.git');

  try {
    const mergeHeadPath = path.join(gitDir, 'MERGE_HEAD');
    const mergeHeadExists = await fs.promises.stat(mergeHeadPath).then(() => true).catch(() => false);
    
    if (mergeHeadExists) {
      const mergeHead = await fs.promises.readFile(mergeHeadPath, 'utf8').catch(() => '');
      const headSha = mergeHead.trim().slice(0, 7);
      if (headSha) {
        const mergeMsg = await fs.promises.readFile(path.join(gitDir, 'MERGE_MSG'), 'utf8').catch(() => '');
        result.mergeInProgress = {
          head: headSha,
          message: mergeMsg.split('\n')[0] || '',
        };
      }
    }
  } catch {
    // ignore
  }

  try {
    const rebaseMergeExists = await fs.promises.stat(path.join(gitDir, 'rebase-merge')).then(() => true).catch(() => false);
    const rebaseApplyExists = await fs.promises.stat(path.join(gitDir, 'rebase-apply')).then(() => true).catch(() => false);
    
    if (rebaseMergeExists || rebaseApplyExists) {
      const rebaseDir = rebaseMergeExists ? 'rebase-merge' : 'rebase-apply';
      const headName = await fs.promises.readFile(path.join(gitDir, rebaseDir, 'head-name'), 'utf8').catch(() => '');
      const onto = await fs.promises.readFile(path.join(gitDir, rebaseDir, 'onto'), 'utf8').catch(() => '');
      
      const headNameTrimmed = headName.trim().replace('refs/heads/', '');
      const ontoTrimmed = onto.trim().slice(0, 7);
      
      if (headNameTrimmed || ontoTrimmed) {
        result.rebaseInProgress = {
          headName: headNameTrimmed,
          onto: ontoTrimmed,
        };
      }
    }
  } catch {
    // ignore
  }

  return result;
}

async function getGitStatusRaw(directory: string): Promise<GitStatusResult> {
  // external: #2229 Optional status index refreshes hold index.lock and can block a terminal commit.
  const statusResult = await execGit(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-b', '-uall'], directory);
  
  if (statusResult.exitCode !== 0) {
    return {
      current: '',
      tracking: null,
      ahead: 0,
      behind: 0,
      files: [],
      isClean: true,
    };
  }

  const entries = statusResult.stdout.split('\0');
  const files: GitStatusFile[] = [];
  let current = '';
  let tracking: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const line = entries[entryIndex];
    if (!line) continue;
    if (line.startsWith('##')) {
      const branchMatch = line.match(/^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$/);
      if (branchMatch) {
        current = branchMatch[1] || '';
        tracking = branchMatch[2] || null;
        const trackingInfo = branchMatch[3] || '';
        const aheadMatch = trackingInfo.match(/ahead (\d+)/);
        const behindMatch = trackingInfo.match(/behind (\d+)/);
        ahead = aheadMatch ? parseInt(aheadMatch[1], 10) : 0;
        behind = behindMatch ? parseInt(behindMatch[1], 10) : 0;
      }
    } else {
      const index = line[0] || ' ';
      const workingDir = line[1] || ' ';
      const filePath = line.slice(3);
      const isRenameOrCopy = 'RC'.includes(index) || 'RC'.includes(workingDir);
      const previousPath = isRenameOrCopy ? entries[++entryIndex] || undefined : undefined;
      files.push({
        path: filePath,
        index,
        working_dir: workingDir,
        previousPath,
      });
    }
  }

  const inProgressState = await checkInProgressOperations(directory);

  return {
    current,
    tracking,
    ahead,
    behind,
    files,
    isClean: files.length === 0,
    ...inProgressState,
  };
}


export interface GitBranchResult {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
  defaultBranches?: Record<string, string>;
}

async function getRemoteDefaultBranches(directory: string): Promise<Record<string, string>> {
  const result = await execGit(REMOTE_DEFAULT_BRANCHES_ARGS, directory);
  return result.exitCode === 0 ? parseRemoteDefaultBranches(result.stdout) : {};
}

export async function getGitUnpushedBranchCounts(directory: string, requestedBranches: string[]): Promise<{ counts: Record<string, number> }> {
  const requested = [...new Set(requestedBranches)].filter(Boolean).slice(0, 5);
  if (requested.length === 0) return { counts: {} };
  const local = new Set((await getGitBranchesRaw(directory)).all.filter((branch) => !branch.startsWith('remotes/')));
  const counts: Record<string, number> = {};
  await Promise.all(requested.map(async (branch) => {
    if (!local.has(branch)) return;
    const upstreamResult = await execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], directory);
    const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : '';
    if (!upstream) return;
    const countResult = await execGit(['rev-list', '--count', `${upstream}..${branch}`], directory);
    const count = countResult.exitCode === 0 ? Number.parseInt(countResult.stdout.trim(), 10) : 0;
    if (Number.isFinite(count) && count > 0) counts[branch] = count;
  }));
  return { counts };
}

export async function getGitBranches(directory: string): Promise<GitBranchResult> {
  const repo = await getRepository(directory);
  
  if (!repo) {
    return getGitBranchesRaw(directory);
  }

  const state = repo.state;
  const currentBranch = state.HEAD?.name || '';
  const branches: Record<string, GitBranchDetails> = {};
  const all: string[] = [];

  const localRefs = await repo.getBranches({ remote: false });
  for (const ref of localRefs) {
    if (ref.name) {
      all.push(ref.name);
      branches[ref.name] = {
        current: ref.name === currentBranch,
        name: ref.name,
        commit: ref.commit || '',
        label: ref.name,
      };
    }
  }

  const remoteRefs = await repo.getBranches({ remote: true });
  for (const ref of remoteRefs) {
    if (ref.name) {
      const remoteBranchName = `remotes/${ref.name}`;
      all.push(remoteBranchName);
      branches[remoteBranchName] = {
        current: false,
        name: remoteBranchName,
        commit: ref.commit || '',
        label: ref.name,
      };
    }
  }

  if (state.HEAD?.name && state.HEAD?.upstream) {
    const branchInfo = branches[state.HEAD.name];
    if (branchInfo) {
      branchInfo.tracking = `${state.HEAD.upstream.remote}/${state.HEAD.upstream.name}`;
      branchInfo.ahead = state.HEAD.ahead;
      branchInfo.behind = state.HEAD.behind;
    }
  }

  return { all, current: currentBranch, branches, defaultBranches: await getRemoteDefaultBranches(directory) };
}

async function getGitBranchesRaw(directory: string): Promise<GitBranchResult> {
  const result = await execGit(RAW_BRANCH_LISTING_ARGS, directory);
  if (result.exitCode !== 0) {
    return { all: [], current: '', branches: {} };
  }
  return { ...parseRawBranchListing(result.stdout), defaultBranches: await getRemoteDefaultBranches(directory) };
}

export async function createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      await repo.createBranch(name, false, startPoint);
      return { success: true, branch: name };
    } catch (error) {
      console.error('[GitService] Failed to create branch:', error);
    }
  }

  const args = ['branch', name];
  if (startPoint) args.push(startPoint);
  const result = await execGit(args, directory);
  return { success: result.exitCode === 0, branch: name };
}

export async function deleteGitBranch(directory: string, branch: string, force = false): Promise<{ success: boolean }> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      await repo.deleteBranch(branch, force);
      return { success: true };
    } catch (error) {
      console.error('[GitService] Failed to delete branch:', error);
    }
  }

  const flag = force ? '-D' : '-d';
  const result = await execGit(['branch', flag, branch], directory);
  return { success: result.exitCode === 0 };
}

export async function deleteRemoteBranch(directory: string, branch: string, remote = 'origin'): Promise<{ success: boolean }> {
  const head = await execGit(['ls-remote', '--symref', '--', remote, 'HEAD'], directory);
  if (head.exitCode !== 0) return { success: false };
  if (/^ref: (\S+)\tHEAD$/m.exec(head.stdout)?.[1] === `refs/heads/${branch.replace(/^refs\/heads\//, '')}`) {
    throw new Error("The remote's default branch can't be deleted");
  }
  const result = await execGit(['push', '--delete', '--', remote, branch], directory);
  return { success: result.exitCode === 0 };
}


export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
  integrateCheckout?: true;
  directoryCreated?: true;
  bootstrapStatus?: WorktreeBootstrapStatus;
  sourceFetchFailed?: true;
}

type WorktreeListEntry = {
  worktree: string;
  head?: string;
  branchRef?: string;
  branch?: string;
  bare?: boolean;
  locked?: boolean;
};

interface GitWorktreeValidationError {
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
  returnAfterDirectoryCreated?: boolean;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
  teardownCommand?: string;
  disposeInstance?: (worktreeDirectory: string) => Promise<void>;
}

const OPENCODE_ADJECTIVES = [
  'brave', 'calm', 'clever', 'cosmic', 'crisp', 'curious', 'eager', 'gentle', 'glowing', 'happy',
  'hidden', 'jolly', 'kind', 'lucky', 'mighty', 'misty', 'neon', 'nimble', 'playful', 'proud',
  'quick', 'quiet', 'shiny', 'silent', 'stellar', 'sunny', 'swift', 'tidy', 'witty',
];

const OPENCODE_NOUNS = [
  'cabin', 'cactus', 'canyon', 'circuit', 'comet', 'eagle', 'engine', 'falcon', 'forest', 'garden',
  'harbor', 'island', 'knight', 'lagoon', 'meadow', 'moon', 'mountain', 'nebula', 'orchid', 'otter',
  'panda', 'pixel', 'planet', 'river', 'rocket', 'sailor', 'squid', 'star', 'tiger', 'wizard', 'wolf',
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

const canonicalPath = async (input: string): Promise<string> => {
  const absolutePath = path.resolve(input);
  const realPath = await realpathOf(absolutePath).catch(() => absolutePath);
  const normalized = path.normalize(realPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const checkPathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.promises.stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const normalizeStartRef = (value: string | undefined): string => {
  const trimmed = String(value || '').trim();
  return trimmed || 'HEAD';
};

const parseRemoteBranchRef = (value: string) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('refs/remotes/')) {
    const rest = trimmed.substring('refs/remotes/'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      return null;
    }
    return {
      remote: rest.slice(0, slashIndex),
      branch: rest.slice(slashIndex + 1),
      remoteRef: rest,
      fullRef: `refs/remotes/${rest}`,
    };
  }

  if (trimmed.startsWith('remotes/')) {
    return parseRemoteBranchRef(`refs/${trimmed}`);
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  return {
    remote: trimmed.slice(0, slashIndex),
    branch: trimmed.slice(slashIndex + 1),
    remoteRef: trimmed,
    fullRef: `refs/remotes/${trimmed}`,
  };
};

const resolveRemoteBranchRef = async (primaryWorktree: string, value: string) => {
  const raw = String(value || '').trim();
  const parsed = parseRemoteBranchRef(raw);
  if (!parsed || (raw.startsWith('refs/') && !raw.startsWith('refs/remotes/'))) {
    return null;
  }

  if (raw.startsWith('refs/remotes/') || raw.startsWith('remotes/')) return parsed;

  const localRef = `refs/heads/${raw}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return null;
  }

  return parsed;
};

const normalizeUpstreamTarget = (remote: string | undefined, branch: string | undefined) => {
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

type GitCommandResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  message?: string;
};

const runGitCommand = async (cwd: string, args: string[]): Promise<GitCommandResult> => {
  const result = await execGit(args, cwd);
  const message = [result.stderr, result.stdout].map((value) => String(value || '').trim()).filter(Boolean).join('\n').trim();
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    message,
  };
};

const runGitCommandOrThrow = async (cwd: string, args: string[], fallbackMessage: string) => {
  const result = await runGitCommand(cwd, args);
  if (!result.success) {
    throw new Error(result.message || fallbackMessage || 'Git command failed');
  }
  return result;
};

const worktreeRegistry = createWorktreeRegistry(runGitCommandOrThrow);

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isIndexLockError = (result: GitCommandResult): boolean => {
  const message = [result?.message, result?.stderr, result?.stdout].filter(Boolean).join('\n');
  return /index\.lock['"]?: File exists|another git process seems to be running/i.test(message);
};

const getWorktreeIndexLockPath = async (directory: string): Promise<string | null> => {
  const result = await runGitCommand(directory, ['rev-parse', '--git-path', 'index.lock']);
  if (!result.success) {
    return null;
  }
  const value = String(result.stdout || '').trim();
  return value ? (path.isAbsolute(value) ? value : path.resolve(directory, value)) : null;
};

const getFileIdentity = async (filePath: string): Promise<string | null> => {
  try {
    const stat = await fs.promises.stat(filePath);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

// external: #2746 Managed worktree paths exceed Windows MAX_PATH without Git core.longpaths.
const WORKTREE_POPULATE_RESET_ARGS = ['-c', 'core.longpaths=true', 'reset', '--hard'] as const;

const isFilenameTooLongError = (message: string | null | undefined): boolean =>
  /file ?name too long/i.test(String(message || ''));

const formatWorktreePopulateError = (message: string | null | undefined): string => {
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

const ensureWorktreeLongpaths = async (directory: string): Promise<void> => {
  const current = await runGitCommand(directory, ['config', '--get', 'core.longpaths']);
  if (String(current.stdout || '').trim().toLowerCase() === 'true') {
    return;
  }
  await runGitCommand(directory, ['config', 'core.longpaths', 'true']);
};

const populateWorktreeWithLockRecovery = async (directory: string): Promise<void> => {
  await ensureWorktreeLongpaths(directory);

  let result = await runGitCommand(directory, [...WORKTREE_POPULATE_RESET_ARGS]);
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await wait(WORKTREE_INDEX_LOCK_RETRY_DELAY_MS);
  result = await runGitCommand(directory, [...WORKTREE_POPULATE_RESET_ARGS]);
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result)) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  const lockPath = await getWorktreeIndexLockPath(directory);
  const identity = lockPath ? await getFileIdentity(lockPath) : null;
  await wait(WORKTREE_INDEX_LOCK_STALE_DELAY_MS);

  result = await runGitCommand(directory, [...WORKTREE_POPULATE_RESET_ARGS]);
  if (result.success) {
    return;
  }
  if (!isIndexLockError(result) || !lockPath || !identity || await getFileIdentity(lockPath) !== identity) {
    throw new Error(formatWorktreePopulateError(result.message));
  }

  await fs.promises.unlink(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw error;
    }
  });
  const finalResult = await runGitCommand(directory, [...WORKTREE_POPULATE_RESET_ARGS]);
  if (!finalResult.success) {
    throw new Error(formatWorktreePopulateError(finalResult.message || 'Failed to populate worktree'));
  }
};

// external: https://git-scm.com/docs/githooks#_post_checkout Worktree add --no-checkout and reset skip post-checkout, so population invokes the hook explicitly.
const runPostCheckoutHook = async (directory: string): Promise<void> => {
  let hookDirectory: string | null = null;
  try {
    const result = await runGitCommand(directory, ['rev-parse', '--git-path', 'hooks']);
    if (!result.success) return;
    hookDirectory = normalizeDirectoryPath(String(result.stdout || '').trim());
  } catch {
    return;
  }
  if (!hookDirectory) return;

  const hookPath = path.join(hookDirectory, 'post-checkout');
  try {
    const stat = await fs.promises.stat(hookPath);
    if (!stat.isFile()) return;
    if (process.platform !== 'win32') {
      await fs.promises.access(hookPath, fs.constants.X_OK);
    }
  } catch {
    return;
  }

  const [headResult, gitDirResult] = await Promise.all([
    runGitCommand(directory, ['rev-parse', 'HEAD']),
    runGitCommand(directory, ['rev-parse', '--absolute-git-dir']),
  ]);
  if (!headResult.success || !gitDirResult.success) return;
  const head = String(headResult.stdout || '').trim();
  const gitDir = String(gitDirResult.stdout || '').trim();
  if (!head || !gitDir) return;

  try {
    await execFileAsync(hookPath, [GIT_NULL_REF, head, '1'], {
      cwd: directory,
      env: {
        ...(await buildGitEnv()),
        GIT_DIR: gitDir,
        GIT_WORK_TREE: path.resolve(directory),
      },
      windowsHide: true,
    });
  } catch (error) {
    console.warn('[GitService] post-checkout hook failed in worktree:', error instanceof Error ? error.message : String(error));
  }
};

const ensureOpenCodeProjectId = async (primaryWorktree: string): Promise<string> => {
  const gitDir = path.join(primaryWorktree, '.git');
  const idFile = path.join(gitDir, 'opencode');
  const existing = await fs.promises.readFile(idFile, 'utf8').then((value) => value.trim()).catch(() => '');
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

  await fs.promises.mkdir(gitDir, { recursive: true }).catch(() => undefined);
  await fs.promises.writeFile(idFile, projectId, 'utf8').catch(() => undefined);
  return projectId;
};

const primaryWorktreeRootFromGitDir = (gitDir: string): string | null => {
  if (gitDir.replace(/\\/g, '/').endsWith('/.git')) {
    return gitDir.slice(0, -'/.git'.length) || null;
  }
  return null;
};

const resolveWorktreeProjectContext = async (
  directory: string,
  options: { tolerateWorktreeRootConfigError?: boolean } = {},
) => {
  const tolerateWorktreeRootConfigError = options.tolerateWorktreeRootConfigError === true;
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }

  const topResult = await runGitCommand(directoryPath, ['rev-parse', '--show-toplevel']);
  const sandbox = topResult.success
    ? path.resolve(directoryPath, topResult.stdout.trim())
    : directoryPath;

  const commonResult = await runGitCommandOrThrow(
    sandbox,
    ['rev-parse', '--git-common-dir'],
    'Failed to resolve git common directory'
  );
  const commonDir = path.resolve(sandbox, commonResult.stdout.trim());
  const primaryWorktree = primaryWorktreeRootFromGitDir(commonDir) || sandbox;
  const projectID = await ensureOpenCodeProjectId(primaryWorktree);
  const legacyWorktreeRoot = path.join(getOpenCodeDataPath(), 'worktree', projectID);
  let configuredWorktreeRoot: string | null = null;
  try {
    configuredWorktreeRoot = readWorktreeDirectorySetting(primaryWorktree);
  } catch (error) {
    if (!tolerateWorktreeRootConfigError) {
      throw error;
    }
    console.warn(
      '[GitService] Failed to read OpenCode worktree.directory; using the data-dir worktree root:',
      error instanceof Error ? error.message : String(error),
    );
  }
  const worktreeRoot = configuredWorktreeRoot || legacyWorktreeRoot;

  return { projectID, requestedDirectory: directoryPath, sandbox, primaryWorktree, worktreeRoot, legacyWorktreeRoot };
};

const listWorktreeEntries = worktreeRegistry.list;

const resolveWorktreeNameCandidates = (baseName: string): string[] => {
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

const resolveCandidateDirectory = async (
  worktreeRoot: string,
  preferredName: string,
  explicitBranchName: string,
  primaryWorktree: string
) => {
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

const fetchRemoteBranchRef = async (primaryWorktree: string, remoteName: string, branchName: string) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  if (!remote || !branch) {
    return;
  }

  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  await runGitCommandOrThrow(primaryWorktree, ['fetch', '--', remote, refspec], `Failed to fetch ${remote}/${branch}`);
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
      remoteRef: null as ReturnType<typeof parseRemoteBranchRef>,
    };
  }

  const remoteRef = parseRemoteBranchRef(requested);
  if (!remoteRef) {
    throw new Error(`Branch not found: ${requested}`);
  }

  const remoteExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', remoteRef.fullRef]);
  if (!remoteExists.success) {
    await fetchRemoteBranchRef(primaryWorktree, remoteRef.remote, remoteRef.branch).catch(() => undefined);
    const recheck = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', remoteRef.fullRef]);
    if (!recheck.success) {
      throw new Error(`Remote branch not found: ${requested}`);
    }
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

const isBranchKeptOnWorktreeRemoval = async (primaryWorktree: string, branchName: string): Promise<boolean> => {
  if (await findBranchInUse(primaryWorktree, branchName)) return true;
  const refs = await runGitCommand(primaryWorktree, ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes']);
  if (!refs.success) return false;
  return refs.stdout.split('\n').some((line) => {
    const [ref = '', symbolicRef = ''] = line.trim().split(' ');
    const remote = /^refs\/remotes\/([^/]+)\/HEAD$/.exec(ref)?.[1];
    return Boolean(remote) && symbolicRef === `refs/remotes/${remote}/${branchName}`;
  });
};

const runWorktreeStartCommand = async (
  directory: string,
  command: string,
  { timeoutMs = 0, env: extraEnv }: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ success: boolean; message?: string; stdout?: string; stderr?: string }> => {
  const text = String(command || '').trim();
  if (!text) {
    return { success: true };
  }

  const windows = process.platform === 'win32';
  const run = execFileAsync(windows ? 'cmd' : 'bash', windows ? ['/c', text] : ['-lc', text], {
    cwd: directory,
    env: { ...(await buildGitEnv()), ...extraEnv },
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });
  run.child.stdin?.end();
  try {
    const { stdout, stderr } = await run;
    return { success: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean; code?: unknown };
    const timedOut = timeoutMs > 0 && err.killed === true && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    return {
      success: false,
      stdout: err.stdout,
      stderr: err.stderr,
      message: timedOut
        ? `${text} did not finish within ${Math.round(timeoutMs / 1000)} seconds`
        : String(err.message || err.stderr || err.stdout || 'Failed to run start command').trim(),
    };
  }
};


const isInsideOrSameDirectory = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isAttachedGitWorktreeDirectory = async (directory: string): Promise<boolean> => {
  try {
    const result = await runGitCommand(directory, ['rev-parse', '--is-inside-work-tree']);
    return result.success && String(result.stdout || '').trim() === 'true';
  } catch {
    return false;
  }
};

const cleanupFailedFastWorktreeCreate = async (
  context: Awaited<ReturnType<typeof resolveWorktreeProjectContext>>,
  candidate: { directory: string }
): Promise<void> => {
  const candidateDirectory = path.resolve(candidate.directory);
  const worktreeRoot = path.resolve(context.worktreeRoot);
  const isInsideWorktreeRoot = isInsideOrSameDirectory(worktreeRoot, candidateDirectory) && candidateDirectory !== worktreeRoot;
  const isAttached = await isAttachedGitWorktreeDirectory(candidateDirectory);

  if (!isInsideWorktreeRoot || isAttached) {
    return;
  }

  try {
    const entries = await fs.promises.readdir(candidateDirectory);
    if (entries.length === 0) {
      await fs.promises.rmdir(candidateDirectory);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(code || ''))) {
      console.warn('[GitService] Failed to clean up empty worktree directory after creation failure:', error instanceof Error ? error.message : String(error));
    }
  }
};

const WORKTREE_CREATE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const WORKTREE_CREATE_COMMAND_OUTPUT_MAX_CHARS = 2000;

class WorktreeCreateCommandError extends Error {
  readonly code = 'WORKTREE_CREATE_COMMAND_FAILED';
  constructor(message: string, readonly branchMade: boolean) {
    super(message);
  }
}

const shownCommandFailure = (result: { message?: string; stdout?: string; stderr?: string }, maxChars: number): string => {
  const message = String(result.message || '');
  const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  const text = (message.startsWith('Command failed:') || !message) && output
    ? output
    : message || 'the command exited with an error';
  return text.length > maxChars ? `...${text.slice(-maxChars)}` : text;
};

const createWorktreeWithCommand = async ({ primaryWorktree, directory, branch, branchStart, command }: {
  primaryWorktree: string;
  directory: string;
  branch: string;
  branchStart: { start: string; noTrack?: boolean } | null;
  command: string;
}): Promise<string> => {
  if (branchStart) {
    const branchArgs = ['branch'];
    if (branchStart.noTrack) branchArgs.push('--no-track');
    branchArgs.push(branch, branchStart.start);
    await runGitCommandOrThrow(primaryWorktree, branchArgs, 'Failed to create git worktree');
  }
  const failure = (message: string): Error => new WorktreeCreateCommandError(message, Boolean(branchStart));
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

const findWorktreeAtPath = async (primaryWorktree: string, directory: string): Promise<{ path: string; entry: WorktreeListEntry } | null> => {
  const real = await fs.promises.realpath(directory).catch(() => null);
  if (!real) return null;
  const realCanonical = await canonicalPath(real);
  for (const entry of await listWorktreeEntries(primaryWorktree)) {
    if (entry?.worktree && await canonicalPath(entry.worktree) === realCanonical) return { path: real, entry };
  }
  return null;
};

const CREATED_BY_COMMAND_MARK = 'openchamber-created-by-command';

const worktreeCreatedByCommandMarkPath = async (worktreeDirectory: string): Promise<string | null> => {
  const gitDir = await runGitCommand(worktreeDirectory, ['rev-parse', '--absolute-git-dir']);
  return gitDir.success ? path.join(String(gitDir.stdout || '').trim(), CREATED_BY_COMMAND_MARK) : null;
};

const markWorktreeCreatedByCommand = async (worktreeDirectory: string, link: string): Promise<void> => {
  const markPath = await worktreeCreatedByCommandMarkPath(worktreeDirectory);
  if (!markPath) return;
  await fs.promises.writeFile(markPath, link).catch((error) => {
    console.warn('[GitService] Failed to mark a worktree made by the create command:', error instanceof Error ? error.message : String(error));
  });
};

const readWorktreeCreatedByCommand = async (worktreeDirectory: string): Promise<{ link: string } | null> => {
  const markPath = await worktreeCreatedByCommandMarkPath(worktreeDirectory).catch(() => null);
  if (!markPath) return null;
  const link = await fs.promises.readFile(markPath, 'utf8').catch(() => null);
  return link === null ? null : { link: link.trim() };
};

const samePathOf = async (input: string): Promise<string> => path.join(await canonicalPath(path.dirname(input)), path.basename(input));

const removeCreateCommandLink = async (link: string | undefined, worktreeDirectory: string): Promise<void> => {
  if (!link) return;
  try {
    if (!(await fs.promises.lstat(link)).isSymbolicLink()) return;
    const target = path.resolve(path.dirname(link), await fs.promises.readlink(link));
    if (await samePathOf(target) !== await samePathOf(worktreeDirectory)) return;
    await fs.promises.unlink(link);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      console.warn('[GitService] Failed to remove the link the worktree create command left:', error instanceof Error ? error.message : String(error));
    }
  }
};

const runWorktreeStartScripts = async (directory: string, projectDirectory: string, startCommand: string | undefined) => {
  const projectStart = await readProjectStartCommand(projectDirectory);
  if (projectStart) {
    const projectResult = await runWorktreeStartCommand(directory, projectStart);
    if (!projectResult.success) {
      console.warn('[GitService] Worktree project start command failed:', projectResult.message || projectResult.stderr || projectResult.stdout);
      return;
    }
  }

  const extraCommand = String(startCommand || '').trim();
  if (!extraCommand) {
    return;
  }
  const extraResult = await runWorktreeStartCommand(directory, extraCommand);
  if (!extraResult.success) {
    console.warn('[GitService] Worktree start command failed:', extraResult.message || extraResult.stderr || extraResult.stdout);
  }
};

const queueWorktreeBootstrap = (args: {
  directory: string;
  projectDirectory: string;
  primaryWorktree: string;
  localBranch: string;
  setUpstream: boolean;
  upstreamRemote: string;
  upstreamBranch: string;
  ensureRemoteName: string;
  ensureRemoteUrl: string;
  startCommand: string | undefined;
  populated?: boolean;
}) => {
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
    populated,
  } = args;
  const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
    .then(async () => {
      if (!populated) {
        await populateWorktreeWithLockRecovery(directory);
        await runPostCheckoutHook(directory);
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
          console.warn('[GitService] Worktree upstream configuration failed:', error instanceof Error ? error.message : String(error));
        });
      }
      setWorktreeBootstrapState(directory, WORKTREE_BOOTSTRAP_PENDING, WORKTREE_PHASE_GIT_READY);
      await runWorktreeStartScripts(directory, projectDirectory, startCommand).catch((error) => {
        console.warn('[GitService] Worktree start script task failed:', error instanceof Error ? error.message : String(error));
      });
      setWorktreeBootstrapState(directory, WORKTREE_BOOTSTRAP_READY, WORKTREE_PHASE_SETUP_READY);
    })
    .catch((error) => {
      setWorktreeBootstrapFailure(directory, error);
      console.warn('[GitService] Worktree bootstrap task failed:', error instanceof Error ? error.message : String(error));
    });

  trackWorktreeBootstrapTask(directory, task);
};

const ensureRemoteWithUrl = async (primaryWorktree: string, remoteName: string, remoteUrl: string) => {
  const name = String(remoteName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!name || !url) {
    return;
  }

  const getUrl = await runGitCommand(primaryWorktree, ['remote', 'get-url', '--', name]);
  if (getUrl.success) {
    const currentUrl = String(getUrl.stdout || '').trim();
    if (currentUrl !== url) {
      await runGitCommandOrThrow(primaryWorktree, ['remote', 'set-url', '--', name, url], 'Failed to update git remote URL');
    }
    return;
  }

  await runGitCommandOrThrow(primaryWorktree, ['remote', 'add', '--', name, url], 'Failed to add git remote');
};

const checkRemoteBranchExists = async (primaryWorktree: string, remoteName: string, branchName: string, remoteUrl = '') => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!remote || !branch) {
    return { success: false, found: false };
  }

  const target = url || remote;
  const lsRemote = await runGitCommand(primaryWorktree, ['ls-remote', '--heads', '--', target, `refs/heads/${branch}`]);
  if (!lsRemote.success) {
    return { success: false, found: false };
  }

  return {
    success: true,
    found: Boolean(String(lsRemote.stdout || '').trim()),
  };
};

const applyUpstreamConfiguration = async (args: {
  primaryWorktree: string;
  worktreeDirectory: string;
  localBranch: string;
  setUpstream: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
}) => {
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

  try {
    await fetchRemoteBranchRef(primaryWorktree, upstream.remote, upstream.branch);
  } catch {
    return;
  }

  await runGitCommandOrThrow(
    worktreeDirectory,
    ['branch', `--set-upstream-to=${upstream.full}`, localBranch],
    `Failed to set upstream to ${upstream.full}`
  );
};

export async function listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]> {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !(await directoryExists(directoryPath))) {
    if (directoryPath) await assertPathReachable(directoryPath);
    return [];
  }

  try {
    return await listWorktreeRows(directoryPath, await listWorktreeEntries(directoryPath), runGitCommandOrThrow);
  } catch (error) {
    if (!(await checkIsGitRepository(directoryPath))) return [];
    throw error;
  }
}

export async function validateWorktreeCreate(directory: string, input: CreateGitWorktreePayload = {}): Promise<GitWorktreeValidationResult> {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const errors: GitWorktreeValidationError[] = [];

  try {
    const context = await resolveWorktreeProjectContext(directory);
    const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
    const startRef = normalizeStartRef(input?.startRef);
    const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
    const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

    let localBranch = '';
    let inferredUpstream: { remote: string; branch: string } | null = null;

    if (mode === 'existing') {
      try {
        const requestedExistingBranch = String(input?.existingBranch || '').trim();
        const parsedExistingRemote = await resolveRemoteBranchRef(context.primaryWorktree, requestedExistingBranch);
        if (parsedExistingRemote && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedExistingRemote.remote) {
          const lsRemote = await runGitCommand(
            context.primaryWorktree,
            ['ls-remote', '--heads', '--', ensureRemoteUrl, `refs/heads/${parsedExistingRemote.branch}`]
          );
          if (!lsRemote.success) {
            throw new Error(`Unable to query remote ${ensureRemoteName}`);
          }
          if (!String(lsRemote.stdout || '').trim()) {
            throw new Error(`Remote branch not found: ${parsedExistingRemote.remoteRef}`);
          }
          localBranch = cleanBranchName(preferredBranchName || parsedExistingRemote.branch);
          inferredUpstream = {
            remote: parsedExistingRemote.remote,
            branch: parsedExistingRemote.branch,
          };
        } else {
          const resolved = await resolveBranchForExistingMode(context.primaryWorktree, requestedExistingBranch, preferredBranchName);
          localBranch = resolved.localBranch || '';
          if (resolved.remoteRef) {
            inferredUpstream = {
              remote: resolved.remoteRef.remote,
              branch: resolved.remoteRef.branch,
            };
          }
        }
      } catch (error) {
        errors.push({
          code: 'branch_not_found',
          message: error instanceof Error ? error.message : 'Existing branch not found',
        });
      }
    } else {
      if (preferredBranchName) {
        const exists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${preferredBranchName}`]);
        if (exists.success) {
          errors.push({ code: 'branch_exists', message: `Branch already exists: ${preferredBranchName}` });
        }
        localBranch = preferredBranchName;
      }

      const parsedRemoteRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
      if (startRef && startRef !== 'HEAD') {
        if (parsedRemoteRef && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedRemoteRef.remote) {
          const remoteCheck = await checkRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch,
            ensureRemoteUrl
          );
          if (!remoteCheck.success) {
            errors.push({ code: 'remote_unreachable', message: `Unable to query remote ${ensureRemoteName}` });
          } else if (!remoteCheck.found) {
            errors.push({ code: 'start_ref_not_found', message: `Remote branch not found: ${parsedRemoteRef.remoteRef}` });
          }
        } else if (parsedRemoteRef) {
          const remoteCheck = await checkRemoteBranchExists(context.primaryWorktree, parsedRemoteRef.remote, parsedRemoteRef.branch);
          if (!remoteCheck.success) {
            errors.push({ code: 'remote_unreachable', message: `Unable to query remote ${parsedRemoteRef.remote}` });
          } else if (!remoteCheck.found) {
            errors.push({ code: 'start_ref_not_found', message: `Remote branch not found: ${parsedRemoteRef.remoteRef}` });
          }
        } else {
          const startRefExists = await runGitCommand(context.primaryWorktree, ['rev-parse', '--verify', '--quiet', startRef]);
          if (!startRefExists.success) {
            errors.push({ code: 'start_ref_not_found', message: `Start ref not found: ${startRef}` });
          }
        }
      }

      if (parsedRemoteRef) {
        inferredUpstream = { remote: parsedRemoteRef.remote, branch: parsedRemoteRef.branch };
      }
    }

    if (localBranch) {
      const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
      if (inUse) {
        errors.push({ code: 'branch_in_use', message: `Branch is already checked out in ${inUse.worktree}` });
      }
    }

    if ((ensureRemoteName && !ensureRemoteUrl) || (!ensureRemoteName && ensureRemoteUrl)) {
      errors.push({ code: 'invalid_remote_config', message: 'Both ensureRemoteName and ensureRemoteUrl are required together' });
    }

    const shouldSetUpstream = Boolean(input?.setUpstream);
    if (shouldSetUpstream) {
      const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
      const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

      if (!upstreamRemote || !upstreamBranch) {
        errors.push({ code: 'upstream_incomplete', message: 'upstreamRemote and upstreamBranch are required when setUpstream is true' });
      } else {
        const remoteExists = await runGitCommand(context.primaryWorktree, ['remote', 'get-url', '--', upstreamRemote]);
        if (!remoteExists.success && (!ensureRemoteName || ensureRemoteName !== upstreamRemote)) {
          errors.push({ code: 'remote_not_found', message: `Remote not found: ${upstreamRemote}` });
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

const assertWorktreeCreatePreflight = async (directory: string, input: CreateGitWorktreePayload = {}): Promise<void> => {
  const validation = await validateWorktreeCreate(directory, input);
  if (validation?.ok) {
    return;
  }

  const message = validation?.errors
    ?.map((error) => error?.message)
    .filter(Boolean)
    .join('\n') || 'Failed to validate worktree creation';
  throw new Error(message);
};

export async function previewWorktreeCreate(directory: string, input: CreateGitWorktreePayload = {}): Promise<GitWorktreeInfo> {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);
  await fs.promises.mkdir(context.worktreeRoot, { recursive: true });
  context.worktreeRoot = await fs.promises.realpath(context.worktreeRoot);

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
    head: '',
  };
}

const branchNameClashesWithExistingRef = async (primaryWorktree: string, branchName: string): Promise<boolean> => {
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

async function attachGitWorktreeToCandidate(
  context: Awaited<ReturnType<typeof resolveWorktreeProjectContext>>,
  candidate: { name: string; directory: string; branch: string },
  input: CreateGitWorktreePayload = {},
): Promise<GitWorktreeInfo> {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const startRef = normalizeStartRef(input?.startRef);
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
  const createCommand = String(input?.createCommand || '').trim();

  let localBranch = '';
  let inferredUpstream: { remote: string; branch: string } | null = null;
  const worktreeAddArgs = ['worktree', 'add', '--no-checkout'];
  let branchStart: { start: string; noTrack?: boolean } | null = null;

  if (mode === 'existing') {
    const requestedExistingBranch = String(input?.existingBranch || '').trim();
    const parsedExistingRemote = await resolveRemoteBranchRef(context.primaryWorktree, requestedExistingBranch);
    if (parsedExistingRemote && ensureRemoteName && ensureRemoteUrl && parsedExistingRemote.remote === ensureRemoteName) {
      await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
      await fetchRemoteBranchRef(context.primaryWorktree, parsedExistingRemote.remote, parsedExistingRemote.branch);
    }

    const resolved = await resolveBranchForExistingMode(context.primaryWorktree, requestedExistingBranch, preferredBranchName);
    localBranch = resolved.localBranch;

    const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
    if (inUse) {
      throw new Error(`Branch is already checked out in ${inUse.worktree}`);
    }

    if (resolved.createLocalBranch) {
      worktreeAddArgs.push('-b', localBranch);
      branchStart = { start: resolved.checkoutRef };
    }
    worktreeAddArgs.push(candidate.directory, resolved.checkoutRef);

    if (resolved.remoteRef) {
      inferredUpstream = {
        remote: resolved.remoteRef.remote,
        branch: resolved.remoteRef.branch,
      };
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
      worktreeAddArgs.splice(2, 0, '--no-track');
      inferredUpstream = {
        remote: parsedRemoteStartRef.remote,
        branch: parsedRemoteStartRef.branch,
      };
    }
    branchStart = { start: startRef && startRef !== 'HEAD' ? startRef : 'HEAD', noTrack: Boolean(parsedRemoteStartRef) };
  }

  if (mode === 'existing' && ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  const branchNameConflict = worktreeAddArgs.includes('-b')
    && await branchNameClashesWithExistingRef(context.primaryWorktree, localBranch);
  try {
    if (createCommand) {
      const directory = await createWorktreeWithCommand({
        primaryWorktree: context.primaryWorktree,
        directory: candidate.directory,
        branch: localBranch,
        branchStart,
        command: createCommand,
      }).catch(async (error) => {
        if (error instanceof WorktreeCreateCommandError && error.branchMade && !(await findBranchInUse(context.primaryWorktree, localBranch))) {
          await runGitCommand(context.primaryWorktree, ['branch', '-D', localBranch]);
        }
        throw error;
      });
      candidate = { ...candidate, directory };
    } else {
      await worktreeRegistry.add(context.primaryWorktree, worktreeAddArgs, candidate.directory, 'Failed to create git worktree');
    }
  } catch (error) {
    if (branchNameConflict && !(error instanceof WorktreeCreateCommandError)) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'BRANCH_NAME_CONFLICT' });
    }
    throw error;
  }
  if (mode === 'new') await recordWorktreeBranchParent(runGitCommand, context.primaryWorktree, localBranch, startRef);

  const shouldSetUpstream = Boolean(input?.setUpstream);
  const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
  const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

  const bootstrapStatus = setWorktreeBootstrapState(
    candidate.directory,
    WORKTREE_BOOTSTRAP_PENDING,
    WORKTREE_PHASE_DIRECTORY_CREATED,
  ) ?? {
    status: WORKTREE_BOOTSTRAP_PENDING,
    phase: WORKTREE_PHASE_DIRECTORY_CREATED,
    error: null,
    updatedAt: Date.now(),
  };

  queueWorktreeBootstrap({
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
    populated: Boolean(createCommand),
  });

  const headResult = await runGitCommand(candidate.directory, ['rev-parse', 'HEAD']);
  const head = String(headResult.stdout || '').trim();

  return {
    head,
    name: candidate.name,
    branch: localBranch,
    path: candidate.directory,
    directoryCreated: true,
    bootstrapStatus,
  };
}

const isAncestorRef = async (cwd: string, ancestor: string, descendant: string): Promise<boolean> => {
  const result = await runGitCommand(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.success;
};

type PublishedLocalBranchUpstream = { remote: string; branch: string; localRef: string; trackingRef: string };

const resolvePublishedLocalBranchUpstream = async (
  primaryWorktree: string,
  startRef: string,
): Promise<PublishedLocalBranchUpstream | null> => {
  const branch = startRef.trim().replace(/^refs\/heads\//, '');
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
  const [, trackingRef = '', remote = '', remoteRef = ''] = line.split('\0');
  const remoteBranch = remoteRef.replace(/^refs\/heads\//, '');
  if (!remote || !remoteBranch || trackingRef !== `refs/remotes/${remote}/${remoteBranch}`) return null;
  if (!(await isAncestorRef(primaryWorktree, localRef, trackingRef))) return null;
  return { remote, branch: remoteBranch, localRef, trackingRef };
};

const preparePublishedLocalBranchSource = async (
  primaryWorktree: string,
  input: CreateGitWorktreePayload,
  startRef: string,
): Promise<{ input: CreateGitWorktreePayload; sourceFetchFailed: boolean }> => {
  const upstream = await resolvePublishedLocalBranchUpstream(primaryWorktree, startRef);
  if (!upstream) return { input, sourceFetchFailed: false };
  try {
    await fetchRemoteBranchRef(primaryWorktree, upstream.remote, upstream.branch);
  } catch {
    return { input, sourceFetchFailed: true };
  }
  if (!(await isAncestorRef(primaryWorktree, upstream.localRef, upstream.trackingRef))) {
    return { input, sourceFetchFailed: false };
  }
  return {
    input: { ...input, startRef: `remotes/${upstream.remote}/${upstream.branch}` },
    sourceFetchFailed: false,
  };
};

const prepareWorktreeCreateSource = async (
  context: Awaited<ReturnType<typeof resolveWorktreeProjectContext>>,
  input: CreateGitWorktreePayload,
): Promise<{ input: CreateGitWorktreePayload; sourceFetchFailed: boolean }> => {
  if (input.mode === 'existing') {
    return { input, sourceFetchFailed: false };
  }

  const ensureRemoteName = String(input.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input.ensureRemoteUrl || '').trim();
  if (ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  const startRef = normalizeStartRef(input.startRef);
  const remoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
  if (!remoteStartRef) {
    return preparePublishedLocalBranchSource(context.primaryWorktree, input, startRef);
  }

  const status = await getGitStatus(context.primaryWorktree, { mode: 'light' }).catch(() => null);
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
    if (canFallbackToLocal && status?.current) {
      return {
        input: { ...input, startRef: status.current },
        sourceFetchFailed: true,
      };
    }

    const refExists = await runGitCommand(
      context.primaryWorktree,
      ['show-ref', '--verify', '--quiet', remoteStartRef.fullRef],
    );
    if (!refExists.success) {
      throw error;
    }
    console.warn(`[GitService] failed to refresh ${remoteStartRef.remote}/${remoteStartRef.branch}, proceeding with the existing remote-tracking ref`);
    return { input, sourceFetchFailed: false };
  }
};

export async function createWorktree(directory: string, input: CreateGitWorktreePayload = {}): Promise<GitWorktreeInfo> {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);

  if (input?.returnAfterDirectoryCreated === true) {
    await assertWorktreeCreatePreflight(directory, input);
  }
  const prepared = await prepareWorktreeCreateSource(context, input);
  const preparedInput = prepared.input;

  await fs.promises.mkdir(context.worktreeRoot, { recursive: true });
  context.worktreeRoot = await fs.promises.realpath(context.worktreeRoot);

  const preferredName = String(preparedInput.worktreeName || preparedInput.name || '').trim();
  const preferredBranchName = cleanBranchName(String(preparedInput.branchName || '').trim());

  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  if (preparedInput.returnAfterDirectoryCreated === true && !String(preparedInput.createCommand || '').trim()) {
    await fs.promises.mkdir(candidate.directory, { recursive: false });

    const bootstrapStatus = setWorktreeBootstrapState(
      candidate.directory,
      WORKTREE_BOOTSTRAP_PENDING,
      WORKTREE_PHASE_DIRECTORY_CREATED,
    ) ?? {
      status: WORKTREE_BOOTSTRAP_PENDING,
      phase: WORKTREE_PHASE_DIRECTORY_CREATED,
      error: null,
      updatedAt: Date.now(),
    };
    const localBranch = mode === 'existing'
      ? cleanBranchName(String(preparedInput.branchName || preparedInput.existingBranch || candidate.branch || '').trim())
      : candidate.branch;

    const task = attachGitWorktreeToCandidate(context, candidate, preparedInput).catch(async (error) => {
      setWorktreeBootstrapFailure(candidate.directory, error);
      await cleanupFailedFastWorktreeCreate(context, candidate);
      console.warn('[GitService] Background worktree creation failed:', error instanceof Error ? error.message : String(error));
    });
    trackWorktreeBootstrapTask(candidate.directory, task);

    const result: GitWorktreeInfo = {
      head: '',
      name: candidate.name,
      branch: localBranch,
      path: candidate.directory,
      directoryCreated: true,
      bootstrapStatus,
    };
    if (prepared.sourceFetchFailed) {
      result.sourceFetchFailed = true;
    }
    return result;
  }

  const result = await attachGitWorktreeToCandidate(context, candidate, preparedInput);
  return prepared.sourceFetchFailed ? { ...result, sourceFetchFailed: true } : result;
}

export async function getWorktreeBootstrapStatus(directory: string): Promise<WorktreeBootstrapStatus> {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    throw new Error('Worktree directory is required');
  }

  const current = worktreeBootstrapState.get(key);
  if (current) {
    return current;
  }

  return {
    status: WORKTREE_BOOTSTRAP_READY,
    phase: WORKTREE_PHASE_SETUP_READY,
    error: null,
    updatedAt: Date.now(),
  };
}

const disposeWorktreeInstanceBestEffort = async (
  disposeInstance: RemoveGitWorktreePayload['disposeInstance'],
  worktreeDirectory: string,
): Promise<void> => {
  if (!disposeInstance) {
    return;
  }
  try {
    await disposeInstance(worktreeDirectory);
  } catch (error) {
    console.warn(
      `Failed to dispose the OpenCode instance for removed worktree ${worktreeDirectory}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
};

type WorktreeRemoval = { root: string; settled: Promise<void> };
const worktreeRemovalsInProgress = new Set<WorktreeRemoval>();

const canonicalPathOfExistingAncestor = async (input: string): Promise<string> => {
  const absolutePath = path.resolve(input);
  for (let current = absolutePath; ; current = path.dirname(current)) {
    const realPath = await fs.promises.realpath(current).catch(() => null);
    if (realPath !== null || path.dirname(current) === current) {
      const normalized = path.normalize(path.join(realPath ?? current, path.relative(current, absolutePath)));
      return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }
  }
};

const trackWorktreeRemoval = (canonicalDirectory: string): (() => void) => {
  let settle = () => {};
  const removal = { root: canonicalDirectory, settled: new Promise<void>((resolve) => { settle = resolve; }) };
  worktreeRemovalsInProgress.add(removal);
  return () => {
    worktreeRemovalsInProgress.delete(removal);
    settle();
  };
};

export async function waitForWorktreeRemoval(directory: string): Promise<void> {
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
const WORKTREE_TEARDOWN_TIMEOUT_MS = 5 * 60 * 1000;
const WORKTREE_TEARDOWN_OUTPUT_MAX_CHARS = 2000;

const isWorktreeBusyError = (text: string | undefined): boolean => process.platform === 'win32'
  && /Permission denied|EBUSY|EPERM|resource busy|being used by another process/i.test(text ?? '');

const removeBusyDirectory = async (targetDirectory: string): Promise<void> => {
  try {
    await fs.promises.rm(targetDirectory, { recursive: true, force: true, maxRetries: WORKTREE_BUSY_RETRY_DELAYS_MS.length, retryDelay: WORKTREE_BUSY_RETRY_DELAYS_MS[0] });
  } catch (error) {
    if (error instanceof Error && isWorktreeBusyError(`${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`)) {
      throw new Error(WORKTREE_BUSY_MESSAGE);
    }
    throw error;
  }
};

const removeGitWorktreeWhenFree = async (
  primaryWorktree: string,
  worktreePath: string,
  targetCanonical: string,
  releaseInstance: () => Promise<void>,
  overrideLock = false,
): Promise<boolean> => {
  const removeArgs = ['worktree', 'remove', '--force', ...(overrideLock ? ['--force'] : []), worktreePath];
  for (let attempt = 0; ; attempt += 1) {
    await directoryReachability.assertReachable(worktreePath);
    await worktreeRegistry.assertEnumerable(primaryWorktree);
    const result = await runGitCommand(primaryWorktree, removeArgs);
    if (result.success) return true;
    if (!isWorktreeBusyError(result.message)) {
      throw new Error(result.message || 'Failed to remove git worktree');
    }
    let stillRegistered = false;
    for (const entry of await listWorktreeEntries(primaryWorktree)) {
      if (entry?.worktree && await canonicalPath(entry.worktree) === targetCanonical) {
        stillRegistered = true;
        break;
      }
    }
    if (!stillRegistered) {
      await releaseInstance();
      return false;
    }
    const delay = WORKTREE_BUSY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) throw new Error(WORKTREE_BUSY_MESSAGE);
    await releaseInstance();
    await wait(delay);
  }
};

const contributorProvenancePath = (): string => path.join(
  process.env.OPENCHAMBER_DATA_DIR ? path.resolve(process.env.OPENCHAMBER_DATA_DIR) : path.join(os.homedir(), '.config', 'openchamber'),
  'git-contributor-provenance.json',
);

const isContributorCheckout = async (worktreeDirectory: string): Promise<boolean> => {
  const gitDirectory = await runGitCommandOrThrow(worktreeDirectory, ['rev-parse', '--absolute-git-dir'], 'Could not find the git directory');
  return isContributorForkGitDirectory({
    filePath: contributorProvenancePath(),
    gitDirectory: gitDirectory.stdout.trim(),
  });
};

const runWorktreeTeardown = async (worktreeDirectory: string, command: string | undefined): Promise<void> => {
  if (!command?.trim()) return;
  if (worktreeBootstrapState.get(toBootstrapStateKey(worktreeDirectory))?.status === WORKTREE_BOOTSTRAP_FAILED) return;
  if (!(await checkPathExists(worktreeDirectory))) return;
  const contributor = await isContributorCheckout(worktreeDirectory).catch((error: Error) => {
    throw Object.assign(new Error(`Could not tell whether this checkout holds a contributor's code, so no teardown command ran and the worktree was kept: ${error.message}`), { code: 'WORKTREE_TEARDOWN_FAILED' });
  });
  if (contributor) return;
  const teardown = await runWorktreeStartCommand(worktreeDirectory, command, { timeoutMs: WORKTREE_TEARDOWN_TIMEOUT_MS });
  if (!teardown.success) {
    const shown = shownCommandFailure(teardown, WORKTREE_TEARDOWN_OUTPUT_MAX_CHARS);
    throw Object.assign(new Error(`Worktree teardown command failed, so the worktree was kept: ${shown}`), { code: 'WORKTREE_TEARDOWN_FAILED' });
  }
};

export async function teardownWorktree(directory: string, input: { directory: string; teardownCommand?: string }): Promise<boolean> {
  const targetDirectory = normalizeDirectoryPath(input?.directory);
  if (!targetDirectory) {
    throw new Error('Worktree directory is required');
  }
  await directoryReachability.assertReachable(targetDirectory);
  await waitForActiveWorktreeBootstrap(targetDirectory);
  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  const targetCanonical = await canonicalPath(targetDirectory);
  if (targetCanonical === await canonicalPath(context.primaryWorktree)) {
    throw new Error('Cannot tear down the primary workspace');
  }
  for (const entry of await listWorktreeEntries(context.primaryWorktree)) {
    if (entry?.worktree && await canonicalPath(entry.worktree) === targetCanonical) {
      await runWorktreeTeardown(entry.worktree, input?.teardownCommand);
      break;
    }
  }
  return true;
}

export async function removeWorktree(directory: string, input: RemoveGitWorktreePayload): Promise<boolean> {
  const targetDirectory = normalizeDirectoryPath(input?.directory);
  if (!targetDirectory) {
    throw new Error('Worktree directory is required');
  }
  await directoryReachability.assertReachable(targetDirectory);
  await worktreeRegistry.assertEnumerable(directory);

  await waitForActiveWorktreeBootstrap(targetDirectory);

  const context = await resolveWorktreeProjectContext(directory, { tolerateWorktreeRootConfigError: true });
  const deleteLocalBranch = input?.deleteLocalBranch === true;

  const targetCanonical = await canonicalPath(targetDirectory);
  const primaryCanonical = await canonicalPath(context.primaryWorktree);
  if (targetCanonical === primaryCanonical) {
    throw new Error('Cannot remove the primary workspace');
  }

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
    const worktreeRootCanonical = await canonicalPath(context.worktreeRoot);
    const legacyWorktreeRootCanonical = context.legacyWorktreeRoot
      ? await canonicalPath(context.legacyWorktreeRoot)
      : null;
    const insideLegacyRoot = legacyWorktreeRootCanonical !== null
      && targetCanonical !== legacyWorktreeRootCanonical
      && isInsideOrSameDirectory(legacyWorktreeRootCanonical, targetCanonical);
    const insideConfiguredRoot = targetCanonical !== worktreeRootCanonical
      && isInsideOrSameDirectory(worktreeRootCanonical, targetCanonical);
    const isManagedOrphan = insideLegacyRoot || (registered && insideConfiguredRoot);
    const targetExists = await checkPathExists(targetDirectory);
    if (targetExists && isManagedOrphan) {
      await removeBusyDirectory(targetDirectory);
    }
    await worktreeRegistry.forget(context.primaryWorktree, targetDirectory).catch((error) => console.warn('[GitService] Failed to forget the worktree:', error));
  };

  if (!matchedEntry?.worktree) {
    await removeManagedOrphan({ registered: false });
    clearWorktreeBootstrapState(targetDirectory);

    return true;
  }

  await runWorktreeTeardown(matchedEntry.worktree, input?.teardownCommand);

  const createdByCommand = await readWorktreeCreatedByCommand(matchedEntry.worktree);
  const settleRemoval = trackWorktreeRemoval(targetCanonical);
  const releaseInstance = () => disposeWorktreeInstanceBestEffort(input?.disposeInstance, matchedEntry.worktree);
  try {
    await releaseInstance();

    const overrideLock = matchedEntry.locked === true && createdByCommand !== null;
    const removedByGit = await removeGitWorktreeWhenFree(context.primaryWorktree, matchedEntry.worktree, targetCanonical, releaseInstance, overrideLock);
    if (!removedByGit) {
      await removeManagedOrphan({ registered: true });
    }
    await removeCreateCommandLink(createdByCommand?.link, matchedEntry.worktree);
  } finally {
    settleRemoval();
  }

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

  clearWorktreeBootstrapState(matchedEntry.worktree);

  return true;
}

const RUN_SNAPSHOT_REF_PATTERN = /^refs\/openchamber\/runs\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const assertRunSnapshotRef = (ref: string | undefined): string => {
  const value = typeof ref === 'string' ? ref.trim() : '';
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

export async function snapshotWorktree(directory: string, input: { ref?: string }): Promise<{ ref: string; commit: string; head: string }> {
  const worktreeDirectory = normalizeDirectoryPath(directory);
  if (!worktreeDirectory) {
    throw new Error('Worktree directory is required');
  }
  const ref = assertRunSnapshotRef(input?.ref);
  const head = (await runGitCommandOrThrow(worktreeDirectory, ['rev-parse', '--verify', 'HEAD'], 'Worktree has no HEAD commit')).stdout.trim();

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openchamber-snapshot-'));
  const indexEnv = { GIT_INDEX_FILE: path.join(tempDir, 'index') };
  try {
    const run = async (args: string[], message: string, env: NodeJS.ProcessEnv = indexEnv): Promise<string> => {
      const result = await execGit(args, worktreeDirectory, env);
      if (result.exitCode !== 0) {
        throw new Error(String(result.stderr || '').trim() || message);
      }
      return String(result.stdout || '').trim();
    };
    await run(['read-tree', head], 'Failed to prepare snapshot index');
    await run(['add', '-A'], 'Failed to collect worktree changes');
    const tree = await run(['write-tree'], 'Failed to write snapshot tree');
    const commit = await run(
      ['commit-tree', tree, '-p', head, '-m', 'OpenChamber run snapshot'],
      'Failed to write snapshot commit',
      { ...indexEnv, ...SNAPSHOT_IDENTITY_ENV },
    );
    await run(['update-ref', ref, commit], 'Failed to store snapshot ref', {});
    return { ref, commit, head };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}


export async function getGitDiff(
  directory: string, 
  filePath: string, 
  staged = false,
  contextLines?: number
): Promise<{ kind: 'diff'; diff: string; submodule: GitSubmoduleState | null } | GitPathUnavailable> {
  const target = await resolveGitPathTarget(execGit, directory, filePath);
  if (target.kind === 'unavailable') return target;

  const args = ['diff'];
  if (staged) args.push('--cached');
  if (typeof contextLines === 'number') args.push(`-U${contextLines}`);
  args.push('--', target.repoPath);

  const result = await execGit(args, directory);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || 'Failed to get Git diff');
  }
  const submodule = target.kind === 'submodule' ? await readSubmoduleState(execGit, directory, target) : null;
  return { kind: 'diff', diff: result.stdout, submodule };
}

export async function revertGitFile(
  directory: string,
  filePath: string,
  options: { scope?: 'all' | 'working' } = {},
): Promise<void> {
  const scope = options.scope === 'working' ? 'working' : 'all';
  const tracked = await execGit(['ls-files', '--error-unmatch', '--', filePath], directory);
  if (tracked.exitCode !== 0) {
    const clean = await execGit(['clean', '-f', '-d', '--', filePath], directory);
    if (clean.exitCode !== 0) {
      const root = path.resolve(directory);
      const target = path.resolve(directory, filePath);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Path is outside repository: ${filePath}`);
      }
      await fs.promises.rm(target, { recursive: true, force: true });
    }
    return;
  }

  if (scope === 'all') {
    const unstage = await execGit(['restore', '--staged', '--', filePath], directory);
    if (unstage.exitCode !== 0) {
      await execGit(['reset', 'HEAD', '--', filePath], directory);
    }
  }

  const restore = await execGit(['restore', '--', filePath], directory);
  if (restore.exitCode === 0) {
    return;
  }

  const fallback = await execGit(['checkout', '--', filePath], directory);
  if (fallback.exitCode !== 0) {
    throw new Error(fallback.stderr || restore.stderr || 'Failed to revert git file');
  }
}

export async function stageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required');
  }
  const result = await execGit(['add', '--', ...paths], directory);
  if (result.exitCode === 0) {
    return;
  }

  const isPathspecError =
    /pathspec/.test(result.stderr) && /did not match any files/.test(result.stderr);
  if (!isPathspecError) {
    throw new Error(result.stderr || 'Failed to stage git file');
  }

  for (const path of paths) {
    const perPath = await execGit(['add', '--', path], directory);
    if (perPath.exitCode === 0) {
      continue;
    }
    const perPathIsPathspecError =
      /pathspec/.test(perPath.stderr) && /did not match any files/.test(perPath.stderr);
    if (!perPathIsPathspecError) {
      throw new Error(perPath.stderr || 'Failed to stage git file');
    }
  }
}

export async function unstageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required');
  }
  const result = await execGit(['restore', '--staged', '--', ...paths], directory);
  if (result.exitCode === 0) {
    return;
  }
  const fallback = await execGit(['reset', 'HEAD', '--', ...paths], directory);
  if (fallback.exitCode !== 0) {
    throw new Error(fallback.stderr || result.stderr || 'Failed to unstage git file');
  }
}

const HUNK_ACTION_ARGS: Record<'stage' | 'unstage' | 'discard', string[]> = {
  stage: ['--cached'],
  unstage: ['--cached', '--reverse'],
  discard: ['--reverse'],
};

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
      return JSON.parse(token) as string;
    } catch {
      return token.slice(1, token.endsWith('"') ? -1 : undefined);
    }
  }

  return value.split('\t', 1)[0] || null;
};

const normalizePatchTargetPath = (value: string | null): string | null => {
  if (!value || value === '/dev/null') {
    return null;
  }
  return value.replace(/^[ab]\//, '').replace(/\\/g, '/');
};

const extractPatchTargetPath = (patch: string): string | null => {
  const matches = [...patch.matchAll(/^(?:-{3}|\+{3})\s+.+$/gm)];
  const realTargets = matches
    .map((match) => normalizePatchTargetPath(parsePatchPathToken(match[0] ?? '')))
    .filter((value): value is string => Boolean(value));
  return realTargets[0] || null;
};

const getRepoRelativePath = async (directory: string, filePath: string): Promise<string> => {
  const normalizedFilePath = normalizePath(filePath).replace(/\\/g, '/');
  if (!path.isAbsolute(normalizedFilePath)) {
    return normalizedFilePath.replace(/^\.?\//, '');
  }

  const rootResult = await execGit(['rev-parse', '--show-toplevel'], directory);
  if (rootResult.exitCode !== 0) {
    throw new Error(rootResult.stderr || 'Failed to resolve repository root');
  }

  const repoRoot = normalizePath(rootResult.stdout.trim());
  return path.relative(repoRoot, normalizedFilePath).replace(/\\/g, '/');
};

export async function applyGitHunk(
  directory: string,
  filePath: string,
  patch: string,
  action: 'stage' | 'unstage' | 'discard',
): Promise<void> {
  if (!HUNK_ACTION_ARGS[action]) {
    throw new Error('Invalid hunk action');
  }
  if (!filePath) {
    throw new Error('path is required');
  }
  if (typeof patch !== 'string' || !patch.trim()) {
    throw new Error('patch is required');
  }
  if (!/^@@\s/m.test(patch)) {
    throw new Error('patch does not contain a hunk header');
  }

  const repoRelativePath = await getRepoRelativePath(directory, filePath);
  const targetPath = extractPatchTargetPath(patch);
  if (targetPath && targetPath !== repoRelativePath && targetPath !== filePath.replace(/\\/g, '/')) {
    throw new Error('patch target path does not match the requested file');
  }

  const flags = HUNK_ACTION_ARGS[action];
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `openchamber-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);

  try {
    await fs.promises.writeFile(tmpPath, patch, 'utf8');

    const check = await execGit(['apply', ...flags, '--check', tmpPath], directory);
    if (check.exitCode !== 0) {
      const detail = (check.stderr || '').trim();
      throw new Error(
        detail
          ? `Hunk no longer applies — refresh and try again.\n${detail}`
          : 'Hunk no longer applies — refresh and try again.'
      );
    }

    const apply = await execGit(['apply', ...flags, tmpPath], directory);
    if (apply.exitCode !== 0) {
      throw new Error(apply.stderr || 'Failed to apply git hunk');
    }
  } finally {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  }
}

export async function listGitStashes(directory: string): Promise<Array<{ ref: string; message: string; relativeTime: string; hash: string }>> {
  const result = await execGit(['stash', 'list', '--format=%gd%x1f%gs%x1f%cr%x1f%H'], directory);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Failed to list stashes');
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [ref = '', message = '', relativeTime = '', hash = ''] = line.split('\x1f');
    return { ref, message, relativeTime, hash };
  }).filter((entry) => entry.ref);
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<Record<string, number>> {
  const uniqueRefs = Array.from(new Set(refs.map((ref) => String(ref || '').trim()).filter(Boolean)));
  const counts: Record<string, number> = {};
  const concurrency = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < uniqueRefs.length) {
      const ref = uniqueRefs[cursor++];
      if (!ref) continue;
      const names = await execGit(['stash', 'show', '--include-untracked', '--name-only', ref], directory);
      counts[ref] = names.exitCode === 0 ? names.stdout.split('\n').map((line) => line.trim()).filter(Boolean).length : 0;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()));
  return counts;
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const message = options.message?.trim() || `OpenChamber stash ${new Date().toISOString()}`;
  const result = await execGit(['stash', 'push', '--include-untracked', '-m', message], directory);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Failed to stash changes');
  const output = result.stdout.trim() || result.stderr.trim();
  return { success: true, created: !/no local changes/i.test(output), message, output };
}

export async function applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const ref = options.ref || 'stash@{0}';
  const withIndex = await execGit(['stash', 'apply', '--index', ref], directory);
  if (withIndex.exitCode === 0) {
    return { success: true, ref };
  }
  const result = await execGit(['stash', 'apply', ref], directory);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to apply stash');
  return { success: true, ref };
}

export async function dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const ref = options.ref || 'stash@{0}';
  const result = await execGit(['stash', 'drop', ref], directory);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to drop stash');
  return { success: true, ref };
}

export async function popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> {
  const ref = options.ref || 'stash@{0}';
  await applyGitStash(directory, { ref });
  await dropGitStash(directory, { ref });
  return { success: true, ref };
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

async function resolveBaseRefForLog(
  from: string | undefined,
  directory: string
): Promise<string | undefined> {
  const normalized = typeof from === 'string' ? from.trim() : undefined;
  if (!normalized) return undefined;

  const checkRef = async (ref: string): Promise<boolean> => {
    const result = await execGit(['rev-parse', '--verify', ref], directory);
    return result.exitCode === 0 && Boolean(result.stdout.trim());
  };

  if (await checkRef(normalized)) return normalized;

  const originRef = `refs/remotes/origin/${normalized}`;
  if (await checkRef(originRef)) return `origin/${normalized}`;

  return normalized;
}

export async function getGitLog(
  directory: string,
  options?: { maxCount?: number; from?: string; to?: string; file?: string; all?: boolean }
): Promise<{ all: GitLogEntry[]; latest: GitLogEntry | null; total: number }> {
  const maxCount = options?.maxCount || 50;

  if (options?.all) {
    const logArgs = [
      'log',
      `--max-count=${maxCount}`,
      '--all',
      '--topo-order',
      '--date=iso',
      '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
      '--shortstat',
    ];

    const result = await execGit(logArgs, directory);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to get git log');
    }

    const records = result.stdout
      .split('\x1e')
      .map((e) => e.trim())
      .filter(Boolean);

    const entries: GitLogEntry[] = [];
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
        if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);
        if (insertMatch) insertions = parseInt(insertMatch[1], 10);
        if (deleteMatch) deletions = parseInt(deleteMatch[1], 10);
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

  if (!options?.to && (await execGit(['rev-parse', '--verify', '-q', 'HEAD'], directory)).exitCode !== 0) {
    if ((await execGit(['symbolic-ref', '-q', 'HEAD'], directory)).exitCode === 0) {
      return { all: [], latest: null, total: 0 };
    }
  }

  const resolvedFrom = await resolveBaseRefForLog(options?.from, directory);

  const args = [
    'log',
    `--max-count=${maxCount}`,
    '--date=iso',
    '--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
    '--shortstat',
  ];

  if (resolvedFrom && options?.to) {
    args.push(`${resolvedFrom}..${options.to}`);
  } else if (resolvedFrom) {
    args.push(`${resolvedFrom}..HEAD`);
  } else if (options?.to) {
    args.push(options.to);
  }

  if (options?.file) {
    args.push('--', options.file);
  }

  const result = await execGit(args, directory);

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to get git log');
  }

  const records = result.stdout
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const statsMap = new Map<string, { filesChanged: number; insertions: number; deletions: number; parents: string[] }>();

  for (const record of records) {
    const lines = record.split('\n').filter((line) => line.trim().length > 0);
    const header = lines.shift() || '';
    const [hash, parentsRaw] = header.split('\x1f');
    const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
    if (!hash) continue;

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    for (const line of lines) {
      const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
      const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
      const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);
      if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);
      if (insertMatch) insertions = parseInt(insertMatch[1], 10);
      if (deleteMatch) deletions = parseInt(deleteMatch[1], 10);
    }

    statsMap.set(hash, { filesChanged, insertions, deletions, parents });
  }

  const entries: GitLogEntry[] = [];
  for (const record of records) {
    const header = record.split('\n').filter((l) => l.trim().length > 0)[0] || '';
    const [hash] = header.split('\x1f');
    if (!hash) continue;
    const stats = statsMap.get(hash) || { filesChanged: 0, insertions: 0, deletions: 0, parents: [] };
    const lines = record.split('\n').filter((l) => l.trim().length > 0);
    const lineHeader = lines.shift() || '';
    const [, , author_name, author_email, date, message, refs] = lineHeader.split('\x1f');
    entries.push({
      hash,
      date: date || '',
      message: message || '',
      refs: refs?.trim() || '',
      body: '',
      author_name: author_name || '',
      author_email: author_email || '',
      filesChanged: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
      parents: stats.parents,
    });
  }

  return {
    all: entries,
    latest: entries[0] || null,
    total: entries.length,
  };
}


export async function getRemotes(directory: string): Promise<GitRemote[]> {
  const result = await execGit(['remote', '-v'], directory);
  if (result.exitCode !== 0) {
    return [];
  }
  return parseGitRemoteListing(result.stdout);
}

export async function removeRemote(directory: string, remote: string): Promise<{ success: boolean }> {
  const remoteName = String(remote || '').trim();
  if (!remoteName) {
    throw new Error('Remote name is required');
  }
  if (remoteName === 'origin') {
    throw new Error('Cannot remove origin remote');
  }

  const result = await execGit(['remote', 'remove', '--', remoteName], directory);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to remove remote ${remoteName}`);
  }

  return { success: true };
}


async function canonicalizePath(filePath: string): Promise<string> {
  try {
    const realPath = await fs.promises.realpath(filePath);
    return realPath;
  } catch {
    return path.resolve(filePath);
  }
}

export async function resolveRepositoryPrefix(directory: string): Promise<string> {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }
  const result = await runGitCommand(directoryPath, ['rev-parse', '--show-prefix']);
  if (!result.success) {
    throw new Error(result.stderr || 'Failed to resolve the repository folder');
  }
  return result.stdout.trim().replace(/\/+$/, '');
}

export async function validateWorktreeDirectory(
  directory: string,
  worktreeRoot: string
): Promise<{
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
}> {
  const directoryPath = normalizeDirectoryPath(directory);
  const rootPath = normalizeDirectoryPath(worktreeRoot);

  if (!directoryPath || !rootPath) {
    return { valid: false, insideWorktreeRoot: false, resolvedWorktreeRoot: null, resolvedCwd: null };
  }

  const isRepo = await checkIsGitRepository(directoryPath);
  if (!isRepo) {
    return { valid: false, insideWorktreeRoot: false, resolvedWorktreeRoot: null, resolvedCwd: null };
  }

  const resolvedCwd = await canonicalizePath(directoryPath);
  const resolvedRoot = await canonicalizePath(rootPath);

  const inside = resolvedCwd.startsWith(resolvedRoot + path.sep) || resolvedCwd === resolvedRoot;

  return {
    valid: true,
    insideWorktreeRoot: inside,
    resolvedWorktreeRoot: resolvedRoot,
    resolvedCwd,
  };
}

export async function canonicalizeWorktreeState(
  directory: string
): Promise<{
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}> {
  const directoryPath = normalizeDirectoryPath(directory);

  if (!directoryPath) {
    return {
      worktreeRoot: null, cwd: null, branch: null,
      headState: 'detached', worktreeStatus: 'not-a-repo',
      legacy: false, degraded: false, attentionReason: null,
    };
  }

  const isRepo = await checkIsGitRepository(directoryPath);
  if (!isRepo) {
    return {
      worktreeRoot: null, cwd: null, branch: null,
      headState: 'detached', worktreeStatus: 'not-a-repo',
      legacy: false, degraded: false, attentionReason: null,
    };
  }

  const cwd = await canonicalizePath(directoryPath);

  let worktreeRoot: string | null = null;
  let worktreeStatus: 'ready' | 'missing' | 'invalid' = 'ready';
  let headState: 'branch' | 'detached' | 'unborn' = 'branch';
  let branch: string | null = null;
  let attentionReason: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null = null;

  try {
    const context = await resolveWorktreeProjectContext(directoryPath, { tolerateWorktreeRootConfigError: true });
    worktreeRoot = await canonicalizePath(context.worktreeRoot);
  } catch {
    worktreeStatus = 'invalid';
  }

  try {
    const symbolicRef = await execGit(['symbolic-ref', '-q', 'HEAD'], directoryPath);
    if (symbolicRef.exitCode === 0 && symbolicRef.stdout.trim()) {
      headState = 'branch';
      branch = cleanBranchName(symbolicRef.stdout.trim());
    } else {
      const revParse = await execGit(['rev-parse', 'HEAD'], directoryPath);
      if (revParse.exitCode !== 0 || !revParse.stdout.trim()) {
        headState = 'unborn';
        branch = null;
      } else {
        headState = 'detached';
        branch = revParse.stdout.trim().slice(0, 7);
      }
    }
  } catch {
    headState = 'unborn';
    branch = null;
  }

  try {
    const mergeHead = await execGit(['rev-parse', '--verify', 'MERGE_HEAD'], directoryPath);
    if (mergeHead.exitCode === 0) {
      attentionReason = 'merge';
    } else {
      const fsp = fs.promises;
      const rebaseMerge = await fsp.stat(path.join(directoryPath, '.git', 'rebase-merge')).then(() => true).catch(() => false);
      const rebaseApply = await fsp.stat(path.join(directoryPath, '.git', 'rebase-apply')).then(() => true).catch(() => false);
      if (rebaseMerge || rebaseApply) {
        attentionReason = 'rebase';
      } else {
        const cherryPickHead = await fsp.stat(path.join(directoryPath, '.git', 'CHERRY_PICK_HEAD')).then(() => true).catch(() => false);
        const revertHead = await fsp.stat(path.join(directoryPath, '.git', 'REVERT_HEAD')).then(() => true).catch(() => false);
        if (cherryPickHead) attentionReason = 'cherry-pick';
        else if (revertHead) attentionReason = 'revert';
      }
    }
  } catch {
    // Status check failed — ignore
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
