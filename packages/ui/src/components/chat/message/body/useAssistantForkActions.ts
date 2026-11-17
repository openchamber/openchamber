import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { toast } from '@/components/ui';
import type { ForkSessionExecution } from '@/components/session/ForkSessionDialog';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { getMultiRunIdentity } from '@/lib/multirun/identity';
import { openParallelComposer } from '@/lib/multirun/openParallelComposer';
import { MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT } from '@/lib/messages/executionMeta';
import { WorktreeRequiresGitRepositoryError } from '@/lib/worktrees/worktreeCreate';

export const useAssistantForkActions = ({
    sessionId,
    messageId,
    effectiveDirectory,
    assistantPlanText,
}: {
    sessionId: string | undefined;
    messageId: string;
    effectiveDirectory: string | null | undefined;
    assistantPlanText: string;
}) => {
    const { t } = useI18n();
    const createSessionFromAssistantMessage = useSessionUIStore((state) => state.createSessionFromAssistantMessage);
    const getDirectoryForSession = useSessionUIStore((state) => state.getDirectoryForSession);
    const [isForkDialogOpen, setIsForkDialogOpen] = React.useState(false);
    const [isForkSubmitting, setIsForkSubmitting] = React.useState(false);

    const handleForkClick = React.useCallback(
        (event?: React.MouseEvent<HTMLButtonElement>) => {
            event?.stopPropagation();
            event?.preventDefault();
            if (!assistantPlanText.trim()) {
                return;
            }
            setIsForkDialogOpen(true);
        },
        [assistantPlanText]
    );

    const handleConfirmFork = React.useCallback(
        async (execution: ForkSessionExecution) => {
            setIsForkSubmitting(true);
            try {
                if (!sessionId) {
                    throw new Error('Source session is unavailable');
                }
                const sourceDirectory = effectiveDirectory ?? getDirectoryForSession(sessionId);
                if (!sourceDirectory) {
                    throw new Error('Source session directory is unavailable');
                }
                await createSessionFromAssistantMessage({
                    sessionId,
                    directory: sourceDirectory,
                    text: assistantPlanText,
                }, execution);
                setIsForkDialogOpen(false);
            } catch (error) {
                console.error('Failed to start a session from an assistant message:', error);
                if (error instanceof WorktreeRequiresGitRepositoryError) {
                    toast.error(t('rightSidebar.contextNotesTodo.toast.worktreeRequiresGitRepo'));
                    return;
                }

                const description = error instanceof Error ? error.message : undefined;
                toast.error(
                    t('rightSidebar.contextNotesTodo.toast.createSessionFailed'),
                    description ? { description } : undefined
                );
            } finally {
                setIsForkSubmitting(false);
            }
        },
        [assistantPlanText, createSessionFromAssistantMessage, effectiveDirectory, getDirectoryForSession, sessionId, t]
    );

    const handleForkFromHere = React.useCallback(() => {
        if (!sessionId) return;
        void useSessionUIStore.getState().forkAfterMessage(sessionId, messageId);
    }, [messageId, sessionId]);

    const handleForkMultiRun = React.useCallback(
        () => {
            if (!assistantPlanText.trim()) {
                return;
            }

            const prefilledPrompt = `${MULTIRUN_EXECUTION_FORK_PROMPT_META_TEXT}\n\n${assistantPlanText}`;
            openParallelComposer(prefilledPrompt);
        },
        [assistantPlanText]
    );

    const [askOtherModelsSession, setAskOtherModelsSession] = React.useState<Session | null>(null);
    const handleAskOtherModels = React.useCallback(() => {
        if (!sessionId) return;
        const session = useGlobalSessionsStore.getState().activeSessions.find((entry) => entry.id === sessionId);
        if (!session) return;
        const identity = getMultiRunIdentity(session);
        if (identity) {
            useUIStore.getState().setRunOverviewKey(identity.key);
            return;
        }
        setAskOtherModelsSession(session);
    }, [sessionId]);

    return {
        isForkDialogOpen,
        setIsForkDialogOpen,
        isForkSubmitting,
        handleForkClick,
        handleConfirmFork,
        handleForkFromHere,
        handleForkMultiRun,
        askOtherModelsSession,
        setAskOtherModelsSession,
        handleAskOtherModels,
    };
};
