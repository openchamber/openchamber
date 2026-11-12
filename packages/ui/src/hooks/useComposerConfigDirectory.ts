import { useMemo } from 'react';
import { useChatColumnActions, useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { resolveCommandDirectory } from '@/stores/useCommandsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Only the draft's composer follows its pending or resolved start folder. */
export const useComposerConfigDirectory = (directory: string | null | undefined) => {
  const { sessionId } = useChatSessionSelection();
  const { pinned } = useChatColumnActions();
  const draft = useSessionUIStore((state) => state.newSessionDraft);
  return useMemo(
    () => resolveCommandDirectory(directory, !pinned && !sessionId ? draft : null),
    [directory, draft, pinned, sessionId],
  );
};
