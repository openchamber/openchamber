/**
 * Where a new worktree's branch starts.
 *
 * Settings name one default for every place a worktree is made
 * (`worktreeStartFrom`, the default remote's default branch unless changed)
 * and an optional override per place (`worktreeStartFromOverrides`).
 * `project-root` is the branch the project root is on, refreshed from its
 * upstream when nothing is unpublished; `remote-default` is the default
 * remote's default branch, which the server fetches before it creates the
 * worktree.
 *
 * A worktree made from a pull request checks out the request's branch, so
 * commits push to it, or starts a new branch from its head
 * (`pullRequestWorktree` names the default; each place can switch it).
 *
 * A new-session draft can pick its own source beside its Auto-create worktree
 * switch: a worktree's branch, any local or remote branch, or a pull request.
 */

import type { GitBranch, SourceControlReadContext } from '@/lib/api/types';
import type { ChangeRequest } from '@/lib/source-control/types';

export const WORKTREE_START_FROM_OPTIONS = ['project-root', 'remote-default'] as const;
export type WorktreeStartFrom = (typeof WORKTREE_START_FROM_OPTIONS)[number];
export const DEFAULT_WORKTREE_START_FROM = 'remote-default' satisfies WorktreeStartFrom;
/** A new session starts in a worktree of its own unless the profile turns Auto-create worktree off. */
export const DEFAULT_AUTO_CREATE_WORKTREE = true;

/** The places that make a worktree, each of which can override the default start. */
export const WORKTREE_START_PLACES = ['autoCreate', 'quick', 'dialog', 'parallel', 'handoff', 'agent'] as const;
export type WorktreeStartPlace = (typeof WORKTREE_START_PLACES)[number];
/** Absent means the place follows `worktreeStartFrom`. */
export type WorktreeStartFromOverrides = Partial<Record<WorktreeStartPlace, WorktreeStartFrom>>;

/** Where a worktree made at `place` starts: its override, else the default for all. */
export const selectWorktreeStartFrom = (
  settings: { settingsWorktreeStartFrom: WorktreeStartFrom; settingsWorktreeStartFromOverrides: WorktreeStartFromOverrides },
  place: WorktreeStartPlace,
): WorktreeStartFrom => settings.settingsWorktreeStartFromOverrides[place] ?? settings.settingsWorktreeStartFrom;

/** `check-out` puts the worktree on the request's branch; `branch-off` starts a new branch from its head. */
export const PULL_REQUEST_WORKTREE_MODES = ['check-out', 'branch-off'] as const;
export type PullRequestWorktreeMode = (typeof PULL_REQUEST_WORKTREE_MODES)[number];

/** What a draft picked beside its Auto-create worktree switch. */
export type WorktreeStartSource =
  /** A new branch from `ref`: a local branch, or `remotes/<remote>/<branch>`. */
  | { kind: 'ref'; ref: string }
  | {
    kind: 'pull-request';
    number: number;
    title: string;
    context: SourceControlReadContext;
    /** A fork's head can only be checked out: the server refuses a new branch from it. */
    fromFork: boolean;
    /** Its branch is checked out in another worktree, so only a new branch can start from it. */
    headInUse: boolean;
    /** Start a new branch from the head instead of checking out the request's branch. */
    branchOff: boolean;
  };

const CONVENTIONAL_DEFAULT_BRANCHES = ['main', 'master'];
const REMOTE_PREFIX = 'remotes/';

/** Remote names the branch list knows, `origin` first, then by name. */
const listRemotes = (branches: Pick<GitBranch, 'all' | 'defaultBranches'>): string[] => {
  const names = new Set(Object.keys(branches.defaultBranches ?? {}));
  for (const entry of branches.all) {
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
 * points at, else `main` or `master` when it has one. The server applies the
 * same rule (`packages/web/server/lib/git/worktree-start-ref.js`).
 */
export const resolveRemoteDefaultStartRef = (branches: Pick<GitBranch, 'all' | 'defaultBranches'>): string | null => {
  const [remote] = listRemotes(branches);
  if (!remote) return null;
  const named = branches.defaultBranches?.[remote];
  if (named) return `${REMOTE_PREFIX}${remote}/${named}`;
  const refs = new Set(branches.all);
  const conventional = CONVENTIONAL_DEFAULT_BRANCHES.find((name) => refs.has(`${REMOTE_PREFIX}${remote}/${name}`));
  return conventional ? `${REMOTE_PREFIX}${remote}/${conventional}` : null;
};

/** How a start ref reads in a picker: `origin/main` for `remotes/origin/main`. */
export const formatStartRefLabel = (ref: string): string => (
  ref.startsWith(REMOTE_PREFIX) ? ref.slice(REMOTE_PREFIX.length) : ref
);

/** The source picker's branch groups. */
interface StartSourceBranchGroups {
  /** Checked out in a worktree: the project root's branch first, then each worktree's. */
  checkedOut: string[];
  /** Local branches no worktree has checked out, pushed anywhere or not. */
  local: string[];
  /** Remote-tracking branches as `<remote>/<branch>`. */
  remote: string[];
}

/**
 * Splits a branch list for the source picker, so a branch shows once: under
 * the worktree it is checked out in, else as a local or a remote branch.
 */
export const groupStartSourceBranches = (
  all: readonly string[],
  rootBranch: string,
  worktreeBranches: readonly string[],
): StartSourceBranchGroups => {
  const checkedOut = [...new Set([rootBranch, ...worktreeBranches].filter(Boolean))];
  const taken = new Set(checkedOut);
  return {
    checkedOut,
    local: all.filter((name) => !name.startsWith(REMOTE_PREFIX) && !taken.has(name)).sort(),
    remote: all
      .filter((name) => name.startsWith(REMOTE_PREFIX) && !name.endsWith('/HEAD'))
      .map((name) => name.slice(REMOTE_PREFIX.length))
      .sort(),
  };
};

type PullRequestSource = Extract<WorktreeStartSource, { kind: 'pull-request' }>;

type PullRequestSourceCheck =
  | { ok: true; source: PullRequestSource }
  | { ok: false; reason: 'not-found' | 'not-open' | 'branch-in-use' };

/** A head in another repository than the request's own; unknown counts as this one, and the server checks again. */
const isForkChangeRequest = (changeRequest: Pick<ChangeRequest, 'project' | 'headProject'>): boolean => Boolean(
  changeRequest.headProject
  && (changeRequest.headProject.owner !== changeRequest.project.owner || changeRequest.headProject.name !== changeRequest.project.name),
);

/** Whether the worktree can check out the request's branch, and whether it can branch off it. */
export const pullRequestWorktreeChoices = (source: Pick<PullRequestSource, 'fromFork' | 'headInUse'>) => ({
  checkOut: !source.headInUse,
  branchOff: !source.fromFork,
});

/**
 * Whether a pull request can be a draft's worktree source: it exists, it is
 * open, and at least one way to make its worktree is left. Its branch can be
 * checked out in one worktree only, and a new branch cannot start from a
 * fork's head. The pick starts on the Settings mode when that mode is possible.
 * A failed read throws.
 */
export const checkPullRequestSource = async ({ context, number, mode, readChangeRequest, isBranchInUse }: {
  context: SourceControlReadContext;
  number: number;
  /** The Settings default for pull request worktrees. */
  mode: PullRequestWorktreeMode;
  readChangeRequest: (context: SourceControlReadContext, number: number) => Promise<ChangeRequest | null>;
  isBranchInUse: (branch: string) => Promise<boolean>;
}): Promise<PullRequestSourceCheck> => {
  const changeRequest = await readChangeRequest(context, number);
  if (!changeRequest) return { ok: false, reason: 'not-found' };
  if (changeRequest.state !== 'open') return { ok: false, reason: 'not-open' };
  const fromFork = isForkChangeRequest(changeRequest);
  const headInUse = await isBranchInUse(changeRequest.head);
  const choices = pullRequestWorktreeChoices({ fromFork, headInUse });
  if (!choices.checkOut && !choices.branchOff) return { ok: false, reason: 'branch-in-use' };
  const branchOff = choices.branchOff && (mode === 'branch-off' || !choices.checkOut);
  return { ok: true, source: { kind: 'pull-request', number, title: changeRequest.title, context, fromFork, headInUse, branchOff } };
};
