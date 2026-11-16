import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDraftsStore } from '@/stores/useSessionDraftsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { spaceIdOfDirectory } from './space-route';

const goneSpaceOf = (directory: string | null | undefined, listed: ReadonlySet<string>): string | null => {
  const spaceId = spaceIdOfDirectory(directory);
  return spaceId && !listed.has(spaceId) ? spaceId : null;
};

const projectRootOf = (projectId: string | null | undefined): string | null =>
  (projectId ? useProjectsStore.getState().projects.find((project) => project.id === projectId)?.path ?? null : null);

type OpenDraftTarget = { workDraftId: string | undefined; directory: string | null | undefined };

const moveDraftsOfGoneSpaces = (listed: ReadonlySet<string>, draftsBefore: ReadonlySet<string>, openBefore: OpenDraftTarget): Promise<void> => {
  const drafts = useSessionDraftsStore.getState();
  const moves: Promise<void>[] = [];
  for (const draft of drafts.drafts) {
    if (!draftsBefore.has(draft.id) || !goneSpaceOf(draft.directory, listed)) continue;
    const root = projectRootOf(draft.projectId);
    if (root) moves.push(drafts.move(draft.id, root).catch(() => undefined));
  }
  const open = useSessionUIStore.getState().newSessionDraft;
  const unchanged = open.workDraftId === openBefore.workDraftId && open.directoryOverride === openBefore.directory;
  const openRoot = unchanged && open.open && !open.pendingWorktreeRequestId && goneSpaceOf(open.directoryOverride, listed) ? projectRootOf(open.selectedProjectId) : null;
  if (openRoot) {
    useSessionUIStore.getState().setDraftPreserveDirectoryOverride(false);
    useSessionUIStore.getState().setNewSessionDraftTarget({ projectId: open.selectedProjectId ?? null, directoryOverride: openRoot }, { force: true });
  }
  return Promise.all(moves).then(() => undefined);
};

export const prepareGoneSpaceDraftMove = (): ((listed: ReadonlySet<string>) => Promise<void>) => {
  const draftsBefore = new Set(useSessionDraftsStore.getState().drafts.map((draft) => draft.id));
  const open = useSessionUIStore.getState().newSessionDraft;
  const openBefore = { workDraftId: open.workDraftId, directory: open.directoryOverride };
  return (listed) => moveDraftsOfGoneSpaces(listed, draftsBefore, openBefore);
};
