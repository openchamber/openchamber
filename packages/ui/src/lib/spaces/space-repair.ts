// A space's state and its repair (DESIGN.md, user journey step 8): what the group's status line
// says about a space that is stopped, broken or not answering, which actions its menu offers, and
// the actions themselves, from soft to hard: start, restart OpenCode, restart the container, stop,
// delete. What the host lists is the authority; this window only adds the action it has under way
// or the one that failed, so the line can say so. Since 5d-4 the menu of a running space also runs
// the project's setup commands again.

import { failureOfError } from '@/components/session/spaces/spaceFailureText';
import { refreshSpaceArchives } from './space-archives';
import { refreshGlobalSessions } from '@/stores/useGlobalSessionsStore';
import {
  SpacesRequestError,
  removeSpace,
  restartSpace,
  restartSpaceOpenCode,
  startSpace,
  stopSpace,
  type SpaceEntry,
  type SpaceFailure,
} from './spaces-api';
import { refreshSpacesJourney, spacesRuntimeGeneration, useSpacesStore, type SpaceAction, type SpaceActionState, type SpaceMark, type SpaceUnsavedChats } from './spaces-store';
import { runSpaceSetupAgain } from './space-setup';

/**
 * What is wrong with a space that exists, in the order the status line tells it: an action under
 * way or failed first, then what the host lists. Null for a space that runs and answers, and for
 * one that is being made or whose making failed, which the creation's own line covers.
 */
export type SpaceCondition =
  | { kind: 'busy'; action: SpaceAction }
  | { kind: 'action_failed'; action: SpaceAction; failure: SpaceFailure }
  | { kind: 'container_gone' }
  | { kind: 'gatekeeper_gone' }
  | { kind: 'stopped' }
  | { kind: 'stopped_idle' }
  | { kind: 'damaged' }
  | { kind: 'not_answering' };

export const spaceConditionOf = (
  entry: SpaceEntry | undefined,
  mark: SpaceMark | undefined,
  action: SpaceActionState | undefined,
): SpaceCondition | null => {
  if (action?.kind === 'running') return { kind: 'busy', action: action.action };
  if (!entry || entry.state === 'preparing' || entry.state === 'failed') return null;
  // A failure is shown only while its action still fits what the host lists: a restart refused
  // because the space had stopped meanwhile gives way to "stopped" and its Start, rather than
  // offering the same refused restart again and again.
  if (action?.kind === 'failed' && spaceMenuActionsOf(entry).includes(action.action)) return { kind: 'action_failed', action: action.action, failure: action.failure };
  if (entry.state === 'missing') return { kind: 'container_gone' };
  if (entry.damage === 'gatekeeper_gone') return { kind: 'gatekeeper_gone' };
  if (entry.state === 'exited') return { kind: entry.stoppedIdle ? 'stopped_idle' : 'stopped' };
  if (entry.damage === 'repairable') return { kind: 'damaged' };
  // The session list did not get an answer from the space the last time the host asked.
  if (mark && (mark.state === 'stale' || mark.state === 'unknown')) return { kind: 'not_answering' };
  return null;
};

/**
 * The actions the group's menu offers for a space, in order. A restart needs a running space
 * with a gatekeeper that a start can bring back; one whose gatekeeper is gone can only be stopped
 * or deleted. Nothing for a space that is being made or whose making failed.
 */
export const spaceMenuActionsOf = (entry: SpaceEntry | undefined): SpaceAction[] => {
  if (!entry || entry.state === 'preparing' || entry.state === 'failed') return [];
  if (entry.state === 'missing') return ['remove'];
  const gone = entry.damage === 'gatekeeper_gone';
  if (entry.state === 'exited') return gone ? ['remove'] : ['start', 'remove'];
  return gone ? ['stop', 'remove'] : ['restart_opencode', 'restart', 'setup', 'stop', 'remove'];
};

/**
 * Whether the space's work can be applied from its menu: a running space, or a stopped one that a
 * start brings back, which the apply dialog offers. A stopped space whose gatekeeper is gone never
 * starts again, so its work cannot be reached. Nor can a space whose project folder is gone from
 * the host: its work has nowhere to go.
 */
export const isSpaceApplicable = (entry: SpaceEntry | undefined): boolean => entry?.projectFolder.found !== false
  && (entry?.state === 'running' || (entry?.state === 'exited' && entry.damage !== 'gatekeeper_gone'));

/** An action of the menu that cannot run now: the setup commands again while they still run. */
export const isSpaceActionUnavailable = (entry: SpaceEntry | undefined, action: SpaceAction): boolean => (
  action === 'setup' && entry?.setup?.state === 'running'
);

type SpaceActionOptions = { deleteUnsavedChats?: boolean };

/** A removal went through: its chats are on the Archive page, and the notice says so. */
export const noteRemoval = (spaceId: string, chats: { saved: number } | null): void => {
  if (!chats || chats.saved === 0) return;
  const store = useSpacesStore.getState();
  store.noteChatsArchived(store.journey?.get(spaceId)?.name ?? null);
};

const call = (spaceId: string, action: SpaceAction, options: SpaceActionOptions): Promise<SpaceFailure | null> => {
  switch (action) {
    case 'start': return startSpace(spaceId).then(() => null);
    case 'stop': return stopSpace(spaceId).then(() => null);
    case 'restart': return restartSpace(spaceId).then(() => null);
    case 'restart_opencode': return restartSpaceOpenCode(spaceId).then(() => null);
    case 'setup': {
      const entry = useSpacesStore.getState().journey?.get(spaceId);
      if (!entry) return Promise.resolve({ code: 'space_not_found', message: '' });
      return runSpaceSetupAgain(entry).then(() => null);
    }
    // A removal can go through in part; what stayed is the failure the line shows.
    case 'remove': return removeSpace(spaceId, options).then((outcome) => {
      noteRemoval(spaceId, outcome.chats);
      return outcome.failures[0] ?? null;
    });
  }
};

/**
 * Runs one action on a space, one at a time per space in this window, and reads the host's list
 * again afterwards whatever the outcome, because a failed restart may have left the space
 * stopped. A start or a restart that went through answered once the server inside was ready, so
 * the space is reachable again. The failure stays on the status line until the next action.
 */
export const runSpaceAction = async (spaceId: string, action: SpaceAction, options: SpaceActionOptions = {}): Promise<void> => {
  const store = useSpacesStore.getState();
  if (store.actions.get(spaceId)?.kind === 'running') return;
  const generation = spacesRuntimeGeneration();
  store.noteAction(spaceId, { kind: 'running', action });
  let failure: SpaceFailure | null;
  let unsaved: SpaceUnsavedChats | null = null;
  try {
    failure = await call(spaceId, action, options);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure = failureOfError(error);
    if (error instanceof SpacesRequestError && error.code === 'chats_not_saved') {
      unsaved = { tooLarge: error.details.tooLarge ?? [], failed: error.details.failed ?? 0 };
    }
  }
  // An action a runtime switch overtook belongs to the runtime it ran on; nothing of it is kept.
  if (generation !== spacesRuntimeGeneration()) return;
  const after = useSpacesStore.getState();
  // The space stayed because its chats could not be saved: the confirmation asks again.
  if (unsaved) {
    after.noteAction(spaceId, null);
    after.openDeleteDialog(spaceId, unsaved);
    return;
  }
  after.noteAction(spaceId, failure ? { kind: 'failed', action, failure } : null);
  if (!failure && action === 'remove') {
    await forgetRemovedSpace(spaceId);
    return;
  }
  if (!failure && action !== 'stop' && action !== 'setup') after.noteReachable(spaceId);
  // The action's outcome stands on its own: a list that cannot be read now is read at the next turn.
  await refreshSpacesJourney().catch(() => {});
};

/**
 * What this window drops once the host removed a space, by a delete or after an apply: its
 * dialogs, then the host's lists read again.
 */
export const forgetRemovedSpace = async (spaceId: string): Promise<void> => {
  const store = useSpacesStore.getState();
  store.noteCreationAccess(spaceId, null);
  if (store.accessDialog?.spaceId === spaceId) store.closeAccessDialog();
  if (store.actionsSheet === spaceId) store.closeActionsSheet();
  if (store.applyDialog === spaceId) store.closeApplyDialog();
  await refreshSpacesJourney().catch(() => {});
  // Its chats are on the Archive page now, under the space's name.
  await refreshSpaceArchives().catch(() => {});
  // The sidebar's group of a space comes from the session list's mark as well, which the host
  // drops only in its next complete list; without asking for it now, a space the user just
  // deleted stayed in the sidebar for about forty seconds, measured.
  await refreshGlobalSessions().then(() => {}, () => {});
};
