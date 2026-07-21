import type { NewSessionDraftState } from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { QueuedMessage } from '@/stores/messageQueueStore';
import type { SessionGoalArm } from '@/stores/useSessionGoalArmStore';
import type { SyntheticContextPart } from '@/sync/input-store';

type ComposerSubmitTarget = {
  sessionId: string | null;
  draft: NewSessionDraftState | null;
};

type ComposerTargetState = {
  currentSessionId: string | null;
  newSessionDraft: NewSessionDraftState;
};

export const captureComposerSubmitTarget = (
  sessionId: string | null,
  draft: NewSessionDraftState | null,
): ComposerSubmitTarget => ({
  sessionId,
  draft: sessionId ? null : draft,
});

export const isCurrentComposerSubmitTarget = (
  target: ComposerSubmitTarget,
  current: ComposerTargetState,
): boolean => {
  if (target.sessionId) {
    return current.currentSessionId === target.sessionId;
  }

  const capturedDraft = target.draft;
  if (!capturedDraft?.open || current.currentSessionId !== null || !current.newSessionDraft.open) {
    return false;
  }

  return current.newSessionDraft === capturedDraft
    || (
      capturedDraft.draftToken !== undefined
      && current.newSessionDraft.draftToken === capturedDraft.draftToken
    );
};

export const shouldRestoreComposerText = (
  target: ComposerSubmitTarget,
  current: ComposerTargetState,
  currentInput: string,
  submittedInput: string,
): boolean => (
  isCurrentComposerSubmitTarget(target, current)
  && Boolean(submittedInput)
  && (!currentInput || currentInput === submittedInput)
);

/** Keep newly added files while restoring the failed transaction's files. */
export const mergeRecoveredAttachments = (
  recovered: AttachedFile[],
  current: AttachedFile[],
): AttachedFile[] => {
  const currentIds = new Set(current.map((file) => file.id));
  return [
    ...recovered.filter((file) => !currentIds.has(file.id)),
    ...current,
  ];
};

/** Context that follows a queued message while it is temporarily edited in the composer. */
export type QueuedMessageEditContext = {
  sessionId: string;
  syntheticParts?: SyntheticContextPart[];
  goalArm?: SessionGoalArm;
};

export const captureQueuedMessageEditContext = (
  sessionId: string,
  message: Pick<QueuedMessage, 'syntheticParts' | 'goalArm'>,
): QueuedMessageEditContext => ({
  sessionId,
  syntheticParts: message.syntheticParts,
  goalArm: message.goalArm,
});

export const getQueuedMessageEditContextForSession = (
  context: QueuedMessageEditContext | null,
  sessionId: string | null,
): QueuedMessageEditContext | null => (
  context?.sessionId === sessionId ? context : null
);

/**
 * Inline-comment drafts are keyed by their source session/draft key, so they
 * can be restored independently of whether that target is still selected.
 */
export const restoreCapturedInlineCommentDrafts = (
  sessionKey: string | null,
  drafts: InlineCommentDraft[],
  restoreDrafts: (sessionKey: string, drafts: InlineCommentDraft[]) => void,
): void => {
  if (!sessionKey || drafts.length === 0) return;
  restoreDrafts(sessionKey, drafts);
};

type ComposerGoalClaimInput = {
  content: string;
  inputMode: 'normal' | 'shell';
  hasExistingSession: boolean;
  hasQueuedPrimary: boolean;
  isMobile: boolean;
  isVSCode: boolean;
};

const getSlashCommandName = (content: string): string | null => {
  const normalized = content.trimStart();
  if (!normalized.startsWith('/')) return null;
  return normalized.slice(1).trim().split(/\s+/)[0]?.toLowerCase() || null;
};

/**
 * Local commands that do not create a chat send must leave the next-message
 * goal arm untouched. Commands that fall through to OpenCode still claim it.
 */
export const shouldClaimComposerGoal = ({
  content,
  inputMode,
  hasExistingSession,
  hasQueuedPrimary,
  isMobile,
  isVSCode,
}: ComposerGoalClaimInput): boolean => {
  if (inputMode !== 'normal' || content.trim().length === 0) return false;
  if (hasQueuedPrimary || !hasExistingSession) return true;

  const commandName = getSlashCommandName(content);
  if (!commandName) return true;
  if (commandName === 'handoff-review') return isMobile || isVSCode;

  return commandName !== 'undo'
    && commandName !== 'redo'
    && commandName !== 'timeline'
    && commandName !== 'compact';
};

/** Among queued messages, only the primary item can arm the batched send. */
export const resolveSubmitGoalArm = (
  composerGoalArm: SessionGoalArm,
  queuedMessages: Array<Pick<QueuedMessage, 'goalArm'>>,
  editedQueuedMessageGoalArm?: SessionGoalArm,
): SessionGoalArm => {
  if (composerGoalArm.armed) return composerGoalArm;
  return queuedMessages[0]?.goalArm ?? editedQueuedMessageGoalArm ?? composerGoalArm;
};
