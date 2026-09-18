import type { SessionGroup } from './types';
import { normalizePath } from './utils';

export const SOURCE_CONTROL_DISCOVERY_LIMIT = 50;

type DiscoverySection = {
  project: { id: string };
  groups: Array<Pick<SessionGroup, 'branch' | 'directory' | 'isArchivedBucket' | 'isMain'>>;
};

export const selectSourceControlDiscoveryCandidates = (
  sections: DiscoverySection[],
  collapsedProjects: Set<string>,
  gitBranches: Map<string, string | null>,
): Array<{ directory: string; branch: string }> => {
  const candidates = new Map<string, { directory: string; branch: string }>();

  sectionLoop: for (const section of sections) {
    if (collapsedProjects.has(section.project.id)) continue;
    for (const group of section.groups) {
      if (group.isArchivedBucket || group.isMain) continue;
      const directory = normalizePath(group.directory ?? null);
      const branch = group.branch?.trim() || gitBranches.get(directory || '')?.trim();
      if (!directory || !branch || candidates.has(directory)) continue;
      candidates.set(directory, { directory, branch });
      if (candidates.size === SOURCE_CONTROL_DISCOVERY_LIMIT) break sectionLoop;
    }
  }

  return [...candidates.values()];
};
