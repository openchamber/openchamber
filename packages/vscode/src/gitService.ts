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
export async function initGitExtension(): Promise<GitAPI | null> {
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
export async function getGitApi(): Promise<GitAPI | null> {
  if (gitApi && gitExtensionEnabled) {
    return gitApi;
  }
  return initGitExtension();
}

/**
 * Get repository for a given directory
 */
export async function getRepository(directory: string): Promise<Repository | null> {
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
        env,
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

/**
 * Get git status for a directory
 */
export async function getGitStatus(directory: string): Promise<GitStatusResult> {
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
    const relativePath = vscode.workspace.asRelativePath(change.uri, false);
    files.push({
      path: relativePath,
      index: mapStatus(change.status),
      working_dir: ' ',
    });
  }
  
  // Process working tree changes (unstaged)
  for (const change of state.workingTreeChanges) {
    const relativePath = vscode.workspace.asRelativePath(change.uri, false);
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

export interface GitBranchDetails {
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
 * Detach HEAD at current commit
 * This allows the current branch to be used in a worktree
 */
export async function detachHead(directory: string): Promise<{ success: boolean; commit: string }> {
  // Get current HEAD commit
  const headResult = await execGit(['rev-parse', 'HEAD'], directory);
  if (headResult.exitCode !== 0) {
    return { success: false, commit: '' };
  }
  
  const commit = headResult.stdout.trim();
  
  // Checkout the commit directly to detach HEAD
  const result = await execGit(['checkout', '--detach', 'HEAD'], directory);
  return { success: result.exitCode === 0, commit };
}

/**
 * Get the current HEAD branch name (null if detached)
 */
export async function getCurrentBranch(directory: string): Promise<string | null> {
  const repo = await getRepository(directory);
  
  if (repo) {
    const head = repo.state.HEAD;
    return head?.name || null;
  }

  // Fallback to raw git
  const result = await execGit(['symbolic-ref', '--short', 'HEAD'], directory);
  if (result.exitCode === 0) {
    return result.stdout.trim();
  }
  return null; // Detached HEAD
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
}

type WorktreeListEntry = {
  worktree: string;
  head?: string;
  branchRef?: string;
  branch?: string;
};

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
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
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
}) => {
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
  setTimeout(() => {
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

    void run().catch((error) => {
      setWorktreeBootstrapState(
        directory,
        WORKTREE_BOOTSTRAP_FAILED,
        error instanceof Error ? error.message : String(error)
      );
      console.warn('[GitService] Worktree bootstrap task failed:', error instanceof Error ? error.message : String(error));
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

export async function createWorktree(directory: string, input: CreateGitWorktreePayload = {}): Promise<GitWorktreeInfo> {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);
  await fs.promises.mkdir(context.worktreeRoot, { recursive: true });

  const preferredName = String(input?.worktreeName || input?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const startRef = normalizeStartRef(input?.startRef);
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

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
  });

  const headResult = await runGitCommand(candidate.directory, ['rev-parse', 'HEAD']);
  const head = String(headResult.stdout || '').trim();

  return {
    head,
    name: candidate.name,
    branch: localBranch,
    path: candidate.directory,
  };
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

/**
 * Get branches that are available for worktree checkout
 * (branches not already checked out in any worktree)
 */
export async function getAvailableBranchesForWorktree(directory: string): Promise<GitBranchDetails[]> {
  const [branches, worktrees] = await Promise.all([
    getGitBranches(directory),
    listGitWorktrees(directory),
  ]);

  // Get set of branches already checked out in worktrees
  const checkedOutBranches = new Set<string>();
  for (const wt of worktrees) {
    if (wt.branch) {
      checkedOutBranches.add(wt.branch.replace(/^refs\/heads\//, ''));
    }
  }

  // Filter out branches that are already checked out
  const availableBranches: GitBranchDetails[] = [];
  for (const name of branches.all) {
    // Skip remote branches for worktree creation
    if (name.startsWith('remotes/')) {
      continue;
    }
    
    if (!checkedOutBranches.has(name)) {
      const details = branches.branches[name];
      if (details) {
        availableBranches.push(details);
      }
    }
  }

  return availableBranches;
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
      
      // Read the current file content
      const fileUri = vscode.Uri.file(path.join(directory, filePath));
      const modifiedBytes = await vscode.workspace.fs.readFile(fileUri);
      const modified = Buffer.from(modifiedBytes).toString('utf8');
      
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
export async function revertGitFile(directory: string, filePath: string): Promise<void> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      await repo.revert([filePath]);
      return;
    } catch (error) {
      console.error('[GitService] Failed to revert via API:', error);
    }
  }

  // Fallback to raw git
  await execGit(['checkout', '--', filePath], directory);
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
  options?: { addAll?: boolean; files?: string[] }
): Promise<GitCommitResult> {
  const repo = await getRepository(directory);
  
  if (repo) {
    try {
      if (options?.addAll) {
        await repo.add(['.']);
      } else if (options?.files?.length) {
        await repo.add(options.files);
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
    await execGit(['add', ...options.files], directory);
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
  options?: { remote?: string; branch?: string }
): Promise<{ success: boolean; summary: { changes: number; insertions: number; deletions: number }; files: string[]; insertions: number; deletions: number }> {
  const repo = await getRepository(directory);
  
  if (repo) {
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
  const args = ['pull'];
  if (options?.remote) args.push(options.remote);
  if (options?.branch) args.push(options.branch);

  const result = await execGit(args, directory);
  
  return {
    success: result.exitCode === 0,
    summary: { changes: 0, insertions: 0, deletions: 0 },
    files: [],
    insertions: 0,
    deletions: 0,
  };
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
}

/**
 * Get git log
 */
export async function getGitLog(
  directory: string,
  options?: { maxCount?: number; from?: string; to?: string; file?: string }
): Promise<{ all: GitLogEntry[]; latest: GitLogEntry | null; total: number }> {
  const maxCount = options?.maxCount || 50;
  const args = [
    'log',
    `--max-count=${maxCount}`,
    '--format=%H|%aI|%s|%D|%b|%an|%ae',
    '--shortstat',
  ];
  
  if (options?.from && options?.to) {
    args.push(`${options.from}..${options.to}`);
  }
  
  if (options?.file) {
    args.push('--', options.file);
  }

  const result = await execGit(args, directory);
  
  if (result.exitCode !== 0) {
    return { all: [], latest: null, total: 0 };
  }

  const entries: GitLogEntry[] = [];
  const lines = result.stdout.split('\n');
  let current: Partial<GitLogEntry> | null = null;

  for (const line of lines) {
    if (line.includes('|') && !line.startsWith(' ')) {
      if (current?.hash) {
        entries.push(current as GitLogEntry);
      }
      const parts = line.split('|');
      current = {
        hash: parts[0] || '',
        date: parts[1] || '',
        message: parts[2] || '',
        refs: parts[3] || '',
        body: parts[4] || '',
        author_name: parts[5] || '',
        author_email: parts[6] || '',
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      };
    } else if (current && line.includes('file')) {
      const statsMatch = line.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?)?(?:,\s+(\d+)\s+deletions?)?/);
      if (statsMatch) {
        current.filesChanged = parseInt(statsMatch[1] || '0', 10);
        current.insertions = parseInt(statsMatch[2] || '0', 10);
        current.deletions = parseInt(statsMatch[3] || '0', 10);
      }
    }
  }

  if (current?.hash) {
    entries.push(current as GitLogEntry);
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
  const result = await execGit(['show', '--numstat', '--format=', hash], directory);
  
  if (result.exitCode !== 0) {
    return { files: [] };
  }

  const files: Array<{ path: string; insertions: number; deletions: number; isBinary: boolean; changeType: string }> = [];
  
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const isBinary = parts[0] === '-' && parts[1] === '-';
      files.push({
        path: parts[2] || '',
        insertions: isBinary ? 0 : parseInt(parts[0] || '0', 10),
        deletions: isBinary ? 0 : parseInt(parts[1] || '0', 10),
        isBinary,
        changeType: 'M', // Would need additional parsing for actual change type
      });
    }
  }

  return { files };
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
  sshKey?: string | null
): Promise<{ success: boolean }> {
  const repo = await getRepository(directory);
  
  // Build SSH command once if needed
  const sshCommand = sshKey ? buildSshCommand(sshKey) : null;
  
  if (repo) {
    try {
      await repo.setConfig('user.name', userName);
      await repo.setConfig('user.email', userEmail);
      if (sshCommand) {
        await repo.setConfig('core.sshCommand', sshCommand);
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

// ============== Stash Operations ==============

/**
 * Stash changes
 */
export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  const args = ['stash', 'push'];

  // Include untracked files by default
  if (options?.includeUntracked !== false) {
    args.push('--include-untracked');
  }

  if (options?.message) {
    args.push('-m', options.message);
  }

  const result = await execGit(args, directory);
  return { success: result.exitCode === 0 };
}

/**
 * Pop the most recent stash
 */
export async function stashPop(directory: string): Promise<{ success: boolean }> {
  const result = await execGit(['stash', 'pop'], directory);
  return { success: result.exitCode === 0 };
}
