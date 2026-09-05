import type { GitDiffTab } from '@/stores/useGitDiffTabsStore';

const getFileNameFromPath = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').trim();
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }
  return segments[segments.length - 1] || normalized;
};

const getShortHash = (hash: string): string => hash.slice(0, 7);

const getCommitComparisonLabel = (tab: Extract<GitDiffTab, { kind: 'commit' }>): string => {
  const currentName = getFileNameFromPath(tab.target.file.path);
  const commitHashShort = getShortHash(tab.target.commitHash);

  if (!tab.target.parentHash) {
    return `${currentName} (${commitHashShort})`;
  }

  const originalName = getFileNameFromPath(tab.target.file.originalPath ?? tab.target.file.path);
  const parentHashShort = getShortHash(tab.target.parentHash);
  return `${originalName} (${parentHashShort}) ↔ ${currentName} (${commitHashShort})`;
};

export const getGitDiffTabLabel = (tabs: readonly GitDiffTab[], tab: GitDiffTab): string => {
  if (tab.kind === 'commit') {
    return getCommitComparisonLabel(tab);
  }

  const filePath =
    tab.path;
  const basename = getFileNameFromPath(filePath);

  // Check if multiple tabs share this basename
  const basenames = tabs
    .filter((t) => t.kind === 'working')
    .map((t) => t.path);

  const otherTabsWithSameBasename = basenames.filter(
    (path) =>
      path !== filePath &&
      getFileNameFromPath(path) === basename,
  );

  if (otherTabsWithSameBasename.length > 0) {
    // Disambiguate: use parent/basename
    const parts = filePath.split('/').filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  }

  return basename;
};

export const getGitDiffTabTitle = (tab: GitDiffTab): string => {
  if (tab.kind === 'working') {
    return tab.path;
  }

  const commitHashShort = getShortHash(tab.target.commitHash);
  if (!tab.target.parentHash) {
    return `${tab.target.file.path} (${commitHashShort})`;
  }

  const parentHashShort = getShortHash(tab.target.parentHash);
  const originalPath = tab.target.file.originalPath ?? tab.target.file.path;
  return `${originalPath} (${parentHashShort}) ↔ ${tab.target.file.path} (${commitHashShort})`;
};
