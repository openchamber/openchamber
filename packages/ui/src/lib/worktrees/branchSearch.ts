import { scoreByFuzzyQuery } from "@/lib/search/fuzzySearch";

// Shared across branch pickers (BranchSelector, BranchIntegrationSection, this module).
// Aligned with `DEFAULT_FUZZY_OPTIONS.threshold` and `rankAutocompleteItems` defaults.
export const BRANCH_FUZZY_THRESHOLD = 0.4;

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

  // scoreByFuzzyQuery ranks by prefix (score -1) → substring position (idx/1000) → Fuse fuzzy fallback.
  // Items below the fuzzy threshold are omitted from the result.
  const localScored = scoreByFuzzyQuery(localBranches, normalizedQuery, (branch) => branch, {
    threshold: BRANCH_FUZZY_THRESHOLD,
  });
  const remoteScored = scoreByFuzzyQuery(remoteBranches, normalizedQuery, (branch) => branch, {
    threshold: BRANCH_FUZZY_THRESHOLD,
  });

  const localMatched = new Set(localScored.map((entry) => entry.item));
  const remoteMatched = new Set(remoteScored.map((entry) => entry.item));
  const otherLocal = localBranches.filter((branch) => !localMatched.has(branch));
  const otherRemote = remoteBranches.filter((branch) => !remoteMatched.has(branch));

  // Merge scored locals and remotes while preserving relevance order across both groups:
  // local prefix matches must come before remote prefix matches, etc.
  const merged: { label: string; value: string; source: 'local' | 'remote'; score: number }[] = [];
  for (const entry of localScored) {
    merged.push({
      label: entry.item,
      value: entry.item,
      source: 'local',
      score: entry.score,
    });
  }
  for (const entry of remoteScored) {
    merged.push({
      label: entry.item,
      value: `remotes/${entry.item}`,
      source: 'remote',
      score: entry.score,
    });
  }
  merged.sort((a, b) => a.score - b.score);

  return {
    matching: merged.map(({ label, value, source }) => ({ label, value, source })),
    otherLocal,
    otherRemote,
  };
}
