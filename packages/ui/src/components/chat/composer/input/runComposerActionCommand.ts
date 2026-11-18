import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerHistorySearchState } from './useComposerHistorySearchState';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerColumn } from './useComposerColumn';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useI18n } from '@/lib/i18n';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import { type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import * as sessionActions from '@/sync/session-actions';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { toast } from '@/components/ui';
import { planLocalSlashCommand } from '../../composer/submit/slashCommands';
import { runForkCommand } from '../../composer/submit/forkCommand';
import type { ChatInputProps } from './chatInputProps';
import type { createComposerSubmitErrorMessage } from './createComposerSubmitErrorMessage';

type ActionCommandContext = Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'confirmedMentionsRef'>
    & Pick<ReturnType<typeof useComposerHistorySearchState>, 'setPromptHistorySearch'>
    & Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>
    & Pick<ReturnType<typeof useComposerColumn>, 'openTimelineDialog'>
    & Pick<ReturnType<typeof useI18n>, 't'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'persistDraftImmediately' | 'messageHistory'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'chatDraftIdentity' | 'isBtwActive' | 'setReviewDialogOpen' | 'currentDirectory'>
    & Pick<ReturnType<typeof useComposerExpansion>, 'setExpandedInput'>
    & Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>
    & Pick<ChatInputProps, 'scrollToBottom'>
    & Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'currentAgentName' | 'currentVariant'>
    & {
    commandPlan: NonNullable<ReturnType<typeof planLocalSlashCommand>>;
    currentSessionId: string;
    capturedSendConfig: QueuedMessage['sendConfig'];
    restoreComposerText: (target?: ChatDraftIdentity | null) => void;
    getSubmitErrorMessage: ReturnType<typeof createComposerSubmitErrorMessage>;
};

export async function runComposerActionCommand({
    setMessage, confirmedMentionsRef, persistDraftImmediately, chatDraftIdentity, messageHistory,
    setPromptHistorySearch, isBtwActive, setExpandedInput, isMobile, composerRef, currentSessionId,
    scrollToBottom, openTimelineDialog, setReviewDialogOpen, currentProviderId, currentModelId,
    currentAgentName, currentVariant, t, currentDirectory, getSubmitErrorMessage, commandPlan,
    capturedSendConfig, restoreComposerText,
}: ActionCommandContext) {
        const actionName = commandPlan.command.name;
        setMessage('');
        confirmedMentionsRef.current.clear();
        persistDraftImmediately(chatDraftIdentity, '');
        messageHistory.reset();
        setPromptHistorySearch(null);
        if (!isBtwActive) setExpandedInput(false);
        if (isMobile) composerRef.current?.blur();
        try {
            if (actionName === 'undo') {
                await useSessionUIStore.getState().handleSlashUndo(currentSessionId);
                scrollToBottom?.();
            } else if (actionName === 'redo') {
                await useSessionUIStore.getState().handleSlashRedo(currentSessionId);
                scrollToBottom?.();
            } else if (actionName === 'timeline') {
                openTimelineDialog();
            } else if (actionName === 'handoff-review') {
                setReviewDialogOpen(true);
            } else if (actionName === 'fork') {
                const forkOutcome = await runForkCommand(currentSessionId, commandPlan.command.argument, {
                    providerID: capturedSendConfig?.providerID ?? currentProviderId,
                    modelID: capturedSendConfig?.modelID ?? currentModelId,
                    agent: capturedSendConfig?.agent ?? currentAgentName,
                    variant: capturedSendConfig?.variant ?? currentVariant ?? undefined,
                }, {
                    fork: sessionActions.forkFromLastCompletedTurn,
                    directoryFor: (session) => useSessionUIStore.getState().getDirectoryForSession(session.id) || session.directory || null,
                    send: (text, selection, target) => useSessionUIStore.getState().sendMessage(
                        text,
                        selection.providerID,
                        selection.modelID,
                        selection.agent,
                        undefined,
                        undefined,
                        undefined,
                        selection.variant,
                        'normal',
                        target,
                    ),
                    draftIdentity: (directory, sessionId) => createChatDraftIdentity(getRuntimeKey(), directory, sessionId),
                    restoreText: (target, text) => useInputStore.setState({ pendingComposerRestore: { target, text, files: [] } }),
                });
                if (forkOutcome === 'send-failed') toast.error(t('chat.chatInput.toast.forkSendFailed'));
            } else if (actionName === 'compact') {
                await sessionActions.waitForConnectionOrThrow();
                const compactDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId) || currentDirectory || undefined;
                await sessionActions.compactSession(
                    currentSessionId,
                    currentProviderId && currentModelId
                        ? { providerID: currentProviderId, modelID: currentModelId, variant: currentVariant }
                        : null,
                    compactDirectory,
                );
            }
        } catch (error) {
            restoreComposerText();
            if (actionName === 'fork') {
                toast.error(error instanceof sessionActions.NothingToForkError
                    ? t('chat.chatInput.toast.forkNothingToFork')
                    : getSubmitErrorMessage(error, t('chat.chatInput.toast.forkFailed')));
                return;
            }
            if (actionName !== 'compact') throw error;
            toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.compactFailed')));
        }
        return;
    }
