import type { RemoteWithRefs, SimpleGit } from 'simple-git';

export type BranchListOptions = {
  remote?: 'none' | 'local' | 'live';
  query?: string;
  limit?: number;
};

const REMOTE_BRANCH_QUERY_DEFAULT_LIMIT = 100;
const REMOTE_BRANCH_QUERY_MAX_LIMIT = 500;
const REMOTE_BRANCH_NAMES_TTL_MS = 30_000;
const REMOTE_HEADS_TTL_MS = 30_000;

const remoteBranchNamesCache = new Map<string, { at: number; names: Promise<string[]> }>();
const remoteHeadsCache = new Map<string, { at: number; localKey: string; heads: Promise<Set<string>> }>();

type LocalBranchDetails = {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
};

const LOCAL_BRANCH_FORMAT = '%(refname)%09%(objectname:short)%09%(upstream)%09%(HEAD)%09%(contents:subject)';

const readDetachedHeadName = async (git: SimpleGit): Promise<string> => {
  try {
    const output = await git.raw(['branch', '--format=%(refname:short)']);
    const detached = output.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('(HEAD '));
    return detached?.replace(/^\(HEAD detached (?:at|from) /, '').replace(/\)$/, '') ?? '';
  } catch {
    return '';
  }
};

export const readLocalBranchRefs = async (git: SimpleGit) => {
  const output = await git.raw(['for-each-ref', `--format=${LOCAL_BRANCH_FORMAT}`, 'refs/heads']);
  const all: string[] = [];
  const branches: Record<string, LocalBranchDetails> = {};
  let current = '';

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [ref = '', commit = '', upstream = '', head = '', ...subject] = line.split('\t');
    const name = ref.replace(/^refs\/heads\//, '');
    const isCurrent = head === '*';
    if (isCurrent) current = name;
    const details: LocalBranchDetails = {
      current: isCurrent,
      name,
      commit,
      label: subject.join('\t'),
    };
    if (upstream.startsWith('refs/remotes/')) details.tracking = upstream.slice('refs/remotes/'.length);
    all.push(name);
    branches[name] = details;
  }

  if (!current) current = await readDetachedHeadName(git);
  return { all, current, branches };
};

const parseRemoteBranchNames = (output: string): string[] => {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const ref = line.trim();
    if (!ref.startsWith('refs/remotes/') || ref.endsWith('/HEAD')) continue;
    names.push(ref.slice('refs/'.length));
  }
  return names;
};

const REMOTE_BRANCH_NAMES_CACHE_MAX_DIRECTORIES = 32;

const rememberRemoteBranchNames = (directory: string, names: Promise<string[]>) => {
  remoteBranchNamesCache.set(directory, { at: Date.now(), names });
  if (remoteBranchNamesCache.size <= REMOTE_BRANCH_NAMES_CACHE_MAX_DIRECTORIES) return;
  const oldest = [...remoteBranchNamesCache.entries()].sort((left, right) => left[1].at - right[1].at)[0];
  if (oldest) remoteBranchNamesCache.delete(oldest[0]);
};

const readRemoteBranchNames = (git: SimpleGit, directory: string, options: { fresh?: boolean } = {}): Promise<string[]> => {
  const cached = remoteBranchNamesCache.get(directory);
  if (!options.fresh && cached && Date.now() - cached.at < REMOTE_BRANCH_NAMES_TTL_MS) return cached.names;
  const names = git.raw(['for-each-ref', '--format=%(refname)', 'refs/remotes']).then(parseRemoteBranchNames);
  rememberRemoteBranchNames(directory, names);
  names.catch(() => { if (remoteBranchNamesCache.get(directory)?.names === names) remoteBranchNamesCache.delete(directory); });
  return names;
};

const rememberLiveRemoteBranchNames = (directory: string, names: string[]) => {
  rememberRemoteBranchNames(directory, Promise.resolve(names));
};

const remoteBranchLimit = (limit: number | undefined, hasQuery: boolean): number => {
  if (!hasQuery) return Number.POSITIVE_INFINITY;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return REMOTE_BRANCH_QUERY_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), REMOTE_BRANCH_QUERY_MAX_LIMIT);
};

const selectRemoteBranchNames = (names: string[], query: string, limit: number | undefined): string[] => {
  const normalizedQuery = query.trim().toLowerCase();
  const maxNames = remoteBranchLimit(limit, normalizedQuery.length > 0);
  if (!normalizedQuery) return names;
  const matches: string[] = [];
  for (const name of names) {
    if (!name.toLowerCase().includes(normalizedQuery)) continue;
    matches.push(name);
    if (matches.length >= maxNames) break;
  }
  return matches;
};

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

const filterActiveRemoteBranches = async (git: SimpleGit, directory: string, remoteBranches: string[]) => {
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

    const activeBranches = remoteBranches.filter((remoteBranch) => {
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
    console.warn('Failed to filter active remote branches, returning all:', error instanceof Error ? error.message : error);
    return remoteBranches;
  }
};

export async function getRemoteDefaultBranches(git: SimpleGit) {
  let defaults: Record<string, string> = {};

  try {
    const refs = await git.raw([
      'for-each-ref',
      '--format=%(refname) %(symref)',
      'refs/remotes/*/HEAD',
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

export async function readBranchList(git: SimpleGit, directory: string, options: BranchListOptions = {}) {
  const { remote = 'local', query = '', limit } = options;
  const { all: localBranches, current, branches } = await readLocalBranchRefs(git);
  const defaultBranches = await getRemoteDefaultBranches(git);

  let remoteBranches: string[] = [];
  if (remote !== 'none') {
    const onDisk = await readRemoteBranchNames(git, directory, { fresh: remote === 'live' });
    const active = remote === 'live' ? await filterActiveRemoteBranches(git, directory, onDisk) : onDisk;
    if (remote === 'live') rememberLiveRemoteBranchNames(directory, active);
    remoteBranches = selectRemoteBranchNames(active, query, limit);
  }

  return {
    all: [...localBranches, ...remoteBranches],
    current,
    branches,
    defaultBranches,
  };
}

export function parseBranchListQuery(remote: string, query: string, limit: number): BranchListOptions {
  const options: BranchListOptions = {
    remote: remote === 'live' ? 'live' : remote === 'none' ? 'none' : 'local',
    query,
  };
  if (Number.isFinite(limit) && limit > 0) options.limit = limit;
  return options;
}
