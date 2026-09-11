import type { GitCommitDiffTarget } from '@/stores/useUIStore';

type DiffTabRenderCandidate = {
  commitDiffTarget: GitCommitDiffTarget | null;
};

export const getDiffTabRenderKind = (tab: DiffTabRenderCandidate): 'commit' | 'working' => {
  return tab.commitDiffTarget ? 'commit' : 'working';
};
