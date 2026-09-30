// Applying a space's work to the user's project, or throwing it away (DESIGN.md, decisions 7 and 8,
// user journey step 6). The host brings the work out and applies it; this module names the default
// branch, reads what an apply was refused for into what the dialog shows, tells whether an agent
// still works in the space, and records a removal that followed the apply.
//
// The maintainer's calls of 2026-09-29: the branch is the default, named after the space; a refusal
// that closes the way of uncommitted changes switches the dialog to the branch and leaves the next
// press to the user; an agent still at work gets a warning, not a block, and the space is not
// deleted afterwards unless the user asks.

import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { applySpaceWork, SpacesRequestError, type SpaceApplyOutcome, type SpaceApplyRequest, type SpaceFailure, type SpaceFailureDetails, type SpaceReportedPaths } from './spaces-api';
import { forgetRemovedSpace, noteRemoval } from './space-repair';
import { refreshSpacesJourney, spacesRuntimeGeneration, useSpacesStore } from './spaces-store';

const FALLBACK_BRANCH = 'space';

/**
 * The branch an apply suggests: the space's name, which the create dialog fills from the same
 * generator as a worktree's branch, made into a name git takes. The server checks it again.
 */
export const branchNameOfSpace = (name: string): string => {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .split('/')
    .map((part) => part.replace(/^[-.]+|[-.]+$/g, '').replace(/\.lock$/, ''))
    .filter(Boolean)
    .join('/');
  return slug || FALLBACK_BRANCH;
};

/**
 * Why an apply did not go through, as the dialog tells it. `changes_closed` and `partly_applied`
 * close the way of uncommitted changes for good, so the dialog turns to the branch.
 */
export type SpaceApplyRefusal =
  | { kind: 'changes_closed' }
  | { kind: 'part_thrown_away'; stillThere: SpaceReportedPaths }
  | { kind: 'ignored_in_the_way'; path: string }
  | { kind: 'filtered_in_the_way' }
  | { kind: 'undecided' }
  | { kind: 'partly_applied' }
  | { kind: 'nothing_to_apply' }
  | { kind: 'too_large' }
  | { kind: 'name_not_allowed'; path: string }
  | { kind: 'case_only_rename'; path: string; other: string }
  | { kind: 'branch_exists'; branch: string }
  | { kind: 'invalid_branch' }
  | { kind: 'not_running' }
  | { kind: 'other'; failure: SpaceFailure };

// The refusals after which the host applies this space only as a branch; see "Apply" in the
// module documentation of `packages/web/server/lib/spaces`. The route is told once, at the
// refusal (decision 7), so the cases whose next step differs keep a sentence of their own: part of
// the last apply thrown away leaves files that stand in the way of the branch, a file git ignores
// or one a filter such as Git LFS keeps was there before the space, and a read that ran out of
// time says nothing about whether the work fits.
const CLOSING = new Set(['changes_do_not_apply', 'changes_route_closed', 'changes_blocked_by_link']);

const closingRefusalOf = (details: SpaceFailureDetails): SpaceApplyRefusal => {
  if (details.stillThere && details.stillThere.count > 0) return { kind: 'part_thrown_away', stillThere: details.stillThere };
  const ignored = details.ignoredInTheWay?.paths[0];
  if (ignored) return { kind: 'ignored_in_the_way', path: ignored };
  if (details.filteredInTheWay && details.filteredInTheWay.count > 0) return { kind: 'filtered_in_the_way' };
  return { kind: 'changes_closed' };
};

export const applyRefusalOf = (error: Error, branch: string | null): SpaceApplyRefusal => {
  if (!(error instanceof SpacesRequestError)) return { kind: 'other', failure: { code: 'space_request_failed', message: error.message } };
  const { code, details } = error;
  if (CLOSING.has(code)) return closingRefusalOf(details);
  switch (code) {
    case 'changes_undecided': return { kind: 'undecided' };
    case 'changes_partly_applied': return { kind: 'partly_applied' };
    case 'nothing_to_apply': return { kind: 'nothing_to_apply' };
    case 'changes_too_large':
    case 'patch_not_possible': return { kind: 'too_large' };
    case 'space_not_running': return { kind: 'not_running' };
    case 'invalid_branch_name': return { kind: 'invalid_branch' };
    case 'branch_exists': return { kind: 'branch_exists', branch: details.branch ?? branch ?? '' };
    case 'name_not_allowed_here':
      if (details.path) return { kind: 'name_not_allowed', path: details.path };
      break;
    case 'case_only_rename':
      if (details.path && details.other) return { kind: 'case_only_rename', path: details.path, other: details.other };
      break;
  }
  return { kind: 'other', failure: { code, message: error.message } };
};

/** Whether a refusal leaves the space applicable only as a branch from now on. */
export const closesChanges = (refusal: SpaceApplyRefusal): boolean => {
  switch (refusal.kind) {
    case 'changes_closed':
    case 'part_thrown_away':
    case 'ignored_in_the_way':
    case 'filtered_in_the_way':
    case 'undecided':
    case 'partly_applied': return true;
    default: return false;
  }
};

const insideSpace = (directory: string, spaceId: string): boolean => {
  const root = `/spaces/${spaceId}`;
  return directory === root || directory.startsWith(`${root}/`);
};

type StatusIndex = { activeSessionIds: ReadonlySet<string>; statusById: ReadonlyMap<string, { directory: string }> };

/** Whether a session in the space is working or retrying now, by the live status index. */
export const isAgentWorkingInSpace = (index: StatusIndex, spaceId: string): boolean => {
  for (const sessionId of index.activeSessionIds) {
    const entry = index.statusById.get(sessionId);
    if (entry && insideSpace(entry.directory, spaceId)) return true;
  }
  return false;
};

export const useAgentWorkingInSpace = (spaceId: string): boolean => useGlobalSessionStatusStore((state) => isAgentWorkingInSpace(state, spaceId));

type SpaceApplyResult =
  | { kind: 'applied'; outcome: SpaceApplyOutcome }
  | { kind: 'refused'; refusal: SpaceApplyRefusal }
  | { kind: 'overtaken' };

/**
 * Applies the space's work and reads the host's list again. A removal that followed and went
 * through in part stays on the group's status line as a failed delete, with Delete to try again.
 */
export const applySpace = async (spaceId: string, request: SpaceApplyRequest): Promise<SpaceApplyResult> => {
  const generation = spacesRuntimeGeneration();
  let outcome: SpaceApplyOutcome;
  try {
    outcome = await applySpaceWork(spaceId, request);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (generation !== spacesRuntimeGeneration()) return { kind: 'overtaken' };
    await refreshSpacesJourney().catch(() => {});
    return { kind: 'refused', refusal: applyRefusalOf(error, request.as === 'branch' ? request.branch : null) };
  }
  if (generation !== spacesRuntimeGeneration()) return { kind: 'overtaken' };
  if (outcome.applied.status === 'nothing_to_apply') return { kind: 'refused', refusal: { kind: 'nothing_to_apply' } };
  const removalFailure = outcome.removal?.failures[0] ?? null;
  if (removalFailure) useSpacesStore.getState().noteAction(spaceId, { kind: 'failed', action: 'remove', failure: removalFailure });
  if (outcome.removal && !removalFailure) {
    noteRemoval(spaceId, outcome.removal.chats);
    await forgetRemovedSpace(spaceId);
  } else await refreshSpacesJourney().catch(() => {});
  return { kind: 'applied', outcome };
};
