
import { failureOfError } from '@/components/session/spaces/spaceFailureText';
import { refreshSpaceArchives } from './space-archives';
import { refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
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

export type SpaceCondition =
  | { kind: 'busy'; action: SpaceAction }
  | { kind: 'action_failed'; action: SpaceAction; failure: SpaceFailure }
  | { kind: 'container_gone' }
  | { kind: 'gatekeeper_gone' }
  | { kind: 'stopped' }
  | { kind: 'stopped_idle' }
  | { kind: 'damaged' }
  | { kind: 'not_answering' }
  | { kind: 'unreachable'; machine: string | null; gone: boolean };

export const spaceConditionOf = (
  entry: SpaceEntry | undefined,
  mark: SpaceMark | undefined,
  action: SpaceActionState | undefined,
): SpaceCondition | null => {
  if (action?.kind === 'running') return { kind: 'busy', action: action.action };
  if (!entry || entry.state === 'preparing' || entry.state === 'failed') return null;
  if (action?.kind === 'failed' && spaceMenuActionsOf(entry).includes(action.action)) return { kind: 'action_failed', action: action.action, failure: action.failure };
  if (entry.state === 'missing') return { kind: 'container_gone' };
  if (entry.state === 'unreachable') return { kind: 'unreachable', machine: entry.machine, gone: entry.failure?.code === 'place_not_found' };
  if (entry.damage === 'gatekeeper_gone') return { kind: 'gatekeeper_gone' };
  if (entry.state === 'exited') return { kind: entry.stoppedIdle ? 'stopped_idle' : 'stopped' };
  if (entry.damage === 'repairable') return { kind: 'damaged' };
  if (mark && (mark.state === 'stale' || mark.state === 'unknown')) return { kind: 'not_answering' };
  return null;
};

export const spaceMenuActionsOf = (entry: SpaceEntry | undefined): SpaceAction[] => {
  if (!entry || entry.state === 'preparing' || entry.state === 'failed') return [];
  if (entry.state === 'unreachable') return entry.failure?.code === 'place_not_found' ? ['remove'] : [];
  if (entry.state === 'missing') return ['remove'];
  const gone = entry.damage === 'gatekeeper_gone';
  if (entry.state === 'exited') return gone ? ['remove'] : ['start', 'remove'];
  return gone ? ['stop', 'remove'] : ['restart_opencode', 'restart', 'setup', 'stop', 'remove'];
};

export const isSpaceApplicable = (entry: SpaceEntry | undefined): boolean => entry?.projectFolder.found !== false
  && (entry?.state === 'running' || (entry?.state === 'exited' && entry.damage !== 'gatekeeper_gone'));

export const isSpaceActionUnavailable = (entry: SpaceEntry | undefined, action: SpaceAction): boolean => (
  action === 'setup' && entry?.setup?.state === 'running'
);

type SpaceActionOptions = { deleteUnsavedChats?: boolean };

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
    case 'remove': return removeSpace(spaceId, options).then((outcome) => {
      noteRemoval(spaceId, outcome.chats);
      return outcome.failures[0] ?? null;
    });
  }
};

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
  if (generation !== spacesRuntimeGeneration()) return;
  const after = useSpacesStore.getState();
  if (unsaved) {
    after.noteAction(spaceId, null);
    after.openDeleteDialog(spaceId, unsaved);
    return;
  }
  if (failure) {
    after.noteAction(spaceId, { kind: 'failed', action, failure });
    await refreshSpacesJourney().catch(() => {});
    return;
  }
  if (action === 'remove') {
    await forgetRemovedSpace(spaceId);
    return;
  }
  if (action !== 'stop' && action !== 'setup') after.noteReachable(spaceId);
  await Promise.all([
    refreshSpacesJourney().catch(() => {}),
    action === 'start' || action === 'restart' || action === 'restart_opencode' ? readSessionListAfterAction() : Promise.resolve(),
  ]);
  if (generation !== spacesRuntimeGeneration()) return;
  useSpacesStore.getState().noteAction(spaceId, null);
};

const readSessionListAfterAction = async (): Promise<void> => {
  if (useGlobalSessionsStore.getState().status === 'loading') await refreshGlobalSessions().then(() => {}, () => {});
  await refreshGlobalSessions().then(() => {}, () => {});
};

export const forgetRemovedSpace = async (spaceId: string): Promise<void> => {
  const store = useSpacesStore.getState();
  const generation = spacesRuntimeGeneration();
  store.noteAction(spaceId, { kind: 'running', action: 'remove' });
  if (store.accessDialog?.spaceId === spaceId) store.closeAccessDialog();
  if (store.actionsSheet === spaceId) store.closeActionsSheet();
  if (store.applyDialog === spaceId) store.closeApplyDialog();
  await refreshSpacesJourney().catch(() => {});
  await refreshSpaceArchives().catch(() => {});
  await refreshGlobalSessions().then(() => {}, () => {});
  if (generation === spacesRuntimeGeneration()) useSpacesStore.getState().noteAction(spaceId, null);
};
