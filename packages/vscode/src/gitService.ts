/**
 * Git service for VS Code extension
 * Uses VS Code's built-in git extension API for repository operations
 * and raw git commands via child_process for worktree operations
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import type { API as GitAPI, Repository, GitExtension, Status } from './git.d';
import { getGitExecutionEnv } from './git-execution-scope';

let gitApi: GitAPI | null = null;
let gitExtensionEnabled = false;
const worktreeBootstrapState = new Map<string, { status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }>();

const WORKTREE_BOOTSTRAP_PENDING = 'pending' as const;
const WORKTREE_BOOTSTRAP_READY = 'ready' as const;
const WORKTREE_BOOTSTRAP_FAILED = 'failed' as const;

const toBootstrapStateKey = (directory: string): string => {
  const normalized = normalizeDirectoryPath(directory);
  if (!normalized) {
    return '';
  }
  return path.resolve(normalized);
};

const setWorktreeBootstrapState = (directory: string, status: 'pending' | 'ready' | 'failed', error: string | null = null): void => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }
  worktreeBootstrapState.set(key, {
    status,
    error: typeof error === 'string' && error.trim().length > 0 ? error.trim() : null,
    updatedAt: Date.now(),
  });
};

const clearWorktreeBootstrapState = (directory: string): void => {
  const key = toBootstrapStateKey(directory);
  if (!key) {
    return;
  }
  worktreeBootstrapState.delete(key);
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

/**
 * Initialize the git extension API
 */
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

    // Listen for enablement changes
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

/**
 * Get the git API, initializing if necessary
 */
async function getGitApi(): Promise<GitAPI | null> {
  if (gitApi && gitExtensionEnabled) {
    return gitApi;
  }
  return initGitExtension();
}

/**
 * Get repository for a given directory
 */
async function getRepository(directory: string): Promise<Repository | null> {
  const api = await getGitApi();
  if (!api) return null;

  const normalizedDir = normalizePath(directory);
  const uri = vscode.Uri.file(normalizedDir);

  // Try to find an existing repository
  let repo = api.getRepository(uri);
  if (repo) return repo;

  // Try to open the repository
  repo = await api.openRepository(uri);
  return repo;
}

/**
 * Normalize a file path for cross-platform compatibility
 */
function normalizePath(p: string): string {
  let normalized = p;
  // Handle tilde expansion first (before converting slashes)
  if (normalized.startsWith('~')) {
    normalized = path.join(os.homedir(), normalized.slice(1));
  }
  // Convert backslashes to forward slashes for consistent path handling
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

/**
 * Execute a raw git command and return the output
 */
async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const normalizedCwd = normalizePath(cwd);
    const gitPath = gitApi?.git.path || 'git';

    buildGitEnv().then((env) => {
      const proc = spawn(gitPath, args, {
        cwd: normalizedCwd,
        env: { ...env, ...getGitExecutionEnv() },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
      });

      proc.on('error', (error) => {
        resolve({ stdout: '', stderr: error.message, exitCode: 1 });
      });
    }).catch((error) => {
      resolve({ stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 });
    });
  });
}

function isValidCommitHash(hash: string): boolean {
  return /^[0-9a-fA-F]{7,40}$/.test(hash);
}

function extractGitStatusPath(status: string, pathPart: string): string {
  if ((status === 'R' || status === 'C') && pathPart.includes('\t')) {
    return pathPart.split('\t').pop() || pathPart;
  }
  return pathPart;
}

function extractGitNumstatDestinationPath(filePath: string): string {
  if (!filePath.includes(' => ')) {
    return filePath;
  }

  const braceMatch = filePath.match(/^(.*)\{([^{}]*)\s=>\s([^{}]*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, , destination, suffix] = braceMatch;
    return `${prefix}${destination}${suffix}`.replace(/\/+/g, '/');
  }

  return filePath.split(' => ').pop()?.trim() || filePath;
}

// ============== Repository Operations ==============

/**
 * Check if a directory is a git repository
 */
export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const result = await execGit(['rev-parse', '--is-inside-work-tree'], directory);
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

/**
 * Check if a directory is a linked worktree (not the main worktree)
 */
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

// ============== Status Operations ==============

interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

interface GitMergeInProgress {
  /** Short SHA of MERGE_HEAD */
  head: string;
  /** First line of MERGE_MSG */
  message: string;
}

interface GitRebaseInProgress {
  /** Branch name being rebased */
  headName: string;
  /** Short SHA of the onto commit */
  onto: string;
}

export interface GitStatusResult {
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

type GitStatusOptions = {
  mode?: 'light';
};

/**
 * Map VS Code git status to our status codes
 */
function mapStatus(status: Status): string {
  // Status enum values
  const statusMap: Record<number, string> = {
    0: 'M',   // INDEX_MODIFIED
    1: 'A',   // INDEX_ADDED
    2: 'D',   // INDEX_DELETED
    3: 'R',   // INDEX_RENAMED
    4: 'C',   // INDEX_COPIED
    5: 'M',   // MODIFIED
    6: 'D',   // DELETED
    7: '?',   // UNTRACKED
    8: '!',   // IGNORED
    9: 'A',   // INTENT_TO_ADD
    10: 'R',  // INTENT_TO_RENAME
    11: 'T',  // TYPE_CHANGED
    12: 'U',  // ADDED_BY_US
    13: 'U',  // ADDED_BY_THEM
    14: 'U',  // DELETED_BY_US
    15: 'U',  // DELETED_BY_THEM
    16: 'U',  // BOTH_ADDED
    17: 'U',  // BOTH_DELETED
    18: 'U',  // BOTH_MODIFIED
  };
  return statusMap[status] || ' ';
}

function getRepositoryRelativePath(repo: Repository, uri: vscode.Uri): string {
  return path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

/**
 * Get git status for a directory
 */
export async function getGitStatus(directory: string, options?: GitStatusOptions): Promise<GitStatusResult> {
  // The VS Code Git API path does not compute heavyweight diff stats today,
  // but accepts the shared options contract so callers can rely on parity.
  void options;
  const repo = await getRepository(directory);
  
  if (!repo) {
    // Fallback to raw git
    return getGitStatusRaw(directory);
  }

  const state = repo.state;
  const head = state.HEAD;
  
  const files: GitStatusFile[] = [];
  
  // Process index changes (staged)
  for (const change of state.indexChanges) {
    const relativePath = getRepositoryRelativePath(repo, change.uri);
    files.push({
      path: relativePath,
      index: mapStatus(change.status),
      working_dir: ' ',
    });
  }
  
  // Process working tree changes (unstaged)
  for (const change of state.workingTreeChanges) {
    const relativePath = getRepositoryRelativePath(repo, change.uri);
    const existing = files.find(f => f.path === relativePath);
    if (existing) {
      existing.working_dir = mapStatus(change.status);
    } else {
      files.push({
        path: relativePath,
        index: ' ',
        working_dir: mapStatus(change.status),
      });
    }
  }

  // Check for in-progress operations
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

/**
 * Check for in-progress merge/rebase operations
 */
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
    // Check MERGE_HEAD for merge in progress
    const mergeHeadPath = path.join(gitDir, 'MERGE_HEAD');
    const mergeHeadExists = await fs.promises.stat(mergeHeadPath).then(() => true).catch(() => false);
    
    if (mergeHeadExists) {
      const mergeHead = await fs.promises.readFile(mergeHeadPath, 'utf8').catch(() => '');
      const headSha = mergeHead.trim().slice(0, 7);
      // Only set mergeInProgress if we actually have a valid head SHA
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
    // Check for rebase in progress (.git/rebase-merge or .git/rebase-apply)
    const rebaseMergeExists = await fs.promises.stat(path.join(gitDir, 'rebase-merge')).then(() => true).catch(() => false);
    const rebaseApplyExists = await fs.promises.stat(path.join(gitDir, 'rebase-apply')).then(() => true).catch(() => false);
    
    if (rebaseMergeExists || rebaseApplyExists) {
      const rebaseDir = rebaseMergeExists ? 'rebase-merge' : 'rebase-apply';
      const headName = await fs.promises.readFile(path.join(gitDir, rebaseDir, 'head-name'), 'utf8').catch(() => '');
      const onto = await fs.promises.readFile(path.join(gitDir, rebaseDir, 'onto'), 'utf8').catch(() => '');
      
      const headNameTrimmed = headName.trim().replace('refs/heads/', '');
      const ontoTrimmed = onto.trim().slice(0, 7);
      
      // Only set rebaseInProgress if we have valid data
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

/**
 * Fallback: Get git status using raw git commands
 */
async function getGitStatusRaw(directory: string): Promise<GitStatusResult> {
  const statusResult = await execGit(['status', '--porcelain=v1', '-b', '-uall'], directory);
  
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

  const lines = statusResult.stdout.trim().split('\n').filter(Boolean);
  const files: GitStatusFile[] = [];
  let current = '';
  let tracking: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of lines) {
    if (line.startsWith('##')) {
      // Parse branch info
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
      // Parse file status
      const index = line[0] || ' ';
      const workingDir = line[1] || ' ';
      const filePath = line.slice(3).trim();
      files.push({
        path: filePath,
        index,
        working_dir: workingDir,
      });
    }
  }

  // Check for in-progress operations
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

// ============== Branch Operations ==============

interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitBranchResult {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
}

/**
 * Get all branches for a directory
 */
export async function getGitBranches(directory: string): Promise<GitBranchResult> {
  const repo = await getRepository(directory);
  
  if (!repo) {
    return getGitBranchesRaw(directory);
  }

  const state = repo.state;
  const currentBranch = state.HEAD?.name || '';
  const branches: Record<string, GitBranchDetails> = {};
  const all: string[] = [];

  // Get local branches
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

  // Get remote branches
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

  // Add upstream info for HEAD
  if (state.HEAD?.name && state.HEAD?.upstream) {
    const branchInfo = branches[state.HEAD.name];
    if (branchInfo) {
      branchInfo.tracking = `${state.HEAD.upstream.remote}/${state.HEAD.upstream.name}`;
      branchInfo.ahead = state.HEAD.ahead;
      branchInfo.behind = state.HEAD.behind;
    }
  }

  return { all, current: currentBranch, branches };
}

/**
 * Fallback: Get branches using raw git commands
 */
async function getGitBranchesRaw(directory: string): Promise<GitBranchResult> {
  const result = await execGit(['branch', '-a', '-v', '--format=%(refname:short)|%(objectname:short)|%(upstream:short)|%(HEAD)'], directory);
  
  if (result.exitCode !== 0) {
    return { all: [], current: '', branches: {} };
  }

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const branches: Record<string, GitBranchDetails> = {};
  const all: string[] = [];
  let current = '';

  for (const line of lines) {
    const [name, commit, tracking, head] = line.split('|');
    if (name) {
      all.push(name);
      const isCurrent = head === '*';
      if (isCurrent) current = name;
      
      branches[name] = {
        current: isCurrent,
        name,
        commit: commit || '',
        label: name.replace(/^remotes\//, ''),
        tracking: tracking || undefined,
      };
    }
  }

  return { all, current, branches };
}

/**
 * Checkout a branch
 */
export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      await repo.checkout(branch);
      return { success: true, branch };
    } catch (error) {
      console.error('[GitService] Failed to checkout branch:', error);
    }
  }

  // Fallback to raw git
  const result = await execGit(['checkout', branch], directory);
  return { success: result.exitCode === 0, branch };
}

/**
 * Create a new branch
 */
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

  // Fallback to raw git
  const args = ['branch', name];
  if (startPoint) args.push(startPoint);
  const result = await execGit(args, directory);
  return { success: result.exitCode === 0, branch: name };
}

/**
 * Delete a local branch
 */
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

  // Fallback to raw git
  const flag = force ? '-D' : '-d';
  const result = await execGit(['branch', flag, branch], directory);
  return { success: result.exitCode === 0 };
}

/**
 * Delete a remote branch
 */
export async function deleteRemoteBranch(directory: string, branch: string, remote = 'origin'): Promise<{ success: boolean }> {
  const result = await execGit(['push', remote, '--delete', branch], directory);
  return { success: result.exitCode === 0 };
}

// ============== Worktree Operations ==============

export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
  directoryCreated?: true;
  bootstrapStatus?: { status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number };
}

type WorktreeListEntry = {
  worktree: string;
  head?: string;
  branchRef?: string;
  branch?: string;
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
}

type GitBackgroundOperation = 'worktreeAttachment' | 'worktreeBootstrap';

type GitServiceExecutionOptions = {
  scheduleBackground?: (
    request: {
      operation: GitBackgroundOperation;
      contextDirectory: string;
      network: boolean;
    },
    task: () => Promise<void>,
  ) => Promise<void>;
};

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

const parseWorktreePorcelain = (raw: string): WorktreeListEntry[] => {
  const lines = String(raw || '').split('\n').map((line) => line.trim());
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;

  for (const line of lines) {
    if (!line) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = { worktree: line.substring('worktree '.length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.substring('HEAD '.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      const branchRef = line.substring('branch '.length).trim();
      current.branchRef = branchRef;
      current.branch = cleanBranchName(branchRef);
    }
  }

  if (current?.worktree) {
    entries.push(current);
  }

  return entries;
};

const canonicalPath = async (input: string): Promise<string> => {
  const absolutePath = path.resolve(input);
  const realPath = await fs.promises.realpath(absolutePath).catch(() => absolutePath);
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
  if (!parsed) {
    return null;
  }

  if (raw.startsWith('refs/remotes/') || raw.startsWith('remotes/')) {
    return parsed;
  }

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

const resolveWorktreeProjectContext = async (directory: string) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }

  const topResult = await runGitCommandOrThrow(
    directoryPath,
    ['rev-parse', '--show-toplevel'],
    'Failed to resolve git top-level directory'
  );
  const sandbox = path.resolve(directoryPath, topResult.stdout.trim());

  const commonResult = await runGitCommandOrThrow(
    sandbox,
    ['rev-parse', '--git-common-dir'],
    'Failed to resolve git common directory'
  );
  const commonDir = path.resolve(sandbox, commonResult.stdout.trim());
  const primaryWorktree = path.dirname(commonDir);
  const projectID = await ensureOpenCodeProjectId(primaryWorktree);
  const worktreeRoot = path.join(getOpenCodeDataPath(), 'worktree', projectID);

  return { projectID, sandbox, primaryWorktree, worktreeRoot };
};

const listWorktreeEntries = async (directory: string): Promise<WorktreeListEntry[]> => {
  const rawResult = await runGitCommandOrThrow(directory, ['worktree', 'list', '--porcelain'], 'Failed to list git worktrees');
  return parseWorktreePorcelain(rawResult.stdout);
};

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
  await runGitCommandOrThrow(primaryWorktree, ['fetch', remote, refspec], `Failed to fetch ${remote}/${branch}`);
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

const runWorktreeStartCommand = async (directory: string, command: string): Promise<{ success: boolean; message?: string; stdout?: string; stderr?: string }> => {
  const text = String(command || '').trim();
  if (!text) {
    return { success: true };
  }

  const env = await buildGitEnv();
  if (process.platform === 'win32') {
    try {
      const { stdout, stderr } = await execFileAsync('cmd', ['/c', text], {
        cwd: directory,
        env,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { success: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        stdout: err.stdout,
        stderr: err.stderr,
        message: String(err.message || err.stderr || err.stdout || 'Failed to run start command').trim(),
      };
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', text], {
      cwd: directory,
      env,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { success: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      stdout: err.stdout,
      stderr: err.stderr,
      message: String(err.message || err.stderr || err.stdout || 'Failed to run start command').trim(),
    };
  }
};

const loadProjectStartCommand = async (projectID: string): Promise<string> => {
  const storagePath = path.join(getOpenCodeDataPath(), 'storage', 'project', `${projectID}.json`);
  try {
    const raw = await fs.promises.readFile(storagePath, 'utf8');
    const parsed = JSON.parse(raw) as { commands?: { start?: string } };
    const start = typeof parsed?.commands?.start === 'string' ? parsed.commands.start.trim() : '';
    return start || '';
  } catch {
    return '';
  }
};

const getProjectStoragePath = (projectID: string) => {
  return path.join(getOpenCodeDataPath(), 'storage', 'project', `${projectID}.json`);
};

const updateProjectSandboxes = async (
  projectID: string,
  primaryWorktree: string,
  updater: (project: {
    id: string;
    worktree: string;
    vcs: string;
    sandboxes: string[];
    time: { created: number; updated: number };
  }) => void
) => {
  const storagePath = getProjectStoragePath(projectID);
  await fs.promises.mkdir(path.dirname(storagePath), { recursive: true });

  const now = Date.now();
  const base = {
    id: projectID,
    worktree: primaryWorktree,
    vcs: 'git',
    sandboxes: [] as string[],
    time: { created: now, updated: now },
  };

  const parsed = await fs.promises.readFile(storagePath, 'utf8').then((raw) => JSON.parse(raw) as typeof base).catch(() => null);
  const current = parsed && typeof parsed === 'object' ? { ...base, ...parsed } : base;
  current.id = String(current.id || projectID);
  current.worktree = String(current.worktree || primaryWorktree);
  current.vcs = current.vcs || 'git';
  current.sandboxes = Array.isArray(current.sandboxes)
    ? current.sandboxes.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const createdAt = Number(current?.time?.created);
  current.time = {
    created: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
    updated: now,
  };

  updater(current);

  current.sandboxes = [...new Set(current.sandboxes.map((entry) => String(entry || '').trim()).filter(Boolean))];
  await fs.promises.writeFile(storagePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
};

const syncProjectSandboxAdd = async (projectID: string, primaryWorktree: string, sandboxPath: string) => {
  const sandbox = String(sandboxPath || '').trim();
  if (!sandbox) {
    return;
  }
  await updateProjectSandboxes(projectID, primaryWorktree, (project) => {
    if (!project.sandboxes.includes(sandbox)) {
      project.sandboxes.push(sandbox);
    }
  });
};

const syncProjectSandboxRemove = async (projectID: string, primaryWorktree: string, sandboxPath: string) => {
  const sandbox = String(sandboxPath || '').trim();
  if (!sandbox) {
    return;
  }
  await updateProjectSandboxes(projectID, primaryWorktree, (project) => {
    project.sandboxes = project.sandboxes.filter((entry) => entry !== sandbox);
  });
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

  if (!isAttached) {
    try {
      await syncProjectSandboxRemove(context.projectID, context.primaryWorktree, candidateDirectory);
    } catch (error) {
      console.warn('[GitService] Failed to clean up OpenCode sandbox metadata after worktree failure:', error instanceof Error ? error.message : String(error));
    }
  }

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

const runWorktreeStartScripts = async (directory: string, projectID: string, startCommand: string | undefined) => {
  const projectStart = await loadProjectStartCommand(projectID);
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
  projectID: string;
  primaryWorktree: string;
  localBranch: string;
  setUpstream: boolean;
  upstreamRemote: string;
  upstreamBranch: string;
  ensureRemoteName: string;
  ensureRemoteUrl: string;
  startCommand: string | undefined;
}, execution: GitServiceExecutionOptions = {}) => {
  const {
    directory,
    projectID,
    primaryWorktree,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand,
  } = args;
  const run = async () => {
    await runGitCommandOrThrow(directory, ['reset', '--hard'], 'Failed to populate worktree');
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
    await runWorktreeStartScripts(directory, projectID, startCommand).catch((error) => {
      console.warn('[GitService] Worktree start script task failed:', error instanceof Error ? error.message : String(error));
    });
    setWorktreeBootstrapState(directory, WORKTREE_BOOTSTRAP_READY);
  };

  const fail = (error: unknown) => {
    setWorktreeBootstrapState(
      directory,
      WORKTREE_BOOTSTRAP_FAILED,
      error instanceof Error ? error.message : String(error)
    );
    console.warn('[GitService] Worktree bootstrap task failed:', error instanceof Error ? error.message : String(error));
  };

  if (execution.scheduleBackground) {
    void execution.scheduleBackground({
      operation: 'worktreeBootstrap',
      contextDirectory: directory,
      network: setUpstream || Boolean(ensureRemoteName && ensureRemoteUrl),
    }, run).catch(fail);
    return;
  }

  setTimeout(() => {
    void run().catch((error) => {
      fail(error);
    });
  }, 0);
};

const ensureRemoteWithUrl = async (primaryWorktree: string, remoteName: string, remoteUrl: string) => {
  const name = String(remoteName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!name || !url) {
    return;
  }

  const getUrl = await runGitCommand(primaryWorktree, ['remote', 'get-url', name]);
  if (getUrl.success) {
    const currentUrl = String(getUrl.stdout || '').trim();
    if (currentUrl !== url) {
      await runGitCommandOrThrow(primaryWorktree, ['remote', 'set-url', name, url], 'Failed to update git remote URL');
    }
    return;
  }

  await runGitCommandOrThrow(primaryWorktree, ['remote', 'add', name, url], 'Failed to add git remote');
};

const checkRemoteBranchExists = async (primaryWorktree: string, remoteName: string, branchName: string, remoteUrl = '') => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!remote || !branch) {
    return { success: false, found: false };
  }

  const target = url || remote;
  const lsRemote = await runGitCommand(primaryWorktree, ['ls-remote', '--heads', target, `refs/heads/${branch}`]);
  if (!lsRemote.success) {
    return { success: false, found: false };
  }

  return {
    success: true,
    found: Boolean(String(lsRemote.stdout || '').trim()),
  };
};

const setBranchTrackingFallback = async (worktreeDirectory: string, localBranch: string, upstream: { remote: string; branch: string }) => {
  await runGitCommandOrThrow(
    worktreeDirectory,
    ['config', `branch.${localBranch}.remote`, upstream.remote],
    `Failed to set branch.${localBranch}.remote`
  );
  await runGitCommandOrThrow(
    worktreeDirectory,
    ['config', `branch.${localBranch}.merge`, `refs/heads/${upstream.branch}`],
    `Failed to set branch.${localBranch}.merge`
  );
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

  let fetched = true;
  try {
    await fetchRemoteBranchRef(primaryWorktree, upstream.remote, upstream.branch);
  } catch {
    fetched = false;
  }

  if (fetched) {
    await runGitCommandOrThrow(
      worktreeDirectory,
      ['branch', `--set-upstream-to=${upstream.full}`, localBranch],
      `Failed to set upstream to ${upstream.full}`
    );
    return;
  }

  await setBranchTrackingFallback(worktreeDirectory, localBranch, upstream);
};

/**
 * List all worktrees for a repository
 */
export async function listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]> {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !fs.existsSync(directoryPath) || !fs.existsSync(path.join(directoryPath, '.git'))) {
    return [];
  }

  try {
    const result = await runGitCommandOrThrow(directoryPath, ['worktree', 'list', '--porcelain'], 'Failed to list git worktrees');
    return parseWorktreePorcelain(result.stdout).map((entry) => ({
      head: entry.head || '',
      name: path.basename(entry.worktree || ''),
      branch: entry.branch || '',
      path: entry.worktree,
    }));
  } catch (error) {
    console.warn('[GitService] Failed to list worktrees, returning empty list:', error instanceof Error ? error.message : String(error));
    return [];
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
            ['ls-remote', '--heads', ensureRemoteUrl, `refs/heads/${parsedExistingRemote.branch}`]
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
        const remoteExists = await runGitCommand(context.primaryWorktree, ['remote', 'get-url', upstreamRemote]);
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

async function attachGitWorktreeToCandidate(
  context: Awaited<ReturnType<typeof resolveWorktreeProjectContext>>,
  candidate: { name: string; directory: string; branch: string },
  input: CreateGitWorktreePayload = {},
  execution: GitServiceExecutionOptions = {},
): Promise<GitWorktreeInfo> {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const startRef = normalizeStartRef(input?.startRef);
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

  let localBranch = '';
  let inferredUpstream: { remote: string; branch: string } | null = null;
  const worktreeAddArgs = ['worktree', 'add', '--no-checkout'];

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
      inferredUpstream = {
        remote: parsedRemoteStartRef.remote,
        branch: parsedRemoteStartRef.branch,
      };
    }
  }

  if (ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(context.primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  if (mode === 'new') {
    const parsedRemoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
    if (parsedRemoteStartRef) {
      await fetchRemoteBranchRef(context.primaryWorktree, parsedRemoteStartRef.remote, parsedRemoteStartRef.branch);
    }
  }

  await runGitCommandOrThrow(context.primaryWorktree, worktreeAddArgs, 'Failed to create git worktree');

  try {
    await syncProjectSandboxAdd(context.projectID, context.primaryWorktree, candidate.directory);
  } catch (error) {
    console.warn('[GitService] Failed to sync OpenCode sandbox metadata (add):', error instanceof Error ? error.message : String(error));
  }

  const shouldSetUpstream = Boolean(input?.setUpstream);
  const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
  const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

  setWorktreeBootstrapState(candidate.directory, WORKTREE_BOOTSTRAP_PENDING);
  const bootstrapStatus = worktreeBootstrapState.get(toBootstrapStateKey(candidate.directory)) ?? {
    status: WORKTREE_BOOTSTRAP_PENDING,
    error: null,
    updatedAt: Date.now(),
  };

  queueWorktreeBootstrap({
    directory: candidate.directory,
    projectID: context.projectID,
    primaryWorktree: context.primaryWorktree,
    localBranch,
    setUpstream: shouldSetUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand: input?.startCommand,
  }, execution);

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

export async function createWorktree(
  directory: string,
  input: CreateGitWorktreePayload = {},
  execution: GitServiceExecutionOptions = {},
): Promise<GitWorktreeInfo> {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);

  if (input?.returnAfterDirectoryCreated === true) {
    await assertWorktreeCreatePreflight(directory, input);
  }

  await fs.promises.mkdir(context.worktreeRoot, { recursive: true });

  const preferredName = String(input?.worktreeName || input?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());

  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  if (input?.returnAfterDirectoryCreated === true) {
    await fs.promises.mkdir(candidate.directory, { recursive: false });

    try {
      await syncProjectSandboxAdd(context.projectID, context.primaryWorktree, candidate.directory);
    } catch (error) {
      console.warn('[GitService] Failed to sync OpenCode sandbox metadata (add):', error instanceof Error ? error.message : String(error));
    }

    setWorktreeBootstrapState(candidate.directory, WORKTREE_BOOTSTRAP_PENDING);
    const bootstrapStatus = worktreeBootstrapState.get(toBootstrapStateKey(candidate.directory)) ?? {
      status: WORKTREE_BOOTSTRAP_PENDING,
      error: null,
      updatedAt: Date.now(),
    };
    const localBranch = mode === 'existing'
      ? cleanBranchName(String(input?.branchName || input?.existingBranch || candidate.branch || '').trim())
      : candidate.branch;

    const attach = async () => {
      await attachGitWorktreeToCandidate(context, candidate, input, execution);
    };
    const fail = (error: unknown) => {
      setWorktreeBootstrapState(
        candidate.directory,
        WORKTREE_BOOTSTRAP_FAILED,
        error instanceof Error ? error.message : String(error)
      );
      void cleanupFailedFastWorktreeCreate(context, candidate);
      console.warn('[GitService] Background worktree creation failed:', error instanceof Error ? error.message : String(error));
    };

    if (execution.scheduleBackground) {
      const remoteRef = String(input?.existingBranch || input?.startRef || '').trim();
      void execution.scheduleBackground({
        operation: 'worktreeAttachment',
        contextDirectory: context.primaryWorktree,
        network: Boolean(
          input?.setUpstream
          || (input?.ensureRemoteName && input?.ensureRemoteUrl)
          || remoteRef.startsWith('refs/remotes/')
          || remoteRef.startsWith('remotes/')
          || remoteRef.includes('/')
        ),
      }, attach).catch(fail);
    } else {
      void attach().catch(fail);
    }

    return {
      head: '',
      name: candidate.name,
      branch: localBranch,
      path: candidate.directory,
      directoryCreated: true,
      bootstrapStatus,
    };
  }

  return attachGitWorktreeToCandidate(context, candidate, input, execution);
}

export async function getWorktreeBootstrapStatus(directory: string): Promise<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> {
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
    error: null,
    updatedAt: Date.now(),
  };
}

export async function removeWorktree(directory: string, input: RemoveGitWorktreePayload): Promise<boolean> {
  const targetDirectory = normalizeDirectoryPath(input?.directory);
  if (!targetDirectory) {
    throw new Error('Worktree directory is required');
  }

  const context = await resolveWorktreeProjectContext(directory);
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

  if (!matchedEntry?.worktree) {
    const targetExists = await checkPathExists(targetDirectory);
    if (targetExists) {
      await fs.promises.rm(targetDirectory, { recursive: true, force: true });
    }

    try {
      await syncProjectSandboxRemove(context.projectID, context.primaryWorktree, targetDirectory);
    } catch (error) {
      console.warn('[GitService] Failed to sync OpenCode sandbox metadata (remove):', error instanceof Error ? error.message : String(error));
    }

    clearWorktreeBootstrapState(targetDirectory);

    return true;
  }

  await runGitCommandOrThrow(
    context.primaryWorktree,
    ['worktree', 'remove', '--force', matchedEntry.worktree],
    'Failed to remove git worktree'
  );

  if (deleteLocalBranch) {
    const branchName = cleanBranchName(String(matchedEntry.branchRef || matchedEntry.branch || '').trim());
    if (branchName) {
      await runGitCommandOrThrow(
        context.primaryWorktree,
        ['branch', '-D', branchName],
        `Failed to delete local branch ${branchName}`
      );
    }
  }

  try {
    await syncProjectSandboxRemove(context.projectID, context.primaryWorktree, matchedEntry.worktree);
  } catch (error) {
    console.warn('[GitService] Failed to sync OpenCode sandbox metadata (remove):', error instanceof Error ? error.message : String(error));
  }

  clearWorktreeBootstrapState(matchedEntry.worktree);

  return true;
}

// ============== Diff Operations ==============

/**
 * Get diff for a file
 */
export async function getGitDiff(
  directory: string, 
  filePath: string, 
  staged = false,
  contextLines?: number
): Promise<{ diff: string }> {
  const args = ['diff'];
  if (staged) args.push('--cached');
  if (typeof contextLines === 'number') args.push(`-U${contextLines}`);
  args.push('--', filePath);

  const result = await execGit(args, directory);
  return { diff: result.stdout };
}

/**
 * Get diff between two refs for a file (base...head).
 */
export async function getGitRangeDiff(
  directory: string,
  base: string,
  head: string,
  filePath: string,
  contextLines = 3
): Promise<{ diff: string }> {
  const baseRef = (base || '').trim();
  const headRef = (head || '').trim();
  if (!baseRef || !headRef) {
    return { diff: '' };
  }

  let resolvedBase = baseRef;
  try {
    const verify = await execGit(['rev-parse', '--verify', `refs/remotes/origin/${baseRef}`], directory);
    if (verify.exitCode === 0) {
      resolvedBase = `origin/${baseRef}`;
    }
  } catch {
    // ignore
  }

  const args = ['diff', '--no-color', `-U${Math.max(0, contextLines)}`, `${resolvedBase}...${headRef}`, '--', filePath];
  const result = await execGit(args, directory);
  return { diff: result.stdout };
}

/**
 * List files changed between two refs (base...head).
 */
export async function getGitRangeFiles(
  directory: string,
  base: string,
  head: string
): Promise<string[]> {
  const baseRef = (base || '').trim();
  const headRef = (head || '').trim();
  if (!baseRef || !headRef) {
    return [];
  }

  let resolvedBase = baseRef;
  try {
    const verify = await execGit(['rev-parse', '--verify', `refs/remotes/origin/${baseRef}`], directory);
    if (verify.exitCode === 0) {
      resolvedBase = `origin/${baseRef}`;
    }
  } catch {
    // ignore
  }

  const args = ['diff', '--name-only', `${resolvedBase}...${headRef}`];
  const result = await execGit(args, directory);
  if (result.exitCode !== 0) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Get file diff with original and modified content
 */
export async function getGitFileDiff(
  directory: string, 
  filePath: string, 
  staged = false
): Promise<{ original: string; modified: string; path: string }> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      // For staged files, get content from HEAD
      // For unstaged files, get content from index (staged) or HEAD
      let original: string;
      if (staged) {
        original = await repo.show('HEAD', filePath);
      } else {
        try {
          // Try to get from index first
          original = await repo.show(':0:' + filePath, filePath);
        } catch {
          // Fall back to HEAD
          original = await repo.show('HEAD', filePath);
        }
      }
      
      let modified: string;
      if (staged) {
        const stagedResult = await execGit(['show', `:${filePath}`], directory);
        modified = stagedResult.exitCode === 0 ? stagedResult.stdout : '';
      } else {
        const fileUri = vscode.Uri.file(path.join(directory, filePath));
        const modifiedBytes = await vscode.workspace.fs.readFile(fileUri);
        modified = Buffer.from(modifiedBytes).toString('utf8');
      }
      
      return { original, modified, path: filePath };
    } catch (error) {
      console.error('[GitService] Failed to get file diff:', error);
    }
  }

  // Fallback: return empty content
  return { original: '', modified: '', path: filePath };
}

/**
 * Revert a file to its last committed state
 */
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

  // During rapid stage/unstage toggling the optimistic UI can request staging a
  // path that a prior queued mutation already staged (most visibly a deletion,
  // whose file is gone from the working tree). `git add` aborts the whole batch on
  // a single unmatched pathspec, so retry per-path and skip the ones already in
  // their target state rather than failing the entire "stage all".
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

/**
 * Apply a single-hunk patch to stage, unstage, or discard it.
 * The patch is written to a temp file and applied with `git apply`.
 */
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

// ============== Commit Operations ==============

export interface GitCommitResult {
  success: boolean;
  commit: string;
  branch: string;
  summary: {
    changes: number;
    insertions: number;
    deletions: number;
  };
}

/**
 * Create a git commit
 */
export async function createGitCommit(
  directory: string,
  message: string,
  options?: { addAll?: boolean; files?: string[]; stageFiles?: string[] }
): Promise<GitCommitResult> {
  if (options?.files?.length && options.stageFiles) {
    const selectedFiles = new Set(options.files);
    const stagedResult = await execGit(['diff', '--cached', '--name-only'], directory);
    const temporarilyUnstagedFiles = stagedResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((filePath) => filePath && !selectedFiles.has(filePath));

    try {
      if (temporarilyUnstagedFiles.length > 0) {
        await execGit(['restore', '--staged', '--', ...temporarilyUnstagedFiles], directory);
      }
      if (options.stageFiles.length > 0) {
        await execGit(['add', '--', ...options.stageFiles], directory);
      }

      const result = await execGit(['commit', '-m', message], directory);
      if (result.exitCode !== 0) {
        return {
          success: false,
          commit: '',
          branch: '',
          summary: { changes: 0, insertions: 0, deletions: 0 },
        };
      }

      const hashResult = await execGit(['rev-parse', 'HEAD'], directory);
      const branchResult = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], directory);
      return {
        success: true,
        commit: hashResult.stdout.trim(),
        branch: branchResult.stdout.trim(),
        summary: { changes: 0, insertions: 0, deletions: 0 },
      };
    } finally {
      if (temporarilyUnstagedFiles.length > 0) {
        await execGit(['add', '--', ...temporarilyUnstagedFiles], directory);
      }
    }
  }

  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      if (options?.addAll) {
        await repo.add(['.']);
      } else if (options?.files?.length) {
        const filesToStage = options.stageFiles ?? options.files;
        if (filesToStage.length > 0) {
          await repo.add(filesToStage);
        }
      }
      
      await repo.commit(message);
      
      const head = repo.state.HEAD;
      return {
        success: true,
        commit: head?.commit || '',
        branch: head?.name || '',
        summary: { changes: 0, insertions: 0, deletions: 0 },
      };
    } catch (error) {
      console.error('[GitService] Failed to commit:', error);
    }
  }

  // Fallback to raw git
  if (options?.addAll) {
    await execGit(['add', '-A'], directory);
  } else if (options?.files?.length) {
    const filesToStage = options.stageFiles ?? options.files;
    if (filesToStage.length > 0) {
      await execGit(['add', ...filesToStage], directory);
    }
  }

  const result = await execGit(['commit', '-m', message], directory);
  
  if (result.exitCode !== 0) {
    return {
      success: false,
      commit: '',
      branch: '',
      summary: { changes: 0, insertions: 0, deletions: 0 },
    };
  }

  // Get commit info
  const hashResult = await execGit(['rev-parse', 'HEAD'], directory);
  const branchResult = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], directory);

  return {
    success: true,
    commit: hashResult.stdout.trim(),
    branch: branchResult.stdout.trim(),
    summary: { changes: 0, insertions: 0, deletions: 0 },
  };
}

// ============== Remote Operations ==============

/**
 * Convert options to an array of git arguments.
 * Supports both array format ['--set-upstream', '--force'] and 
 * object format { '--set-upstream': null, '--force': true }
 */
function normalizeGitOptions(options?: string[] | Record<string, unknown>): string[] {
  if (!options) return [];
  
  if (Array.isArray(options)) {
    return options;
  }
  
  // Object format: { '--set-upstream': null, '--force': true, '--remote': 'origin' }
  const args: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === null || value === true) {
      args.push(key);
    } else if (value !== false && value !== undefined) {
      args.push(key, String(value));
    }
  }
  return args;
}

/**
 * Check if options contain a specific flag
 */
function hasOption(options: string[] | Record<string, unknown> | undefined, flag: string): boolean {
  if (!options) return false;
  
  if (Array.isArray(options)) {
    return options.includes(flag);
  }
  
  return flag in options && options[flag] !== false;
}

/**
 * Push to remote
 */
export async function gitPush(
  directory: string,
  options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }
): Promise<{ success: boolean; pushed: Array<{ local: string; remote: string }>; repo: string; ref: unknown }> {
  const remote = options?.remote?.trim();
  const branch = options?.branch;
  const gitOptions = options?.options;

  const describePushFailure = (value: unknown): string => {
    const message = String(
      (value as { message?: string } | undefined)?.message ||
      (value as { stderr?: string } | undefined)?.stderr ||
      (value as { stdout?: string } | undefined)?.stdout ||
      ''
    ).trim();
    return message || 'Failed to push to remote';
  };

  const buildUpstreamOptions = (raw?: string[] | Record<string, unknown>): string[] => {
    const normalized = normalizeGitOptions(raw);
    if (hasOption(normalized, '--set-upstream') || hasOption(normalized, '-u')) {
      return normalized;
    }
    return [...normalized, '--set-upstream'];
  };

  const looksLikeMissingUpstream = (value: unknown): boolean => {
    const message = String(
      (value as { message?: string } | undefined)?.message ||
      (value as { stderr?: string } | undefined)?.stderr ||
      ''
    ).toLowerCase();
    return (
      message.includes('has no upstream') ||
      message.includes('no upstream') ||
      message.includes('set-upstream') ||
      message.includes('set upstream') ||
      (message.includes('upstream') && message.includes('push') && message.includes('-u'))
    );
  };

  const getCurrentBranch = async (): Promise<string> => {
    const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], directory);
    return String(result.stdout || '').trim();
  };

  const hasTrackingBranch = async (): Promise<boolean> => {
    const result = await execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], directory);
    return result.exitCode === 0 && Boolean(String(result.stdout || '').trim());
  };

  const getRemotes = async (): Promise<string[]> => {
    const result = await execGit(['remote'], directory);
    if (result.exitCode !== 0) {
      return [];
    }
    return String(result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  };

  const pushRaw = async (args: string[]) => {
    const result = await execGit(args, directory);
    if (result.exitCode !== 0) {
      throw new Error(describePushFailure(result));
    }
  };

  const normalizePushResult = (local: string, remoteName: string) => ({
    success: true,
    pushed: [{ local, remote: remoteName }],
    repo: directory,
    ref: null,
  });

  if (!remote && !branch) {
    try {
      const args = ['push'];
      const normalizedOptions = normalizeGitOptions(gitOptions);
      if (normalizedOptions.length > 0) {
        args.push(...normalizedOptions);
      }
      await pushRaw(args);
      return {
        success: true,
        pushed: [],
        repo: directory,
        ref: null,
      };
    } catch (error) {
      if (!looksLikeMissingUpstream(error)) {
        throw new Error(describePushFailure(error));
      }

      const currentBranch = await getCurrentBranch();
      const remotes = await getRemotes();
      const fallbackRemote = remotes.includes('origin') ? 'origin' : remotes[0];
      if (!currentBranch || !fallbackRemote) {
        throw new Error(describePushFailure(error));
      }

      const args = ['push', ...buildUpstreamOptions(gitOptions), fallbackRemote, currentBranch];
      await pushRaw(args);
      return normalizePushResult(currentBranch, fallbackRemote);
    }
  }

  const remoteName = remote || 'origin';

  if (!branch) {
    try {
      const currentBranch = await getCurrentBranch();
      const tracking = await hasTrackingBranch();
      if (currentBranch && !tracking) {
        const args = ['push', ...buildUpstreamOptions(gitOptions), remoteName, currentBranch];
        await pushRaw(args);
        return normalizePushResult(currentBranch, remoteName);
      }
    } catch (error) {
      console.warn('[GitService] Failed to determine upstream state before push:', error);
    }
  }

  try {
    const args = ['push', ...normalizeGitOptions(gitOptions), remoteName];
    if (branch) {
      args.push(branch);
    }
    await pushRaw(args);
    return normalizePushResult(branch || '', remoteName);
  } catch (error) {
    if (!looksLikeMissingUpstream(error)) {
      throw new Error(describePushFailure(error));
    }

    const fallbackBranch = branch || await getCurrentBranch();
    if (!fallbackBranch) {
      throw new Error(describePushFailure(error));
    }

    const args = ['push', ...buildUpstreamOptions(gitOptions), remoteName, fallbackBranch];
    await pushRaw(args);
    return normalizePushResult(fallbackBranch, remoteName);
  }
}

/**
 * Pull from remote
 */
export async function gitPull(
  directory: string,
  options?: { remote?: string; branch?: string; rebase?: boolean }
): Promise<{ success: boolean; summary: { changes: number; insertions: number; deletions: number }; files: string[]; insertions: number; deletions: number }> {
  const repo = await getRepository(directory);
  
  if (repo && options?.rebase !== true) {
    try {
      await repo.pull();
      return {
        success: true,
        summary: { changes: 0, insertions: 0, deletions: 0 },
        files: [],
        insertions: 0,
        deletions: 0,
      };
    } catch (error) {
      console.error('[GitService] Failed to pull:', error);
    }
  }

  // Fallback to raw git
  const beforeHead = await execGit(['rev-parse', 'HEAD'], directory);
  const args = ['pull'];
  if (options?.rebase === true) args.push('--rebase');
  if (options?.remote) args.push(options.remote);
  if (options?.branch) args.push(options.branch);

  const result = await execGit(args, directory);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to pull from remote');
  }
  const afterHead = await execGit(['rev-parse', 'HEAD'], directory);
  const before = beforeHead.exitCode === 0 ? beforeHead.stdout.trim() : '';
  const after = afterHead.exitCode === 0 ? afterHead.stdout.trim() : '';
  const changedFiles = before && after && before !== after
    ? await execGit(['diff', '--name-only', before, after], directory)
    : { stdout: '', stderr: '', exitCode: 0 };
  const files = changedFiles.exitCode === 0
    ? changedFiles.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];

  return {
    success: result.exitCode === 0,
    summary: { changes: files.length, insertions: 0, deletions: 0 },
    files,
    insertions: 0,
    deletions: 0,
  };
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
      const names = await execGit(['stash', 'show', '--name-only', ref], directory);
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
  // Prefer --index so the staged/unstaged split captured in the stash is restored
  // faithfully. Fall back to a plain apply when the index can't be reinstated
  // cleanly (e.g. conflicts), which is the prior behavior.
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

/**
 * Fetch from remote
 */
export async function gitFetch(
  directory: string,
  options?: { remote?: string; branch?: string }
): Promise<{ success: boolean }> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      await repo.fetch({ remote: options?.remote, ref: options?.branch });
      return { success: true };
    } catch (error) {
      console.error('[GitService] Failed to fetch:', error);
    }
  }

  // Fallback to raw git
  const args = ['fetch'];
  if (options?.remote) args.push(options.remote);
  if (options?.branch) args.push(options.branch);

  const result = await execGit(args, directory);
  return { success: result.exitCode === 0 };
}

// ============== Log Operations ==============

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

/**
 * Resolve a log base ref using local-first semantics (mirrors web service.js).
 *
 * - Returns undefined when `from` is falsy/whitespace.
 * - Returns `from` unchanged when the local ref resolves.
 * - Returns `origin/<from>` when local is absent but the remote-tracking ref exists.
 * - Returns `from` unchanged when neither resolves (lets git surface the error).
 */
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

/**
 * Get git log
 */
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

  // Prefer the local ref; fall back to origin/<from> only when the local ref
  // cannot be resolved (e.g. user has never checked out the base branch).
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
    // Need to re-parse header fields for the final entries array
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

/**
 * Get files changed in a commit
 */
export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<{ files: Array<{ path: string; insertions: number; deletions: number; isBinary: boolean; changeType: string }> }> {
  const numstatResult = await execGit(['show', '--numstat', '--format=', hash], directory);

  if (numstatResult.exitCode !== 0) {
    return { files: [] };
  }

  const files: Array<{ path: string; insertions: number; deletions: number; isBinary: boolean; changeType: string }> = [];
  const lines = numstatResult.stdout.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [insertionsRaw, deletionsRaw, ...pathParts] = parts;
    const filePath = pathParts.join('\t');
    if (!filePath) continue;

    const isBinary = insertionsRaw === '-' && deletionsRaw === '-';
    const insertions = isBinary ? 0 : (parseInt(insertionsRaw, 10) || 0);
    const deletions = isBinary ? 0 : (parseInt(deletionsRaw, 10) || 0);

    let changeType = 'M';
    if (filePath.includes(' => ')) {
      changeType = 'R';
    }

    files.push({ path: filePath, insertions, deletions, isBinary, changeType });
  }

  // Get accurate change types from --name-status
  const nameStatusResult = await execGit(['show', '--name-status', '--format=', hash], directory);
  if (nameStatusResult.exitCode === 0) {
    const statusMap = new Map<string, string>();
    for (const line of nameStatusResult.stdout.trim().split('\n').filter(Boolean)) {
      const match = line.match(/^([AMDRC])\d*\t(.+)$/);
      if (match) {
        const [, status, pathPart] = match;
        statusMap.set(extractGitStatusPath(status, pathPart), status);
      }
    }
    for (const file of files) {
      const basePath = extractGitNumstatDestinationPath(file.path);
      const status = statusMap.get(basePath) ?? statusMap.get(file.path);
      if (status) {
        file.changeType = status;
      }
    }
  }

  return { files };
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<{ original: string; modified: string; isBinary: boolean }> {
  if (isBinary) {
    return { original: '', modified: '', isBinary: true };
  }

  const [originalResult, modifiedResult] = await Promise.all([
    execGit(['show', `${hash}^:${filePath}`], directory),
    execGit(['show', `${hash}:${filePath}`], directory),
  ]);

  if (originalResult.exitCode !== 0 && modifiedResult.exitCode !== 0) {
    throw new Error(`Failed to read file content at commit ${hash}`);
  }

  return {
    original: originalResult.exitCode === 0 ? originalResult.stdout : '',
    modified: modifiedResult.exitCode === 0 ? modifiedResult.stdout : '',
    isBinary: false,
  };
}

// ============== Git Identity Operations ==============

export interface GitIdentitySummary {
  userName: string | null;
  userEmail: string | null;
  sshCommand: string | null;
}

/**
 * Get current git identity for a directory
 */
export async function getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      const userName = await repo.getConfig('user.name').catch(() => '');
      const userEmail = await repo.getConfig('user.email').catch(() => '');
      const sshCommand = await repo.getConfig('core.sshCommand').catch(() => '');
      
      return {
        userName: userName || null,
        userEmail: userEmail || null,
        sshCommand: sshCommand || null,
      };
    } catch (error) {
      console.error('[GitService] Failed to get identity:', error);
    }
  }

  // Fallback to raw git
  const nameResult = await execGit(['config', 'user.name'], directory);
  const emailResult = await execGit(['config', 'user.email'], directory);
  const sshResult = await execGit(['config', 'core.sshCommand'], directory);

  return {
    userName: nameResult.exitCode === 0 ? nameResult.stdout.trim() : null,
    userEmail: emailResult.exitCode === 0 ? emailResult.stdout.trim() : null,
    sshCommand: sshResult.exitCode === 0 ? sshResult.stdout.trim() : null,
  };
}

/**
 * Escape an SSH key path for use in core.sshCommand.
 * Handles Windows/Unix differences and prevents command injection.
 */
function escapeSshKeyPath(sshKeyPath: string): string {
  // Validate: reject paths with characters that could enable injection
  // Allow only alphanumeric, path separators, dots, dashes, underscores, spaces, and colons (for Windows drives)
  const dangerousChars = /[`$\\!"';&|<>(){}[\]*?#~]/;
  if (dangerousChars.test(sshKeyPath)) {
    throw new Error(`SSH key path contains invalid characters: ${sshKeyPath}`);
  }

  const isWindows = process.platform === 'win32';
  
  if (isWindows) {
    // On Windows, Git (via MSYS/MinGW) expects Unix-style paths
    // Convert backslashes to forward slashes and handle drive letters
    let unixPath = sshKeyPath.replace(/\\/g, '/');
    
    // Convert "C:/path" to "/c/path" for MSYS compatibility
    const driveMatch = unixPath.match(/^([A-Za-z]):\//);
    if (driveMatch) {
      unixPath = `/${driveMatch[1].toLowerCase()}${unixPath.slice(2)}`;
    }
    
    // Use single quotes for the path (prevents shell interpretation)
    return `'${unixPath}'`;
  } else {
    // On Unix, use single quotes and escape any single quotes in the path
    // Single quotes prevent all shell interpretation except for single quotes themselves
    const escaped = sshKeyPath.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
}

/**
 * Build the SSH command string for git config
 */
function buildSshCommand(sshKeyPath: string): string {
  const escapedPath = escapeSshKeyPath(sshKeyPath);
  return `ssh -i ${escapedPath} -o IdentitiesOnly=yes`;
}

/**
 * Set git identity for a directory
 */
export async function setGitIdentity(
  directory: string,
  userName: string,
  userEmail: string,
  sshKey?: string | null,
  signCommits?: boolean | null,
  signingKey?: string | null
): Promise<{ success: boolean }> {
  const repo = await getRepository(directory);
  
  // Build SSH command once if needed
  const sshCommand = sshKey ? buildSshCommand(sshKey) : null;
  const shouldSignCommits = signCommits === true && typeof signingKey === 'string' && signingKey.trim().length > 0;
  
  if (repo) {
    try {
      await repo.setConfig('user.name', userName);
      await repo.setConfig('user.email', userEmail);
      if (sshCommand) {
        await repo.setConfig('core.sshCommand', sshCommand);
      }
      if (shouldSignCommits) {
        await repo.setConfig('gpg.format', 'ssh');
        await repo.setConfig('user.signingkey', signingKey.trim());
        await repo.setConfig('commit.gpgsign', 'true');
      }
      return { success: true };
    } catch (error) {
      console.error('[GitService] Failed to set identity:', error);
    }
  }

  // Fallback to raw git
  await execGit(['config', 'user.name', userName], directory);
  await execGit(['config', 'user.email', userEmail], directory);
  if (sshCommand) {
    await execGit(['config', 'core.sshCommand', sshCommand], directory);
  }
  if (shouldSignCommits) {
    await execGit(['config', 'gpg.format', 'ssh'], directory);
    await execGit(['config', 'user.signingkey', signingKey.trim()], directory);
    await execGit(['config', 'commit.gpgsign', 'true'], directory);
  }

  return { success: true };
}

// ============== Remote Operations ==============

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * Get list of remotes
 */
export async function getRemotes(directory: string): Promise<GitRemote[]> {
  const result = await execGit(['remote', '-v'], directory);
  if (result.exitCode !== 0) {
    return [];
  }

  const remoteMap = new Map<string, GitRemote>();
  const lines = result.stdout.split('\n').filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (match) {
      const [, name, url, type] = match;
      if (!remoteMap.has(name)) {
        remoteMap.set(name, { name, fetchUrl: '', pushUrl: '' });
      }
      const remote = remoteMap.get(name)!;
      if (type === 'fetch') {
        remote.fetchUrl = url;
      } else {
        remote.pushUrl = url;
      }
    }
  }

  return Array.from(remoteMap.values());
}

export async function removeRemote(directory: string, remote: string): Promise<{ success: boolean }> {
  const remoteName = String(remote || '').trim();
  if (!remoteName) {
    throw new Error('Remote name is required');
  }
  if (remoteName === 'origin') {
    throw new Error('Cannot remove origin remote');
  }

  const result = await execGit(['remote', 'remove', remoteName], directory);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to remove remote ${remoteName}`);
  }

  return { success: true };
}

// ============== Merge & Rebase Operations ==============

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

/**
 * Rebase current branch onto target
 */
export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<GitRebaseResult> {
  const result = await execGit(['rebase', options.onto], directory);

  if (result.exitCode === 0) {
    return { success: true, conflict: false };
  }

  const output = (result.stdout + result.stderr).toLowerCase();
  const isConflict =
    output.includes('conflict') ||
    output.includes('could not apply') ||
    output.includes('merge conflict');

  if (isConflict) {
    const statusResult = await execGit(['status', '--porcelain'], directory);
    const conflictFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());

    return { success: false, conflict: true, conflictFiles };
  }

  throw new Error(result.stderr || 'Rebase failed');
}

/**
 * Abort an in-progress rebase
 */
export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const result = await execGit(['rebase', '--abort'], directory);
  return { success: result.exitCode === 0 };
}

/**
 * Merge branch into current
 */
export async function merge(
  directory: string,
  options: { branch: string }
): Promise<GitMergeResult> {
  const result = await execGit(['merge', options.branch], directory);

  if (result.exitCode === 0) {
    return { success: true, conflict: false };
  }

  const output = (result.stdout + result.stderr).toLowerCase();
  const isConflict =
    output.includes('conflict') ||
    output.includes('merge conflict') ||
    output.includes('automatic merge failed');

  if (isConflict) {
    const statusResult = await execGit(['status', '--porcelain'], directory);
    const conflictFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());

    return { success: false, conflict: true, conflictFiles };
  }

  throw new Error(result.stderr || 'Merge failed');
}

/**
 * Abort an in-progress merge
 */
export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const result = await execGit(['merge', '--abort'], directory);
  return { success: result.exitCode === 0 };
}

/**
 * Continue an in-progress rebase after conflicts are resolved
 */
export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const result = await execGit(['rebase', '--continue'], directory);

  if (result.exitCode === 0) {
    return { success: true, conflict: false };
  }

  const output = (result.stdout + result.stderr).toLowerCase();
  const isConflict =
    output.includes('conflict') ||
    output.includes('needs merge') ||
    output.includes('unmerged');

  if (isConflict) {
    const statusResult = await execGit(['status', '--porcelain'], directory);
    const conflictFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());

    return { success: false, conflict: true, conflictFiles };
  }

  throw new Error(result.stderr || 'Continue rebase failed');
}

/**
 * Continue an in-progress merge after conflicts are resolved
 */
export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  // For merge, we commit after resolving conflicts
  const result = await execGit(['commit', '--no-edit'], directory);

  if (result.exitCode === 0) {
    return { success: true, conflict: false };
  }

  const output = (result.stdout + result.stderr).toLowerCase();
  const isConflict =
    output.includes('conflict') ||
    output.includes('needs merge') ||
    output.includes('unmerged');

  if (isConflict) {
    const statusResult = await execGit(['status', '--porcelain'], directory);
    const conflictFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());

    return { success: false, conflict: true, conflictFiles };
  }

  throw new Error(result.stderr || 'Continue merge failed');
}

// ============== Commit Actions ==============

export async function checkoutCommit(directory: string, hash: string): Promise<{ success: boolean }> {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const result = await execGit(['checkout', hash], directory);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to checkout commit');
  }
  return { success: true };
}

export async function cherryPick(directory: string, hash: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const result = await execGit(['cherry-pick', hash], directory);

  if (result.exitCode === 0) {
    return { success: true, conflict: false };
  }

  const output = (result.stdout + result.stderr).toLowerCase();
  const isConflict =
    output.includes('conflict') ||
    output.includes('patch does not apply');

  if (isConflict) {
    const statusResult = await execGit(['status', '--porcelain'], directory);
    const conflictFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());

    return { success: false, conflict: true, conflictFiles };
  }

  throw new Error(result.stderr || 'Cherry-pick failed');
}

export async function revertCommit(directory: string, hash: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  const result = await execGit(['revert', '--no-commit', hash], directory);

  if (result.exitCode === 0) {
    return { success: true, conflict: false };
  }

  const output = (result.stdout + result.stderr).toLowerCase();
  const isConflict =
    output.includes('conflict') ||
    output.includes('revert failed');

  if (isConflict) {
    const statusResult = await execGit(['status', '--porcelain'], directory);
    const conflictFiles = statusResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('UU') || line.startsWith('AA') || line.startsWith('DD'))
      .map((line) => line.slice(3).trim());

    return { success: false, conflict: true, conflictFiles };
  }

  throw new Error(result.stderr || 'Revert failed');
}

export async function resetToCommit(
  directory: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
  force = false
): Promise<{ success: boolean }> {
  if (!isValidCommitHash(hash)) {
    throw new Error('Invalid commit hash');
  }
  if (mode === 'hard' && !force) {
    const statusResult = await execGit(['status', '--porcelain'], directory);
    const isDirty = statusResult.stdout.trim().length > 0;
    if (isDirty) {
      throw new Error('Cannot hard reset: uncommitted changes in working tree. Stash or commit first, or use force.');
    }
  }

  const result = await execGit(['reset', `--${mode}`, hash], directory);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Reset failed');
  }
  return { success: true };
}

// ============== Worktree Validation & Canonicalization ==============

/**
 * Resolve a path to its canonical (real) absolute path.
 */
async function canonicalizePath(filePath: string): Promise<string> {
  try {
    const realPath = await fs.promises.realpath(filePath);
    return realPath;
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Validate that a directory is inside a given worktree root.
 */
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

/**
 * Canonicalize the worktree state for a directory, returning branch, headState,
 * worktreeStatus, and attentionReason (merge/rebase/cherry-pick/revert).
 */
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

  // Resolve worktree project context (worktreeRoot)
  try {
    const context = await resolveWorktreeProjectContext(directoryPath);
    worktreeRoot = await canonicalizePath(context.worktreeRoot);
  } catch {
    worktreeStatus = 'invalid';
  }

  // Resolve head state and branch
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

  // Detect attention reasons (merge, rebase, cherry-pick, revert)
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
