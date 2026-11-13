/**
 * Which discovered nested repository a surface may select on its own.
 *
 * A project root that is not a repository can contain several: a wrapper
 * folder with one checkout, or a home directory with a dozen tool installs.
 * Discovery reports them all so a picker can offer them; picking one without
 * being asked is only defensible when the choice is not arbitrary. A
 * repository under a dot-directory (`~/.oh-my-zsh`, `~/.cache/...`) is tooling
 * that happens to carry a `.git`, never the project the user opened the folder
 * for (#5357), so those are offered in the picker and never picked
 * automatically.
 */

const SEPARATOR = /[\\/]+/;

const segmentsUnderRoot = (root: string, repository: string): string[] => {
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const relative = repository.startsWith(normalizedRoot)
    ? repository.slice(normalizedRoot.length)
    : repository;
  return relative.split(SEPARATOR).filter((segment) => segment.length > 0);
};

const isHiddenRepository = (root: string, repository: string): boolean =>
  segmentsUnderRoot(root, repository).some((segment) => segment.startsWith('.'));

/**
 * The repository to select without asking, or null when nothing is
 * unambiguous. `repositories` arrives in discovery order, so the first visible
 * one wins and the hidden ones stay reachable from the picker.
 */
export const chooseAutoNestedRepo = (
  root: string,
  repositories: readonly string[] | null | undefined,
): string | null => {
  if (!Array.isArray(repositories) || repositories.length === 0) return null;
  const visible = repositories.find((repository) => !isHiddenRepository(root, repository));
  return visible ?? null;
};

const withoutTrailingSeparator = (value: string): string => value.replace(/[\\/]+$/, '');

/**
 * Whether a project root is searched for nested repositories at all. The home
 * directory is not: a project there exists to hold chats outside any project,
 * the repositories under it are tool installs and unrelated checkouts, and a
 * walk three levels into `~` is slow. Its git surfaces show the plain "not a
 * git repository" state.
 */
export const discoversNestedRepos = (root: string, homeDirectory: string | null | undefined): boolean => {
  if (!homeDirectory) return true;
  return withoutTrailingSeparator(root) !== withoutTrailingSeparator(homeDirectory);
};
