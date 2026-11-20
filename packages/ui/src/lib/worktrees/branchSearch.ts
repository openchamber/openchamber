import { rankByQuery } from "@/lib/search/fuzzySearch";

export interface RankedBranchGroups {
  matching: Array<{
    label: string;
    value: string;
    source: 'local' | 'remote';
  }>;
  otherLocal: string[];
}

export function rankBranchesForQuery(args: {
  localBranches: string[];
  remoteBranches: string[];
  query: string;
}): RankedBranchGroups {
  const { localBranches, remoteBranches, query } = args;
  const normalizedQuery = query.trim();

  if (!normalizedQuery) {
    return {
      matching: [],
      otherLocal: localBranches,
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
    otherLocal: candidates.filter((entry) => entry.source === 'local' && !matched.has(entry)).map((entry) => entry.label),
  };
}
