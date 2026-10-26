import React from 'react';
import { toast } from 'sonner';
import { useChatSessionSelection, type ChatColumnSession } from '@/components/chat/chatColumnSession';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** MCP connections belong to the directory that will run the first turn. */
export const useMcpDirectory = (active: boolean, selection?: ChatColumnSession): string | null => {
  const { t } = useI18n();
  const currentSelection = useChatSessionSelection();
  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);
  const sessionId = selection ? selection.sessionId : currentSelection.sessionId;
  const draftId = useSessionUIStore((state) => (
    !sessionId && state.newSessionDraft.open && state.newSessionDraft.target === 'chat'
      ? state.newSessionDraft.draftId
      : null
  ));
  const preparedDirectory = useSessionUIStore((state) => state.newSessionDraft.preparedChatDirectory);
  const draftDirectory = useSessionUIStore((state) => state.newSessionDraft.open
    ? state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride
    : null);
  const prepareDirectory = useSessionUIStore((state) => state.prepareChatDraftDirectory);

  // First send clears preparedChatDirectory as it adopts the folder. Prepare
  // on activation or a new draft, so that handoff cannot create another one.
  React.useEffect(() => {
    if (!active || draftId === null) return;
    let cancelled = false;
    void prepareDirectory().catch((error) => {
      // The header dropdown and the status panel can both be mounted and
      // catch the same failure; one id keeps it to one toast.
      if (!cancelled) toast.error(error instanceof Error ? error.message : t('mcpDropdown.status.unknownError'), { id: 'mcp-draft-directory' });
    });
    return () => { cancelled = true; };
  }, [active, draftId, prepareDirectory, t]);

  // Until preparation completes, no status read or mutation may fall back to
  // the previous chat or the shared Chats root. Sending reuses this directory.
  if (draftId !== null) return preparedDirectory ?? null;
  if (selection) return selection.directory;
  if (sessionId) return currentSelection.directory;
  return draftDirectory ?? fallbackDirectory ?? null;
};
