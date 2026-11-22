import React from 'react';
import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerDraftTarget } from './useComposerDraftTarget';
import type { useComposerColumn } from './useComposerColumn';
import type { ComposerSendHandlers } from './composerSendHandlers';
import type { SubmitOptions } from './chatInputProps';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { queuedMessageFromTakenItem, type QueuedMessage, type QueuedMessageInput } from '@/stores/messageQueueStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useGoalSpecJobStore } from '@/stores/useGoalSpecJobStore';
import { useGoalSpecJobSync } from '@/hooks/useGoalSpecJobSync';
import { isGoalCheckAvailableNow } from '@/hooks/useSessionGoal';
import { planGoalWriter, requestGoalSpec, type GoalSubmitChoice } from '@/lib/goalWriter';
import { createGoalSpecJob, takeGoalSpecJob, type GoalSpecJobWriterInput } from '@/lib/goalSpecJobs';
import { getSessionGoal } from '@/lib/sessionGoalMetadata';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { fetchResponseStyleInstruction } from '@/lib/responseStyle';
import { wrapSystemReminder } from '@/lib/systemReminder';
import { isVSCodeRuntime } from '@/lib/desktop';
import { shouldAutoCreateDraftWorktree, startAutoDraftWorktree } from '@/lib/worktrees/autoDraftWorktree';
import { selectWorktreeStartFrom } from '@/lib/worktrees/worktreeStartSource';
import { useSessionUIStore, type NewSessionDraftState } from '@/sync/session-ui-store';
import { getAllSyncSessionMap } from '@/sync/sync-refs';
import { useInputStore } from '@/sync/input-store';
import * as sessionActions from '@/sync/session-actions';
import { toast } from '@/components/ui';
import { collectGoalWriterContext } from '@/components/chat/goalWriterContext';
import type { GoalSpecDialogRequest, GoalWriterHandoff, GoalWriterRunOptions } from '@/components/chat/GoalSpecDialog';
import { recordLinkedReferences } from './recordLinkedReferences';
import { createComposerSubmitErrorMessage } from './createComposerSubmitErrorMessage';

type DraftTargetInfo = Pick<ReturnType<typeof useComposerDraftTarget>, 'showDraftTargetSelectors' | 'selectedDraftProject' | 'selectedDraftProjectIsGitRepo'>;

type Dependencies = {
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'confirmedMentionsRef' | 'currentChatDraftIdentityRef'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'chatDraftIdentity' | 'currentSessionId' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'newSessionDraftOpen' | 'newSessionDraft' | 'clearAttachedFiles' | 'isBtwActive' | 'inputMode'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'currentAgentName' | 'currentVariant'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'restoreDraft' | 'persistDraftImmediately' | 'messageHistory'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'setLinkedReferencesFor'>;
    queueActions: Pick<ReturnType<typeof useComposerQueueActions>, 'captureComposerMessage' | 'restoreQueuedContext'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'composerQueuedMessages'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase' | 'autoReviewRunning'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'columnPinned'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'runtimeSourceControl'>;
    /** Read when a send runs: the draft target hook mounts after the send hooks. */
    draftTargetRef: React.RefObject<DraftTargetInfo | null>;
};

type PendingGoalWriterSend = {
    message: string;
    delivery?: 'steer';
    identity: ChatDraftIdentity | null;
    writerInputFor: (options: GoalWriterRunOptions) => Promise<GoalSpecJobWriterInput>;
};

const sameDraftIdentity = (a: ChatDraftIdentity | null, b: ChatDraftIdentity | null): boolean => (
    a === null || b === null ? a === b : getChatDraftIdentityKey(a) === getChatDraftIdentityKey(b)
);

/**
 * The goal writer around the composer's send: the dialog that turns a message
 * into a goal spec, the server job behind "Send when ready", and the draft
 * worktree a first prompt starts.
 */
export function useComposerGoalWriter({
    i18n, sendHandlers, draftText, sessionScope, selection, draftHistory, referenceDrafts, queueActions,
    sendAvailability, sessionLifecycle, column, runtime, draftTargetRef,
}: Dependencies) {
    const { t } = i18n;
    const { handleSubmitRef } = sendHandlers;
    const { setMessage, confirmedMentionsRef, currentChatDraftIdentityRef } = draftText;
    const {
        chatDraftIdentity, currentSessionId, currentSessionDirectoryForSync, currentDirectory,
        newSessionDraftOpen, newSessionDraft, clearAttachedFiles, isBtwActive, inputMode,
    } = sessionScope;
    const { currentProviderId, currentModelId, currentAgentName, currentVariant } = selection;
    const { restoreDraft, persistDraftImmediately, messageHistory } = draftHistory;
    const { setLinkedReferencesFor } = referenceDrafts;
    const { captureComposerMessage, restoreQueuedContext } = queueActions;
    const { composerQueuedMessages } = sendAvailability;
    const { sessionPhase, autoReviewRunning } = sessionLifecycle;
    const { columnPinned } = column;
    const { runtimeSourceControl } = runtime;
    const getSubmitErrorMessage = createComposerSubmitErrorMessage(t);

    // A send waiting on the goal writer: the dialog's request and the
    // message it was written from, which the chosen send uses. Both belong to
    // the composer they were asked from: a choice made after the composer
    // moved to another session or draft would send there instead.
    const [goalWriterRequest, setGoalWriterRequest] = React.useState<GoalSpecDialogRequest | null>(null);
    const goalWriterRequestIdRef = React.useRef(0);
    const goalWriterPendingRef = React.useRef<PendingGoalWriterSend | null>(null);
    const cancelGoalWriter = React.useCallback(() => {
        goalWriterPendingRef.current = null;
        setGoalWriterRequest(null);
    }, []);
    React.useEffect(() => {
        cancelGoalWriter();
    }, [cancelGoalWriter, chatDraftIdentity]);
    const handleGoalWriterChoice = React.useCallback((choice: GoalSubmitChoice) => {
        const pending = goalWriterPendingRef.current;
        goalWriterPendingRef.current = null;
        setGoalWriterRequest(null);
        if (!pending || !sameDraftIdentity(pending.identity, currentChatDraftIdentityRef.current)) return;
        void handleSubmitRef.current({
            presetText: choice.kind === 'spec' && choice.sendMode === 'goal-as-message' ? choice.spec : pending.message,
            delivery: pending.delivery,
            goal: choice,
        });
    }, [currentChatDraftIdentityRef, handleSubmitRef]);
    // "Send when ready": the server writes the spec and sends the message
    // with it, so the user can go to another chat, close the tab, or restart
    // OpenChamber meanwhile. The message leaves the composer now; it is sent
    // to the session or draft it was written in (captured by this submit).
    const startGoalJobRef = React.useRef<(pending: PendingGoalWriterSend, handoff: GoalWriterHandoff) => Promise<void>>(async () => {});
    const handleGoalWriterBackground = React.useCallback((handoff: GoalWriterHandoff) => {
        const pending = goalWriterPendingRef.current;
        goalWriterPendingRef.current = null;
        setGoalWriterRequest(null);
        if (!pending || !sameDraftIdentity(pending.identity, currentChatDraftIdentityRef.current)) return;
        void startGoalJobRef.current(pending, handoff);
    }, [currentChatDraftIdentityRef]);

    /**
     * Starts the draft's own worktree when Settings ask for one; the draft's
     * session creation waits for it. Writes the request id onto `draft`.
     */
    const startDraftWorktreeIfConfigured = (draft: NewSessionDraftState, prompt: string, model: string) => {
        const draftTarget = draftTargetRef.current;
        const project = draftTarget?.selectedDraftProject;
        if (
            !draftTarget?.showDraftTargetSelectors
            || !project
            || !shouldAutoCreateDraftWorktree({
                enabled: useConfigStore.getState().settingsAutoCreateWorktree,
                draft,
                projectPath: project.path,
                isGitRepo: draftTarget.selectedDraftProjectIsGitRepo,
            })
        ) return;
        const autoWorktreeSource = draft.autoWorktreeSource;
        draft.pendingWorktreeRequestId = startAutoDraftWorktree({
            project: { id: project.id, path: project.path },
            prompt,
            model,
            typedName: draft.autoWorktreeName,
            // A source picked in another project names branches this one does not have.
            source: autoWorktreeSource?.projectId === project.id ? autoWorktreeSource.source : undefined,
            startFrom: selectWorktreeStartFrom(useConfigStore.getState(), 'autoCreate'),
            branchTemplates: {
                worktree: useConfigStore.getState().settingsWorktreeBranchTemplate,
                pullRequest: useConfigStore.getState().settingsPullRequestBranchTemplate,
            },
            sourceControl: runtimeSourceControl,
            fallbackDirectory: draft.directoryOverride ?? project.path,
        });
    };

    /**
     * Puts a message the server handed back (a goal job that failed or was
     * cancelled, or one that could not be started) into the composer of
     * `identity`, below anything typed there since. Its attached context comes
     * back as chips when that composer is this one; otherwise its text is
     * appended, so nothing is lost.
     */
    const restoreHandedBackMessage = (identity: ChatDraftIdentity, message: Pick<QueuedMessage, 'content' | 'attachments' | 'context'>) => {
        const isCurrent = sameDraftIdentity(identity, currentChatDraftIdentityRef.current);
        const context = message.context ?? [];
        const foldedContext = isCurrent
            ? []
            : context.filter((part) => part.kind !== 'instruction').map((part) => part.text.trim()).filter(Boolean);
        const text = [message.content, ...foldedContext].filter((part) => part.trim()).join('\n\n');
        if (text) restoreDraft(identity, text, new Set());
        if (message.attachments?.length) useInputStore.getState().restoreAttachedFiles(message.attachments, identity);
        if (isCurrent && context.length > 0) restoreQueuedContext(context);
    };

    startGoalJobRef.current = async (pending, handoff) => {
        const runtimeKey = getRuntimeKey();
        const isCurrentRuntime = captureRuntimeInstance();
        const providerID = currentProviderId;
        const modelID = currentModelId;
        const sourceIdentity = pending.identity;
        if (!providerID || !modelID || !sourceIdentity) {
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return;
        }
        const sendConfig = { providerID, modelID, agent: currentAgentName ?? undefined, variant: currentVariant ?? undefined };
        const draftSnapshot = newSessionDraftOpen ? { ...newSessionDraft } : null;
        const replySessionId = currentSessionId;
        const replyDirectory = currentSessionDirectoryForSync ?? currentDirectory ?? null;
        const isNewSession = !replySessionId && Boolean(draftSnapshot);
        const captured = await captureComposerMessage(
            pending.message,
            { sessionId: replySessionId, directory: replyDirectory },
            { runtimeKey, isCurrent: isCurrentRuntime },
        );
        if (!captured) return;
        const message: QueuedMessageInput & Pick<QueuedMessage, 'content'> = {
            content: captured.messageToQueue,
            text: captured.textToQueue,
            agentMention: captured.agentMention,
            attachments: captured.attachmentsToQueue,
            context: [...captured.context],
        };
        // The composer is free for the next message at once. Its goal arm went
        // with this message: the server sets the written spec as the goal.
        useSessionGoalArmStore.getState().setArmed(false);
        setMessage('');
        confirmedMentionsRef.current.clear();
        persistDraftImmediately(chatDraftIdentity, '');
        messageHistory.reset();
        if (captured.composerAttachments.length > 0) clearAttachedFiles(chatDraftIdentity);
        setLinkedReferencesFor(chatDraftIdentity, []);

        let target: { sessionId: string; directory: string } | null = replySessionId && replyDirectory
            ? { sessionId: replySessionId, directory: replyDirectory }
            : null;
        try {
            if (!target && draftSnapshot) {
                startDraftWorktreeIfConfigured(draftSnapshot, captured.textToQueue, `${providerID}/${modelID}`);
                const created = await sessionActions.createDraftSessionForServerSend(
                    { providerID, modelID, agent: currentAgentName ?? undefined, variant: currentVariant },
                    draftSnapshot,
                    runtimeKey,
                );
                if (!created.directory) throw new Error('Failed to create session');
                target = { sessionId: created.sessionId, directory: created.directory };
                for (const part of created.syntheticParts ?? []) message.context?.push({ kind: 'synthetic', text: part.text });
            }
            if (!target) throw new Error(t('chat.chatInput.toast.messageSendFailed'));
            if (isNewSession) {
                const responseStyle = await fetchResponseStyleInstruction().catch(() => null);
                if (responseStyle) message.context?.push({ kind: 'synthetic', text: wrapSystemReminder(responseStyle) });
            }
            const goalSettings = useUIStore.getState();
            const job = await createGoalSpecJob({
                sessionId: target.sessionId,
                directory: target.directory,
                sendMode: handoff.sendMode,
                tokenBudget: goalSettings.sessionGoalDefaultBudgetEnabled ? goalSettings.sessionGoalDefaultBudget : null,
                writer: await pending.writerInputFor(handoff.run),
                message,
                sendConfig,
            });
            useGoalSpecJobStore.getState().upsert(job);
            recordLinkedReferences(target.sessionId, target.directory, captured.linkedToQueue);
        } catch (error) {
            // Nothing reached the server: the message goes back where it was
            // written, or to the session it already made.
            const restoreTo = target ? createChatDraftIdentity(runtimeKey, target.directory, target.sessionId) ?? sourceIdentity : sourceIdentity;
            restoreHandedBackMessage(restoreTo, message);
            toast.error(getSubmitErrorMessage(error, t('chat.chatInput.toast.messageSendFailed')));
        }
    };

    // A goal job that failed or was cancelled holds its message on the server
    // until the composer it was written for takes it back: this one, once it
    // shows that session. Take is atomic, so one window gets it.
    useGoalSpecJobSync(!columnPinned);
    const goalJobs = useGoalSpecJobStore((state) => state.jobs);
    const takingGoalJobsRef = React.useRef(new Set<string>());
    const restoreHandedBackRef = React.useRef(restoreHandedBackMessage);
    restoreHandedBackRef.current = restoreHandedBackMessage;
    React.useEffect(() => {
        const identity = chatDraftIdentity;
        if (!identity?.sessionId) return;
        for (const job of Object.values(goalJobs)) {
            if (job.status !== 'failed' || job.sessionId !== identity.sessionId || takingGoalJobsRef.current.has(job.id)) continue;
            takingGoalJobsRef.current.add(job.id);
            void takeGoalSpecJob(job)
                .then((taken) => {
                    useGoalSpecJobStore.getState().remove(taken);
                    restoreHandedBackRef.current(identity, queuedMessageFromTakenItem(taken.item, taken.id));
                })
                .catch((error: Error) => console.warn('[goal-spec-jobs] failed to take a goal job back:', error))
                .finally(() => takingGoalJobsRef.current.delete(job.id));
        }
    }, [goalJobs, chatDraftIdentity]);

    /**
     * The goal writer turns the message into a goal spec before anything is
     * taken from the composer. The dialog's choice submits again with `goal`,
     * so cancelling leaves the composer, the queue and any pending prompts
     * exactly as they were. True when the writer took the send over.
     */
    const routeSendThroughGoalWriter = (input: {
        options: SubmitOptions | undefined;
        queuedOnly: boolean;
        hasCommand: boolean;
        message: string;
        providerID: string | undefined;
        modelID: string | undefined;
    }): boolean => {
        if (input.options?.goal) return false;
        const uiState = useUIStore.getState();
        const goalTargetDirectory = currentSessionId
            ? currentSessionDirectoryForSync ?? currentDirectory ?? null
            : newSessionDraft?.directoryOverride ?? currentDirectory ?? null;
        const goalWriterPlan = planGoalWriter({
            eligible: !input.queuedOnly
                && !isBtwActive
                && inputMode === 'normal'
                && !input.hasCommand
                && input.message.trim().length > 0
                && !input.message.trimStart().startsWith('/')
                // These sends are queued behind the review, never sent now.
                && !(currentSessionId && autoReviewRunning),
            goalsAvailable: !isVSCodeRuntime() && uiState.sessionGoalEnabled && isGoalCheckAvailableNow(goalTargetDirectory),
            armed: useSessionGoalArmStore.getState().armed,
            hasGoal: currentSessionId ? getSessionGoal(getAllSyncSessionMap().get(currentSessionId)) !== null : false,
            writerEnabled: uiState.sessionGoalWriterEnabled,
            rewriteAll: uiState.sessionGoalRewriteAll,
            review: uiState.sessionGoalWriterReview,
            // A message sent while the agent is still working follows up on that turn.
            autoCreate: sessionPhase === 'idle' ? uiState.sessionGoalAutoCreate : 'off',
        });
        if (!goalWriterPlan) return false;
        const request = input.message;
        const queuedTexts = composerQueuedMessages.map((queued) => queued.content);
        const sessionIdForContext = currentSessionId;
        const draftProject = draftTargetRef.current?.selectedDraftProject ?? null;
        const projectForContext = currentSessionId
            ? resolveProjectForSessionDirectory(
                useProjectsStore.getState().projects,
                useSessionUIStore.getState().availableWorktreesByProject,
                goalTargetDirectory,
            )
            : draftProject && draftProject.kind !== 'chat' ? draftProject : null;
        const { providerID, modelID } = input;
        // The writer's input, the same whether this window writes the spec or
        // the server does ("Send when ready").
        const writerInputFor = async ({ writer, ignoreLimit, section, currentSpec }: GoalWriterRunOptions): Promise<GoalSpecJobWriterInput> => {
            const context = goalWriterPlan.trigger === 'auto-create'
                ? await collectGoalWriterContext({
                    sessionId: sessionIdForContext,
                    directory: goalTargetDirectory,
                    project: projectForContext ? { id: projectForContext.id, path: projectForContext.path } : null,
                    queuedMessages: queuedTexts,
                })
                : null;
            const writerInput: GoalSpecJobWriterInput = { request };
            if (context?.conversation) writerInput.conversation = context.conversation;
            if (context?.openItems) writerInput.openItems = context.openItems;
            if (providerID) writerInput.providerID = providerID;
            if (modelID) writerInput.modelID = modelID;
            if (writer) {
                writerInput.writerProviderID = writer.providerID;
                writerInput.writerModelID = writer.modelID;
                if (writer.variant) writerInput.writerVariant = writer.variant;
            }
            if (ignoreLimit) writerInput.ignoreLimit = true;
            if (section) writerInput.section = section;
            if (currentSpec) writerInput.currentSpec = currentSpec;
            return writerInput;
        };
        goalWriterPendingRef.current = { message: request, delivery: input.options?.delivery, identity: chatDraftIdentity, writerInputFor };
        goalWriterRequestIdRef.current += 1;
        setGoalWriterRequest({
            id: goalWriterRequestIdRef.current,
            trigger: goalWriterPlan.trigger,
            review: goalWriterPlan.review,
            defaultSendMode: uiState.sessionGoalWriterSendMode,
            sessionModel: providerID && modelID ? { providerID, modelID } : null,
            directory: goalTargetDirectory,
            inputLength: request.length,
            write: async (signal, runOptions) => {
                const writerInput = await writerInputFor(runOptions);
                return requestGoalSpec({
                    ...writerInput,
                    writer: runOptions.writer,
                    directory: goalTargetDirectory,
                    signal,
                });
            },
        });
        return true;
    };

    return {
        goalWriterRequest, cancelGoalWriter, handleGoalWriterChoice, handleGoalWriterBackground,
        startDraftWorktreeIfConfigured, routeSendThroughGoalWriter,
    };
}
