import { partitionByFuzzyQuery } from "@/lib/search/fuzzySearch";

export interface RankedBranchGroups {
  matching: Array<{
    label: string;
    value: string;
    source: 'local' | 'remote';
  }>;
  otherLocal: string[];
  otherRemote: string[];
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
      otherRemote: remoteBranches,
    };
  }

  const localPartition = partitionByFuzzyQuery(localBranches, normalizedQuery, (branch) => branch);
  const remotePartition = partitionByFuzzyQuery(remoteBranches, normalizedQuery, (branch) => branch);
  const matching: RankedBranchGroups['matching'] = [];
  const otherLocal = localPartition.other;
  const otherRemote = remotePartition.other;

  for (const branch of localPartition.matching) {
    matching.push({
      label: branch,
      value: branch,
      source: 'local',
    });
  }

  for (const branch of remotePartition.matching) {
    matching.push({
      label: branch,
      value: `remotes/${branch}`,
      source: 'remote',
    });
  }

  matching.sort((a, b) => {
    const byLabel = a.label.localeCompare(b.label, undefined, { sensitivity: 'accent' });
    if (byLabel !== 0) {
      return byLabel;
    }
    if (a.source !== b.source) {
      return a.source.localeCompare(b.source);
    }
    return a.value.localeCompare(b.value);
  });

  return {
    matching,
    otherLocal,
    otherRemote,
  };
}
