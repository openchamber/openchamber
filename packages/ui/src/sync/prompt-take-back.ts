import type { TextPart, FilePart } from '@/lib/opencode/model';
import { selectUnansweredPrompt } from './unanswered-prompt';
import { opencodeClient } from '@/lib/opencode/client';
import { attachmentBasename, withMissingCitations } from '@/lib/attachmentIdentity';
import { createChatDraftIdentity, readChatDraft } from '@/lib/chatDraftPersistence';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { afterDelay } from '@/lib/timing/afterDelay';
import { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useInputStore } from './input-store';
import { transcriptCutForMessage } from './transcript-cut';
import { hideRevertBar, showRevertBar } from './revert-bar-visibility';
import {
  abortCurrentOperation,
  contextCarriersForMessage,
  dirStoreForSession,
  refetchSessionMessages,
  restoreContextPartsToInput,
  restoreFilePartsToInput,
  runRevertOperation,
} from './session-actions';

const SETTLE_TIMEOUT_MS = 5_000;

const readUnansweredPrompt = (sessionId: string) => {
  const state = dirStoreForSession(sessionId).store.getState();
  return selectUnansweredPrompt(state.message[sessionId] ?? [], (messageID) => state.part[messageID] ?? []);
};

const composerIsEmpty = (sessionId: string, directory: string | undefined) => {
  const identity = createChatDraftIdentity(getRuntimeKey(), directory, sessionId);
  const comments = directory ? useInlineCommentDraftStore.getState().getDrafts({ directory, sessionKey: sessionId }) : [];
  return readChatDraft(identity).text.trim() === '' && useInputStore.getState().getAttachedFiles(identity).length === 0 && comments.length === 0;
};

const queueIsEmpty = (sessionId: string, directory: string | undefined) => {
  const target = createMessageQueueTarget(sessionId, directory);
  return !target || (useMessageQueueStore.getState().queuedMessages[getMessageQueueKey(target)]?.length ?? 0) === 0;
};

const canTakeBack = (sessionId: string) => {
  const { store, directory } = dirStoreForSession(sessionId);
  const session = store.getState().session.find((candidate) => candidate.id === sessionId);
  return Boolean(session && !session.parentID && !session.revert)
    && queueIsEmpty(sessionId, directory)
    && composerIsEmpty(sessionId, directory);
};

const settlesIdle = (sessionId: string) => new Promise<boolean>((resolve) => {
  const { store } = dirStoreForSession(sessionId);
  const isIdle = () => (store.getState().session_status[sessionId]?.type ?? 'idle') === 'idle';
  if (isIdle()) return resolve(true);
  const cancelDeadline = afterDelay(SETTLE_TIMEOUT_MS, () => finish(false));
  const unsubscribe = store.subscribe(() => {
    if (isIdle()) finish(true);
  });
  function finish(idle: boolean) {
    cancelDeadline();
    unsubscribe();
    resolve(idle);
  }
});

const restorePrompt = (sessionId: string, directory: string | undefined, text: string, files: readonly FilePart[], carriers: ReturnType<typeof contextCarriersForMessage>) => {
  const restored = withMissingCitations(text, files.filter((part) => part.url).map((part) => ({ filename: attachmentBasename(part.filename ?? 'attachment') })));
  if (restored) useInputStore.getState().setPendingSessionRestore(sessionId, restored);
  if (files.length > 0) restoreFilePartsToInput(files, createChatDraftIdentity(getRuntimeKey(), directory, sessionId));
  if (carriers.length > 0 && directory) restoreContextPartsToInput(carriers, { directory, sessionKey: sessionId });
};

const takeBackPrompt = async (sessionId: string, promptID: string, isCurrentRuntime: () => boolean) => {
  if (!await settlesIdle(sessionId)) return;
  await refetchSessionMessages(sessionId);
  const prompt = readUnansweredPrompt(sessionId);
  const { store, directory } = dirStoreForSession(sessionId);
  if (!isCurrentRuntime() || prompt?.id !== promptID || !composerIsEmpty(sessionId, directory)) return;
  const state = store.getState();
  const messages = state.message[sessionId] ?? [];
  const parts = state.part[prompt.id] ?? [];
  const text = parts.filter((part): part is TextPart => part.type === 'text').map((part) => part.text).join('\n').trim();
  const files = parts.filter((part): part is FilePart => part.type === 'file');
  const carriers = contextCarriersForMessage(messages, prompt.id);
  const boundary = transcriptCutForMessage(messages, prompt.id);
  hideRevertBar(sessionId, boundary);
  let staged = false;
  try {
    await runRevertOperation(sessionId, async () => {
      await opencodeClient.stageRevert(sessionId, boundary, { files: false, directory });
      staged = true;
      await opencodeClient.commitRevert(sessionId, directory);
    }, false);
  } catch (error) {
    showRevertBar(sessionId, boundary);
    if (staged) await opencodeClient.clearRevert(sessionId, directory).catch(() => undefined);
    throw error;
  }
  if (isCurrentRuntime()) restorePrompt(sessionId, directory, text, files, carriers);
};

export async function stopCurrentOperation(sessionId: string): Promise<void> {
  const promptID = canTakeBack(sessionId) ? readUnansweredPrompt(sessionId)?.id : undefined;
  if (!promptID) return abortCurrentOperation(sessionId);
  const isCurrentRuntime = captureRuntimeInstance();
  const { directory } = dirStoreForSession(sessionId);
  try {
    if (!await opencodeClient.abortSession(sessionId, directory)) return;
  } catch (error) {
    console.error('[session-actions] abort failed', error);
    return;
  }
  await takeBackPrompt(sessionId, promptID, isCurrentRuntime).catch((error) => console.warn('[session-actions] taking the prompt back failed', error));
}
