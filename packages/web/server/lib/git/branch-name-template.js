/**
 * How a branch for a worktree is named from the profile settings
 * `worktreeBranchTemplate` and `pullRequestBranchTemplate`. The UI holds the
 * same rules (`packages/ui/src/lib/worktrees/branchNameTemplate.ts`): `{name}`
 * is the worktree's name, and a branch started from a pull request may also
 * use `{pr}`, its number, and `{head}`, its branch.
 */

import { isString } from '../shared/guards.js';

const DEFAULT_WORKTREE_BRANCH_TEMPLATE = '{name}';
export const DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE = '{name}-from-pr-{pr}';

const MAX_TEMPLATE_LENGTH = 120;
// What `git check-ref-format` refuses in a branch name.
const INVALID_BRANCH = /^[-/.]|[/.]$|\.\.|@\{|\/\/|\/\.|\.lock(?:\/|$)|[\s~^:?*[\\]|\p{Cc}/u;

/**
 * Replacers are functions, so a `$&` in a value stays as written.
 *
 * @param {string} template
 * @param {{ name: string, pr?: number, head?: string }} values
 */
export const renderBranchName = (template, values) => template
  .replaceAll('{name}', () => values.name)
  .replaceAll('{pr}', () => (values.pr === undefined ? '' : String(values.pr)))
  .replaceAll('{head}', () => values.head ?? '');

/**
 * A worktree name made fit for a branch: an exact `/path` contributes its last
 * segment, and each `/`-separated part keeps letters, digits and `._-`.
 *
 * @param {string} worktreeName
 */
export const branchSafeName = (worktreeName) => {
  const name = worktreeName.startsWith('/') ? worktreeName.split('/').filter(Boolean).pop() ?? '' : worktreeName;
  return name
    .split('/')
    .map((part) => part
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/-{2,}/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .replace(/\.lock$/i, '-lock'))
    .filter(Boolean)
    .join('/');
};

/**
 * The branch a template gives a worktree name, before any suffix.
 *
 * @param {string} template
 * @param {{ name: string, pr?: number, head?: string }} values
 */
export const branchNameFromTemplate = (template, values) => (
  renderBranchName(template, { ...values, name: branchSafeName(values.name) || 'worktree' })
);

/**
 * A template names the worktree, uses only the variables its kind has, and
 * renders to a name git accepts.
 *
 * @param {unknown} template
 * @param {'worktree' | 'pull-request'} kind
 * @returns {template is string}
 */
export const isBranchTemplate = (template, kind) => {
  if (!isString(template) || !template.includes('{name}') || template.length > MAX_TEMPLATE_LENGTH) return false;
  if (kind === 'worktree' && /\{(?:pr|head)\}/.test(template)) return false;
  const sample = renderBranchName(template, { name: 'name', pr: 1, head: 'head' });
  // A prefix git's ref plumbing strips would never reach the branch.
  if (/^(?:refs|heads|remotes)\//.test(sample)) return false;
  return !/[{}]/.test(sample) && !INVALID_BRANCH.test(sample);
};

/**
 * The stored template of a kind, or its default when none or an unusable one is stored.
 *
 * @param {Record<string, unknown> | null | undefined} settings
 * @param {'worktree' | 'pull-request'} kind
 */
export const branchTemplateFrom = (settings, kind) => {
  const stored = kind === 'worktree' ? settings?.worktreeBranchTemplate : settings?.pullRequestBranchTemplate;
  if (isBranchTemplate(stored, kind)) return stored;
  return kind === 'worktree' ? DEFAULT_WORKTREE_BRANCH_TEMPLATE : DEFAULT_PULL_REQUEST_BRANCH_TEMPLATE;
};

/**
 * The first of `name`, `name-2`, `name-3`… that no existing branch has, and
 * that no existing branch uses as a folder (`name/…` would block `name`).
 *
 * @param {string} name
 * @param {ReadonlySet<string>} existing
 */
export const uniqueBranchName = (name, existing) => {
  const taken = (candidate) => existing.has(candidate)
    || [...existing].some((branch) => branch.startsWith(`${candidate}/`));
  if (!taken(name)) return name;
  let suffix = 2;
  while (taken(`${name}-${suffix}`)) suffix += 1;
  return `${name}-${suffix}`;
};

/**
 * Local branch names from a `getBranches` answer.
 *
 * @param {{ all?: string[] } | null | undefined} branches
 */
export const localBranchNames = (branches) => new Set((branches?.all ?? []).filter((branch) => !branch.startsWith('remotes/')));

/**
 * The branch Settings give a new worktree named `name`: the worktree template
 * filled with it, past any local branch that already has the result.
 *
 * @param {Record<string, unknown> | null | undefined} settings
 * @param {{ all?: string[] } | null | undefined} branches local `getBranches` output
 * @param {string} name the worktree name, or an exact `/path`
 */
export const defaultBranchName = (settings, branches, name) => (
  uniqueBranchName(branchNameFromTemplate(branchTemplateFrom(settings, 'worktree'), { name }), localBranchNames(branches))
);
