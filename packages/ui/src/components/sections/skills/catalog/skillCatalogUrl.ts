import type { SkillsCatalogItem } from '@/lib/api/types';

const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The GitHub page for a catalog skill.
 *
 * `skillDir` is the directory the scanner found, relative to the repository
 * root (`git ls-files` / `git ls-tree` output), so it already includes the
 * source's subpath. Prepending `repoSubpath` duplicated it — the OpenAI source
 * linked `skills/.curated/skills/.curated/aspnet-core` and GitHub answered 404.
 */
export const skillCatalogUrl = (item: SkillsCatalogItem): string | null => {
  const repoSource = item.repoSource.trim();
  if (!GITHUB_REPO_PATTERN.test(repoSource)) {
    return null;
  }
  const repoUrl = `https://github.com/${repoSource}`;
  const skillDir = item.skillDir.trim();
  return skillDir ? `${repoUrl}/tree/HEAD/${skillDir}` : repoUrl;
};
