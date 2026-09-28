// A creation started from the create dialog, carried to its end in this window: the space is asked
// for, its group appears at once, a new-session draft opens on it, and the first message the user
// sends waits for the space the way a draft waits for a new worktree (`pendingDraftWorktree.ts`).
// When the space is ready the model access chosen in the dialog is given, and only then is the
// waiting message let through; a message on a model the space was not given never leaves the
// composer (`space-model-access.ts`). The access chosen lives in
// this window's memory until it is given, a typed key and the name of an environment variable
// alike: a reload in the middle loses all of it, and the space's group then says it has no model
// access, with the way to the grant dialog.

import { createSpace, grantSpaceAccess, SpacesRequestError, type CreateSpaceRequest, type GrantRequest, type SpaceEntry, type SpaceFailure } from './spaces-api';
import { refreshSpacesJourney, useSpacesStore, type SpaceAccessFailure } from './spaces-store';
import {
  createPendingDraftWorktreeRequest,
  rejectPendingDraftWorktreeRequest,
  resolvePendingDraftWorktreeRequest,
  waitForPendingDraftWorktreeRequest,
} from '@/lib/worktrees/pendingDraftWorktree';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { noteSpaceModelAccess } from './space-model-access';

export type SpaceModelAccess = Extract<GrantRequest, { kind: 'model' }>;

type CreationOutcome = { kind: 'ready'; directory: string } | { kind: 'failed'; failure: SpaceFailure };

// The draft requests that wait for a space rather than a worktree, by the space they wait for, so
// the draft can say which, and name the space once it is ready.
const spaceRequests = new Map<string, string>();

/** Forgets the waiting requests; the runtime their spaces were asked of is gone. */
export const resetSpaceCreationRequests = (): void => {
  spaceRequests.clear();
};

export const isSpaceCreationRequest = (requestId: string | null | undefined): boolean => Boolean(requestId && spaceRequests.has(requestId));

/** The space a draft waits for, or null when the draft waits for nothing of this kind. */
export const spaceOfCreationRequest = (requestId: string | null | undefined): string | null => (requestId ? spaceRequests.get(requestId) ?? null : null);

/**
 * Resolves once the list says the space is ready or its making failed; the host announces both.
 * A space that leaves the list, the host having restarted in the middle among the reasons, or a
 * list that is gone with a runtime switch or the switch turned off, counts as failed: the waiting
 * message must come back rather than wait for ever.
 */
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

const giveAccess = async (spaceId: string, access: readonly SpaceModelAccess[]): Promise<SpaceAccessFailure[]> => {
  const failures: SpaceAccessFailure[] = [];
  for (const grant of access) {
    try {
      useSpacesStore.getState().noteGrantGiven(spaceId, await grantSpaceAccess(spaceId, grant));
    } catch (error) {
      failures.push({
        provider: grant.provider,
        code: error instanceof SpacesRequestError ? error.code : 'space_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
};

type StartSpaceCreationOptions = {
  projectId: string;
  request: CreateSpaceRequest;
  access: readonly SpaceModelAccess[];
  /** The text a waiting message is refused with when the space cannot take it, already translated. */
  refusalMessage: string;
};

/**
 * Asks the host for the space and answers once it has an id, so the dialog can close; a refusal of
 * the request itself (Docker gone since the dialog checked, a project the host lost) throws here,
 * for the dialog to show. Everything after that runs on its own and ends in the space's group.
 */
export const startSpaceCreation = async ({ projectId, request, access, refusalMessage }: StartSpaceCreationOptions): Promise<SpaceEntry> => {
  const entry = await createSpace(request);
  useSpacesStore.getState().addJourneyEntry(entry);

  const requestId = createPendingDraftWorktreeRequest();
  spaceRequests.set(requestId, entry.id);
  if (entry.directory) noteSpaceModelAccess({ requestId, directory: entry.directory }, access.map((grant) => grant.provider));
  // A draft that is never sent must not turn a refusal into an unhandled rejection.
  void waitForPendingDraftWorktreeRequest(requestId).catch(() => undefined);
  const sessionStore = useSessionUIStore.getState();
  const target = { directoryOverride: request.projectDirectory, pendingWorktreeRequestId: requestId, preserveDirectoryOverride: true };
  if (sessionStore.newSessionDraft?.open) sessionStore.overrideNewSessionDraftTarget({ projectId, ...target });
  else sessionStore.openNewSessionDraft({ selectedProjectId: projectId, ...target });

  void finishCreation(entry.id, requestId, access, refusalMessage);
  return entry;
};

const finishCreation = async (spaceId: string, requestId: string, access: readonly SpaceModelAccess[], refusalMessage: string): Promise<void> => {
  const outcome = await waitForOutcome(spaceId);
  let failures: SpaceAccessFailure[] = [];
  if (outcome.kind === 'ready' && access.length > 0) {
    useSpacesStore.getState().noteCreationAccess(spaceId, { kind: 'giving' });
    failures = await giveAccess(spaceId, access);
    // The list learns the grants before the message is let through: a running space's model
    // check reads them there.
    await refreshSpacesJourney().catch(() => undefined);
    useSpacesStore.getState().noteCreationAccess(spaceId, failures.length > 0 ? { kind: 'failed', failures } : null);
  }
  if (outcome.kind === 'ready' && failures.length === 0) {
    // The draft stays where it is until its message is sent: moving it now would move the
    // composer to another directory's draft and hide what the user is typing. The send finds
    // the space's directory through the kept request, and moves the draft then.
    resolvePendingDraftWorktreeRequest(requestId, outcome.directory, { keep: true });
    return;
  }
  spaceRequests.delete(requestId);
  // The waiting message goes back to the composer; the group says why.
  rejectPendingDraftWorktreeRequest(requestId, new Error(refusalMessage));
  useSessionUIStore.getState().resolvePendingDraftWorktreeTarget(requestId, null);
};
