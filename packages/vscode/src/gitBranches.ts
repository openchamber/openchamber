import { execGit as executeGit } from './bridge-git-process-runtime';
import { getRepository } from './gitService';

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

type GitBranchListOptions = {
  remote?: 'none' | 'local' | 'live';
  query?: string;
  limit?: number;
};

const REMOTE_BRANCH_QUERY_DEFAULT_LIMIT = 100;
const REMOTE_BRANCH_QUERY_MAX_LIMIT = 500;

const remoteBranchQuery = (options: GitBranchListOptions) => {
  const query = (options.query || '').trim().toLowerCase();
  if (!query) return { query, limit: Number.POSITIVE_INFINITY };
  const requested = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : REMOTE_BRANCH_QUERY_DEFAULT_LIMIT;
  return { query, limit: Math.min(requested, REMOTE_BRANCH_QUERY_MAX_LIMIT) };
};

export async function getGitUnpushedBranchCounts(directory: string, requestedBranches: string[]): Promise<{ counts: Record<string, number> }> {
  const requested = [...new Set(requestedBranches)].filter(Boolean).slice(0, 5);
  if (requested.length === 0) return { counts: {} };
  const local = new Set((await getGitBranchesRaw(directory)).all.filter((branch) => !branch.startsWith('remotes/')));
  const counts: Record<string, number> = {};
  await Promise.all(requested.map(async (branch) => {
    if (!local.has(branch)) return;
    const upstreamResult = await executeGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`], directory);
    const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : '';
    if (!upstream) return;
    const countResult = await executeGit(['rev-list', '--count', `${upstream}..${branch}`], directory);
    const count = countResult.exitCode === 0 ? Number.parseInt(countResult.stdout.trim(), 10) : 0;
    if (Number.isFinite(count) && count > 0) counts[branch] = count;
  }));
  return { counts };
}

export async function getGitBranches(
  directory: string,
  options: GitBranchListOptions = {},
): Promise<GitBranchResult> {
  const repo = await getRepository(directory);

  if (!repo) {
    return getGitBranchesRaw(directory, options);
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

  const { query: normalizedQuery, limit: remoteLimit } = remoteBranchQuery(options);
  const remoteRefs = options.remote === 'none' ? [] : await repo.getBranches({ remote: true });
  let listedRemoteRefs = 0;
  for (const ref of remoteRefs) {
    if (!ref.name) continue;
    if (normalizedQuery && !ref.name.toLowerCase().includes(normalizedQuery)) continue;
    if (listedRemoteRefs >= remoteLimit) break;
    listedRemoteRefs += 1;
    const remoteBranchName = `remotes/${ref.name}`;
    all.push(remoteBranchName);
    branches[remoteBranchName] = {
      current: false,
      name: remoteBranchName,
      commit: ref.commit || '',
      label: ref.name,
    };
  }

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

async function getGitBranchesRaw(
  directory: string,
  options: GitBranchListOptions = {},
): Promise<GitBranchResult> {
  const result = await executeGit(['branch', '-a', '-v', '--format=%(refname:short)|%(objectname:short)|%(upstream:short)|%(HEAD)'], directory);

  if (result.exitCode !== 0) {
    return { all: [], current: '', branches: {} };
  }

  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const branches: Record<string, GitBranchDetails> = {};
  const all: string[] = [];
  let current = '';
  const { query: normalizedQuery, limit: remoteLimit } = remoteBranchQuery(options);
  let listedRemoteRefs = 0;

  for (const line of lines) {
    const [name, commit, tracking, head] = line.split('|');
    if (name) {
      if (options.remote === 'none' && name.startsWith('remotes/')) continue;
      if (name.startsWith('remotes/')) {
        if (normalizedQuery && !name.slice('remotes/'.length).toLowerCase().includes(normalizedQuery)) continue;
        if (listedRemoteRefs >= remoteLimit) continue;
        listedRemoteRefs += 1;
      }
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
