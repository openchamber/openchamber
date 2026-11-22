/**
 * Where a new worktree starts, by the profile settings the UI shares
 * (`packages/ui/src/lib/worktrees/worktreeStartSource.ts` holds the same
 * rules): `worktreeStartFrom` is the default for every place a worktree is
 * made, the default remote's default branch unless changed, and
 * `worktreeStartFromOverrides` can name another start for one place.
 * `pullRequestWorktree` says whether a worktree from a pull request checks out
 * its branch or starts a new branch from its head.
 */

export const WORKTREE_START_FROM_VALUES = Object.freeze(['project-root', 'remote-default']);
const WORKTREE_START_PLACES = Object.freeze(['autoCreate', 'quick', 'dialog', 'parallel', 'handoff', 'agent']);
export const PULL_REQUEST_WORKTREE_MODES = Object.freeze(['check-out', 'branch-off']);
const DEFAULT_WORKTREE_START_FROM = 'remote-default';

const CONVENTIONAL_DEFAULT_BRANCHES = ['main', 'master'];
const REMOTE_PREFIX = 'remotes/';

/**
 * The overrides a client may store: known places with known values. Anything
 * else is dropped, entry by entry.
 *
 * @param {unknown} value
 * @returns {Record<string, string> | undefined} undefined when the value is not an object
 */
export const sanitizeWorktreeStartFromOverrides = (value) => {
  if (!value || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([place, startFrom]) => WORKTREE_START_PLACES.includes(place) && WORKTREE_START_FROM_VALUES.includes(startFrom)));
};

/**
 * Where a worktree made at `place` starts: its override, else the default for all.
 *
 * @param {{ worktreeStartFrom?: unknown, worktreeStartFromOverrides?: unknown, [setting: string]: unknown } | null | undefined} settings
 * @param {string} place one of WORKTREE_START_PLACES
 * @returns {'project-root' | 'remote-default'}
 */
export const resolveWorktreeStartFrom = (settings, place) => {
  const override = settings?.worktreeStartFromOverrides?.[place];
  if (WORKTREE_START_FROM_VALUES.includes(override)) return override;
  return WORKTREE_START_FROM_VALUES.includes(settings?.worktreeStartFrom) ? settings.worktreeStartFrom : DEFAULT_WORKTREE_START_FROM;
};

/**
 * Whether a worktree from a pull request starts a new branch from its head by default.
 *
 * @param {{ pullRequestWorktree?: unknown, [setting: string]: unknown } | null | undefined} settings
 */
export const branchesOffPullRequestsByDefault = (settings) => settings?.pullRequestWorktree === 'branch-off';

const listRemotes = ({ all = [], defaultBranches = {} }) => {
  const names = new Set(Object.keys(defaultBranches));
  for (const entry of all) {
    if (!entry.startsWith(REMOTE_PREFIX)) continue;
    const name = entry.slice(REMOTE_PREFIX.length).split('/')[0];
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => {
    if (a === 'origin') return -1;
    if (b === 'origin') return 1;
    return a.localeCompare(b);
  });
};

/**
 * The default remote's default branch as `remotes/<remote>/<branch>`, or null
 * when it names none. The default remote is `origin`, else the first remote by
 * name, and only that remote counts; its default branch is what its `HEAD`
 * points at, else `main` or `master` when it has one.
 *
 * @param {{ all?: string[], defaultBranches?: Record<string, string> }} branches `getBranches` output
 * @returns {string | null}
 */
export const resolveRemoteDefaultStartRef = (branches) => {
  const [remote] = listRemotes(branches ?? {});
  if (!remote) return null;
  const named = branches?.defaultBranches?.[remote];
  if (named) return `${REMOTE_PREFIX}${remote}/${named}`;
  const refs = new Set(branches?.all ?? []);
  const conventional = CONVENTIONAL_DEFAULT_BRANCHES.find((name) => refs.has(`${REMOTE_PREFIX}${remote}/${name}`));
  return conventional ? `${REMOTE_PREFIX}${remote}/${conventional}` : null;
};
