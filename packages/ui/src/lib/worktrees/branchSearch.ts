import { rankByQuery } from "@/lib/search/fuzzySearch";

export interface RankedBranchGroups {
  matching: Array<{
    label: string;
    value: string;
    source: 'local' | 'remote';
  }>;
  remoteDefaults: string[];
  otherLocal: string[];
  otherRemote: string[];
}

export function splitBranchList(all: readonly string[] | undefined) {
  const branches = all ?? [];
  return {
    localBranches: branches.filter((branch) => !branch.startsWith('remotes/')).sort(),
    remoteBranches: branches.filter((branch) => branch.startsWith('remotes/')).map((branch) => branch.slice('remotes/'.length)).sort(),
  };
}

export function remoteDefaultBranches(args: {
  defaultBranches: Readonly<Record<string, string>> | undefined;
  remoteBranches: readonly string[];
  primaryRemote: string | null;
}): string[] {
  const { defaultBranches, remoteBranches, primaryRemote } = args;
  const listed = new Set(remoteBranches);
  return Object.entries(defaultBranches ?? {})
    .map(([remote, branch]) => ({ remote, label: `${remote}/${branch}` }))
    .filter(({ label }) => listed.has(label))
    .sort((a, b) => Number(b.remote === primaryRemote) - Number(a.remote === primaryRemote)
      || (a.remote < b.remote ? -1 : a.remote > b.remote ? 1 : 0))
    .map(({ label }) => label);
}

export function rankBranchesForQuery(args: {
  localBranches: string[];
  remoteBranches: string[];
  remoteDefaults?: readonly string[];
  query: string;
}): RankedBranchGroups {
  const { localBranches, remoteBranches, remoteDefaults = [], query } = args;
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    const pinned = new Set(remoteDefaults);
    return {
      matching: [],
      remoteDefaults: [...remoteDefaults],
      otherLocal: localBranches,
      otherRemote: remoteBranches.filter((branch) => !pinned.has(branch)),
    };
  }

  const candidates: RankedBranchGroups['matching'] = [
    ...localBranches.map((branch) => ({ label: branch, value: branch, source: 'local' as const })),
    ...remoteBranches.map((branch) => ({ label: branch, value: `remotes/${branch}`, source: 'remote' as const })),
  ];
  const matching = rankByQuery(candidates, normalizedQuery, (branch) => [branch.label]);
  const matched = new Set(matching);

  return {
    matching,
    remoteDefaults: [],
    otherLocal: candidates.filter((entry) => entry.source === 'local' && !matched.has(entry)).map((entry) => entry.label),
    otherRemote: candidates.filter((entry) => entry.source === 'remote' && !matched.has(entry)).map((entry) => entry.label),
  };
}
