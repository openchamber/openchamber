
import { createSpace, type CreateSpaceRequest, type GrantRequest, type SpaceEntry, type SpaceFailure } from './spaces-api';
import { refreshSpacesJourney, useSpacesStore } from './spaces-store';
import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
  waitForPendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { noteSpaceModelAccess } from './space-model-access';
import type { SpaceSetupPlan } from './space-setup';
import { forgetSpaceCreationRequest, noteSpaceCreationRequest } from './space-creation-requests';

export type SpaceModelAccess = Extract<GrantRequest, { kind: 'model' | 'login' | 'custom' }>;

type CreationOutcome = { kind: 'ready'; directory: string } | { kind: 'failed'; failure: SpaceFailure };

const waitForOutcome = (spaceId: string): Promise<CreationOutcome> => new Promise((resolve) => {
  const gone: SpaceFailure = { code: 'space_missing', message: '' };
  const settle = (entry: SpaceEntry | undefined): boolean => {
    if (!entry) {
      resolve({ kind: 'failed', failure: gone });
      return true;
    }
    if (entry.state === 'failed' || entry.state === 'missing') {
      resolve({ kind: 'failed', failure: entry.failure ?? { code: 'space_creation_failed', message: '' } });
      return true;
    }
    if (entry.state === 'preparing' || entry.directory === null) return false;
    resolve({ kind: 'ready', directory: entry.directory });
    return true;
  };
  if (settle(useSpacesStore.getState().journey?.get(spaceId))) return;
  const unsubscribe = useSpacesStore.subscribe((state) => {
    if (settle(state.journey?.get(spaceId))) unsubscribe();
  });
});

const waitForSetup = (spaceId: string): Promise<void> => new Promise((resolve) => {
  const settled = (entry: SpaceEntry | undefined): boolean => (
    !entry || entry.state !== 'running' || (entry.setup?.state !== 'running' && entry.setup?.state !== 'queued')
  );
  if (settled(useSpacesStore.getState().journey?.get(spaceId))) {
    resolve();
    return;
  }
  const unsubscribe = useSpacesStore.subscribe((state) => {
    if (!settled(state.journey?.get(spaceId))) return;
    unsubscribe();
    resolve();
  });
});

type StartSpaceCreationOptions = {
  projectId: string;
  request: Omit<CreateSpaceRequest, 'setupCommands' | 'grants'>;
  setup: SpaceSetupPlan;
  access: readonly SpaceModelAccess[];
  refusalMessage: string;
};

export const startSpaceCreation = async ({ projectId, request, setup, access, refusalMessage }: StartSpaceCreationOptions): Promise<SpaceEntry> => {
  const entry = await createSpace({ ...request, setupCommands: setup.commands, grants: [...access] });
  useSpacesStore.getState().addJourneyEntry(entry);

  const requestId = createPendingDraftWorktreeRequest();
  noteSpaceCreationRequest(requestId, entry.id);
  if (entry.directory) noteSpaceModelAccess({ requestId, directory: entry.directory }, access.map((grant) => grant.provider));
  void waitForPendingDraftWorktreeRequest(requestId).catch(() => undefined);
  const sessionStore = useSessionUIStore.getState();
  const target = { directoryOverride: request.projectDirectory, pendingWorktreeRequestId: requestId, preserveDirectoryOverride: true };
  if (sessionStore.newSessionDraft?.open) sessionStore.overrideNewSessionDraftTarget({ projectId, ...target });
  else sessionStore.openNewSessionDraft({ selectedProjectId: projectId, ...target });

  void finishCreation(entry.id, requestId, access.length > 0, setup.waitBeforeSending && entry.setup?.state === 'queued', refusalMessage);
  return entry;
};

const finishCreation = async (spaceId: string, requestId: string, carriedAccess: boolean, waitForSetupCommands: boolean, refusalMessage: string): Promise<void> => {
  const outcome = await waitForOutcome(spaceId);
  if (outcome.kind === 'ready' && carriedAccess) await refreshSpacesJourney().catch(() => undefined);
  const failures = useSpacesStore.getState().journey?.get(spaceId)?.accessFailures ?? [];
  if (outcome.kind === 'ready' && failures.length === 0) {
    if (waitForSetupCommands) await waitForSetup(spaceId);
    resolvePendingDraftWorktreeRequest(requestId, outcome.directory, { keep: true });
    return;
  }
  forgetSpaceCreationRequest(requestId);
  rejectPendingDraftWorktreeRequest(requestId, new Error(refusalMessage));
  useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(requestId, null);
};
