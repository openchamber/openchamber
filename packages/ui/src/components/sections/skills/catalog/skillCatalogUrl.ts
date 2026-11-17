import type { SkillsCatalogItem } from '@/lib/api/types';

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const skillCatalogUrl = (item: SkillsCatalogItem): string | null => {
  const repoSource = item.repoSource.trim();
  if (!GITHUB_REPO_PATTERN.test(repoSource)) {
    return null;
  }
  const repoUrl = `https://github.com/${repoSource}`;
  const skillDir = item.skillDir.trim();
  return skillDir ? `${repoUrl}/tree/HEAD/${skillDir}` : repoUrl;
};
