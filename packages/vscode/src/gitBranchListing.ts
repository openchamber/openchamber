export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export type RemoteDefaultBranches = Record<string, string>;

export interface RawBranchListing {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
}

export const REMOTE_DEFAULT_BRANCHES_ARGS = ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes'];

export const RAW_BRANCH_LISTING_ARGS = ['branch', '-a', '-v', '--format=%(refname)|%(objectname:short)|%(upstream:short)|%(HEAD)|%(symref)'];

export function parseRemoteDefaultBranches(listing: string): RemoteDefaultBranches {
  return Object.fromEntries(listing.trim().split('\n').flatMap((line): [string, string][] => {
    const [ref = '', symbolicRef] = line.split(' ');
    const remote = ref.match(/^refs\/remotes\/([^/]+)\/HEAD$/)?.[1];
    if (!remote || !symbolicRef) return [];
    const remotePrefix = `refs/remotes/${remote}/`;
    return symbolicRef.startsWith(remotePrefix) ? [[remote, symbolicRef.slice(remotePrefix.length)]] : [];
  }));
}

function branchListName(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/remotes/')) return `remotes/${ref.slice('refs/remotes/'.length)}`;
  return ref;
}

export function parseRawBranchListing(listing: string): RawBranchListing {
  const branches: Record<string, GitBranchDetails> = {};
  const all: string[] = [];
  let current = '';

  for (const line of listing.trim().split('\n').filter(Boolean)) {
    const [ref = '', commit, tracking, head, symbolicRef] = line.split('|');
    const isRemoteHeadAlias = ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD') && Boolean(symbolicRef);
    const name = branchListName(ref);
    if (!name || isRemoteHeadAlias) continue;
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

  return { all, current, branches };
}
