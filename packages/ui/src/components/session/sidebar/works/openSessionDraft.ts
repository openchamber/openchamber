import { toServerFileUrl } from '@/components/chat/composer/attachments/filePaths';
import { attachmentBasename, withMissingCitations } from '@/lib/attachmentIdentity';
import { createChatDraftIdentity, getChatDraftIdentityKey, workDraftComposerKey } from '@/lib/chatDraftPersistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { hasUnsyncedSessionDraft, readSessionDraftAttachment, type SessionDraft } from '@/stores/useSessionDraftsStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

const isDraftOpen = (draftId: string): boolean => {
  const state = useSessionUIStore.getState();
  return !state.currentSessionId && state.newSessionDraft.open && state.newSessionDraft.workDraftId === draftId;
};

export async function openSessionDraft(draft: SessionDraft): Promise<boolean> {
  useSessionUIStore.getState().openNewSessionDraft({
    selectedProjectId: draft.projectId ?? undefined,
    directoryOverride: draft.directory,
    workDraftId: draft.id,
    targetFolderId: draft.targetFolderId,
  });
  if (hasUnsyncedSessionDraft(draft.id)) return true;
  const target = createChatDraftIdentity(getRuntimeKey(), draft.directory, workDraftComposerKey(draft.id));
  if (!target) return true;
  const pathFiles = draft.attachments.flatMap((attachment) => (
    attachment.kind === 'path' && attachment.path
      ? [{ url: toServerFileUrl(attachment.path), mimeType: attachment.mimeType, filename: attachment.filename }]
      : []
  ));
  const text = withMissingCitations(draft.text, draft.attachments.map((attachment) => ({ filename: attachmentBasename(attachment.filename) })));
  useInputStore.setState({ pendingComposerRestore: { target, text, files: pathFiles } });

  const stored = draft.attachments.filter((attachment) => attachment.kind === 'data');
  if (stored.length === 0) return true;
  const downloaded = await Promise.all(stored.map(async (attachment) => {
    const url = await readSessionDraftAttachment(draft.id, attachment);
    return url ? { url, mimeType: attachment.mimeType, filename: attachment.filename } : null;
  }));
  const files = downloaded.flatMap((file) => (file ? [file] : []));
  if (!isDraftOpen(draft.id)) return true;
  const input = useInputStore.getState();
  const pending = input.pendingComposerRestore;
  if (pending && getChatDraftIdentityKey(pending.target) === getChatDraftIdentityKey(target)) {
    useInputStore.setState({ pendingComposerRestore: { ...pending, files: [...pending.files, ...files] } });
  } else {
    for (const file of files) input.addRestoredAttachment(file);
  }
  return files.length === stored.length;
}
