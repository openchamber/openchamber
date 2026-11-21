import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerRuntime } from './useComposerRuntime';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerPermissionSettings } from './useComposerPermissionSettings';
import type { useComposerParallelRun } from './useComposerParallelRun';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerHistorySearchState } from './useComposerHistorySearchState';
import type { useComposerExpansion } from './useComposerExpansion';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerColumn } from './useComposerColumn';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import type { useComposerLargePasteState } from './useComposerLargePasteState';
import type { ComposerSendHandlers } from './composerSendHandlers';
import { useConfigStore } from '@/stores/useConfigStore';
import { isServerOwnedMessageQueue, type QueuedMessage } from '@/stores/messageQueueStore';
import { readEffortRevision } from '@/lib/modelEfforts';
import { useSessionUIStore, type SendMessageOptions, type SentMessage } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore } from '@/sync/input-store';
import * as sessionActions from '@/sync/session-actions';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { loadMagicPrompts } from '@/lib/magicPrompts';
import { captureRuntimeInstance, getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useBtwStore } from '@/stores/useBtwStore';
import { buildBtwSyntheticTexts, btwPendingComposerKey, preparePendingBtwSend, startBtwSession } from '@/lib/btw';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { toast } from '@/components/ui';
import { isVSCodeRuntime } from '@/lib/desktop';
import { collectRunningActions, planRunningActionsNote } from '../../lib/runningActionsNote';
import { composerReferenceKey, toContextReference } from '../../composer/composerReferences';
import { referencesLinkedIn, withoutSharedPageLinks, withReferencesFromText } from '../../composer/referenceLinks';
import { type FormRequest } from '@/lib/opencode/model';
import { postTrackerSessionStarted } from '@/lib/trackers/sessionStatus';
import { runGuestCommand } from '@/lib/guests/run-command';
import { routeGuestSlashCommand } from '../../composer/submit/guestCommands';
import { opencodeClient } from '@/lib/opencode/client';
import { buildSkillMentionInstruction } from '@/lib/skillMentionInstruction';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { trackUnconfirmedSend } from '@/lib/unconfirmedSends';
import { filterMissingInlineAttachments } from '../../composer/attachments/inlineMentionAttachments';
import { buildOutgoingMessage, expandCommentSnippets } from '../../composer/submit/buildOutgoingMessage';
import { buildCommandVariables, canRunCommand, findMagicPromptCommand, planLocalSlashCommand } from '../../composer/submit/slashCommands';
import { spaceModelRefusal, stoppedSpaceOfTarget } from '@/lib/spaces/space-model-access';
import { runSpaceAction } from '@/lib/spaces/space-repair';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { withRegisteredSharedPages } from '../../sharePages/received/takeShareLink';
import { buildChatInputHistorySubmissions } from '../../inputHistory';
import type { ChatInputProps, SubmitOptions } from './chatInputProps';
import { runComposerActionCommand } from './runComposerActionCommand';
import { collectInlineSkillMentions } from './composerMentionTokens';
import { recordLinkedReferences } from './recordLinkedReferences';
import { handleComposerSendFailure } from './handleComposerSendFailure';
import { createComposerSubmitErrorMessage } from './createComposerSubmitErrorMessage';
import { saveAttachmentsHeldForSend } from './saveAttachmentsHeldForSend';

type Dependencies = {
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'waitForPendingAttachments'>;
    largePasteState: Pick<ReturnType<typeof useComposerLargePasteState>, 'largeTextPasteOffer'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'confirmedMentionsRef' | 'setMessage' | 'currentChatDraftIdentityRef' | 'composerText'>;
    historySearchState: Pick<ReturnType<typeof useComposerHistorySearchState>, 'setPromptHistorySearch'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    column: Pick<ReturnType<typeof useComposerColumn>, 'openTimelineDialog'>;
    sending: Pick<ReturnType<typeof useSessionUIStore.getState>, 'sendMessage'>;
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen' | 'hasDrafts' | 'attachmentsToSend' | 'inlineDraftTarget' | 'consumeDrafts'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleSubmitRef'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'pendingFirstSend' | 'composerQueuedMessages' | 'getCurrentInputSnapshot' | 'hasQueuedMessages'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'currentSessionId' | 'btwPanel' | 'newSessionDraftOpen' | 'newSessionDraft' | 'btwDirectory' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'attachedFiles' | 'inputMode' | 'btwSessionId' | 'activeRuntimeKey' | 'chatDraftIdentity' | 'immediateBtwSubmitRef' | 'sendHeldByMissingFolder' | 'setReviewDialogOpen' | 'consumePendingSyntheticParts' | 'isPromotedBtwSession' | 'projectActionsRef' | 'clearAttachedFiles' | 'btwComposerSessionId' | 'sessionFolder'>;
    parallelRun: Pick<ReturnType<typeof useComposerParallelRun>, 'parallel'>;
    sessionLifecycle: Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase' | 'autoReviewRunning'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'messageQueueTarget' | 'takeForSend'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'effectiveBtwSelection' | 'currentProviderId' | 'currentModelId' | 'currentAgentName' | 'currentVariant' | 'mailboxTarget'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'readSessionMentionsBeforeSend' | 'guestCommands' | 'availableSkills' | 'linkedReferences' | 'referenceLinksIn' | 'sessionMentionsIn'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
    expansion: Pick<ReturnType<typeof useComposerExpansion>, 'setExpandedInput'>;
    permissionSettings: Pick<ReturnType<typeof useComposerPermissionSettings>, 'pendingBtwPermissionMode'>;
    runtime: Pick<ReturnType<typeof useComposerRuntime>, 'runtimeTrackers'>;
    draftHistory: Pick<ReturnType<typeof useComposerDraftHistory>, 'handoffDraft' | 'restoreDraft' | 'persistDraftImmediately' | 'messageHistory' | 'migrateDraft'>;
    queueActions: Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueueMessage'>;
    props: Pick<ChatInputProps, 'scrollToBottom'>;
    mentionAttachments: Pick<ReturnType<typeof useComposerMentionAttachments>, 'prepareReadOnSendMentions' | 'mentionableAgents' | 'extractInlineFileMentions' | 'sanitizeAttachmentsForSend'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'updateLinkedReferencesFor'>;
};

export function useComposerSubmission({
    i18n, attachmentWork, largePasteState, draftText, historySearchState, editorState, column, sending, inlineContext,
    sendHandlers, sendAvailability, sessionScope, parallelRun, sessionLifecycle, queueState, selection,
    language, preferences, expansion, permissionSettings, runtime, draftHistory, queueActions, props,
    mentionAttachments, referenceDrafts,
}: Dependencies) {
    const { t } = i18n;
    const { waitForPendingAttachments } = attachmentWork;
    const { largeTextPasteOffer } = largePasteState;
    const { confirmedMentionsRef, setMessage, currentChatDraftIdentityRef, composerText } = draftText;
    const { setPromptHistorySearch } = historySearchState;
    const { composerRef } = editorState;
    const { openTimelineDialog } = column;
    const { sendMessage } = sending;
    const { isMobileCommentOpen, hasDrafts, attachmentsToSend, inlineDraftTarget, consumeDrafts } = inlineContext;
    const { handleSubmitRef } = sendHandlers;
    const { pendingFirstSend, composerQueuedMessages, getCurrentInputSnapshot, hasQueuedMessages } = sendAvailability;
    const {
        isBtwActive, currentSessionId, btwPanel, newSessionDraftOpen, newSessionDraft, btwDirectory,
        currentSessionDirectoryForSync, currentDirectory, attachedFiles, inputMode, btwSessionId,
        activeRuntimeKey, chatDraftIdentity, immediateBtwSubmitRef, sendHeldByMissingFolder,
        setReviewDialogOpen, consumePendingSyntheticParts, isPromotedBtwSession, projectActionsRef,
        clearAttachedFiles, btwComposerSessionId, sessionFolder,
    } = sessionScope;
    const { parallel } = parallelRun;
    const { sessionPhase, autoReviewRunning } = sessionLifecycle;
    const { messageQueueTarget, takeForSend } = queueState;
    const {
        effectiveBtwSelection, currentProviderId, currentModelId, currentAgentName, currentVariant,
        mailboxTarget,
    } = selection;
    const {
        readSessionMentionsBeforeSend, guestCommands, availableSkills, linkedReferences,
        referenceLinksIn, sessionMentionsIn,
    } = language;
    const { isMobile } = preferences;
    const { setExpandedInput } = expansion;
    const { pendingBtwPermissionMode } = permissionSettings;
    const { runtimeTrackers } = runtime;
    const { handoffDraft, restoreDraft, persistDraftImmediately, messageHistory, migrateDraft } = draftHistory;
    const { handleQueueMessage } = queueActions;
    const { scrollToBottom } = props;
    const {
        prepareReadOnSendMentions, mentionableAgents, extractInlineFileMentions,
        sanitizeAttachmentsForSend,
    } = mentionAttachments;
    const { updateLinkedReferencesFor } = referenceDrafts;

    const getSubmitErrorMessage = createComposerSubmitErrorMessage(t);
    const handleSubmit = async (options?: SubmitOptions) => {
        if (isMobileCommentOpen()) return;
        if (largeTextPasteOffer && !options?.queuedOnly) return;
        if (await waitForPendingAttachments()) {
            void handleSubmitRef.current(options);
            return;
        }
        if (!options?.queuedOnly) {
            const sent = attachmentsToSend(options?.presetText ?? getCurrentInputSnapshot().message);
            const held = await saveAttachmentsHeldForSend(chatDraftIdentity, currentDirectory ?? undefined, sent, t);
            if (held === 'stopped') return;
            if (held === 'saved') {
                void handleSubmitRef.current(options);
                return;
            }
        }
        if (isBtwActive && currentSessionId && (btwPanel.creating || useBtwStore.getState().byParent[currentSessionId]?.pendingSend)) return;
        if (pendingFirstSend) return;
        if (parallel.isActive && !options?.queuedOnly) {
            if (parallel.runCount >= 2) void parallel.launch();
            return;
        }
        const submitRuntimeKey = getRuntimeKey();
        const isSubmitRuntime = captureRuntimeInstance();
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionPhase !== 'idle' ? 'steer' : undefined;
        const capturedTarget = messageQueueTarget;
        const capturedDraftSnapshot = newSessionDraftOpen ? { ...newSessionDraft } : null;
        const queuedProjection = queuedMessageId
            ? composerQueuedMessages.filter((message) => message.id === queuedMessageId)
            : composerQueuedMessages;
        const capturedSendConfig = queuedOnly ? queuedProjection[0]?.sendConfig : undefined;
        const providerIdToSend = capturedSendConfig?.providerID ?? (isBtwActive ? effectiveBtwSelection.model?.providerId : currentProviderId);
        const modelIdToSend = capturedSendConfig?.modelID ?? (isBtwActive ? effectiveBtwSelection.model?.modelId : currentModelId);
        const agentNameToSend = capturedSendConfig?.agent ?? (isBtwActive ? effectiveBtwSelection.agent : currentAgentName);
        const variantToSend = capturedSendConfig?.variant ?? (isBtwActive ? effectiveBtwSelection.variant : currentVariant);
        const effortRevision = providerIdToSend && modelIdToSend
            ? readEffortRevision(providerIdToSend, modelIdToSend)
            : undefined;
        const magicPromptDirectory = isBtwActive
            ? btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory
            : capturedTarget || !capturedDraftSnapshot
                ? capturedTarget?.directory ?? currentDirectory
                : capturedDraftSnapshot.target === 'chat'
                    ? null
                    : capturedDraftSnapshot.bootstrapPendingDirectory ?? capturedDraftSnapshot.directoryOverride ?? currentDirectory;
        const inputSnapshot = options?.presetText != null
            ? {
                message: options.presetText,
                hasContent: options.presetText.trim().length > 0 || attachedFiles.length > 0 || hasDrafts,
            }
            : getCurrentInputSnapshot();
        if (queuedOnly && autoReviewRunning) {
            return;
        }
        if (!queuedOnly && !(await readSessionMentionsBeforeSend(inputSnapshot.message))) return;

        if (queuedOnly) {
            if (!composerQueuedMessages.some((message) => !queuedMessageId || message.id === queuedMessageId) || !currentSessionId) return;
        } else if ((!inputSnapshot.hasContent && !hasQueuedMessages) || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        let commandPlan = !queuedOnly && inputSnapshot.hasContent
            ? planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, Boolean(currentSessionId))
            : null;
        if (commandPlan?.kind === 'prompt') {
            const magicCommand = findMagicPromptCommand(commandPlan.command.name);
            const commandIsAvailable = commandPlan.command.name === 'btw'
                ? Boolean(currentSessionId)
                : magicCommand !== null && canRunCommand(magicCommand, {
                    hasSession: Boolean(currentSessionId),
                    hasDraft: newSessionDraftOpen,
                });
            if (!commandIsAvailable) commandPlan = null;
        }
        if (commandPlan?.command.name === 'handoff-review' && (isMobile || isVSCodeRuntime())) commandPlan = null;

        if (commandPlan?.kind === 'prompt' && commandPlan.command.name === 'btw' && currentSessionId) {
            const targetComposerId = btwSessionId ?? btwPendingComposerKey(currentSessionId);
            const targetIdentity = createChatDraftIdentity(
                activeRuntimeKey,
                btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory,
                targetComposerId,
            );
            const argument = commandPlan.command.argument.trim();
            handoffDraft(targetIdentity, isBtwActive ? argument : argument || null);
            useInputStore.getState().moveAttachedFiles(chatDraftIdentity, targetIdentity);
            if (argument && targetIdentity) immediateBtwSubmitRef.current = { identity: targetIdentity, text: argument };
            if (btwSessionId) {
                useBtwStore.getState().setPanelState(currentSessionId, { collapsed: false });
                return;
            }
            useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false });
            return;
        }

        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }

        if (sendHeldByMissingFolder()) return;

        const confirmedMentionsSnapshot = new Set(confirmedMentionsRef.current);
        const restoreComposerText = (target: ChatDraftIdentity | null = chatDraftIdentity) => {
            if (queuedOnly || !inputSnapshot.message) return;
            restoreDraft(target, inputSnapshot.message, confirmedMentionsSnapshot);
        };

        const guestRoute = !queuedOnly && !isBtwActive && inputSnapshot.hasContent
            ? routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands)
            : null;
        if (guestRoute) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            setPromptHistorySearch(null);
            const outcome = await runGuestCommand(guestRoute);
            if (outcome.ok) {
                if (outcome.item) {
                    useInputStore.getState().setPendingGuestIssue(outcome.item);
                } else {
                    restoreComposerText();
                    toast.info(t('chat.chatInput.toast.guestCommandNothing', { name: guestRoute.entry.guestName }));
                }
                return;
            }
            restoreComposerText();
            toast.error(outcome.reason === 'error'
                ? t('chat.chatInput.toast.guestCommandFailed', { command: guestRoute.entry.command.name, reason: outcome.message })
                : t('chat.chatInput.toast.guestCommandUnavailable', { name: guestRoute.entry.guestName }));
            return;
        }

        const spaceTarget = currentSessionId
            ? { requestId: null, directory: currentSessionDirectoryForSync ?? currentDirectory ?? null }
            : newSessionDraftOpen
                ? { requestId: newSessionDraft?.pendingWorktreeRequestId ?? null, directory: newSessionDraft?.directoryOverride ?? null }
                : null;
        const stoppedSpace = spaceTarget ? stoppedSpaceOfTarget(spaceTarget) : null;
        if (stoppedSpace) {
            toast.error(t(stoppedSpace.reason === 'gone' ? 'spaces.draft.spaceGone' : stoppedSpace.reason === 'unreachable' ? 'spaces.draft.spaceUnreachable' : 'spaces.draft.spaceStopped'), stoppedSpace.start ? {
                action: {
                    label: t('spaces.actions.start'),
                    onClick: () => void runSpaceAction(stoppedSpace.spaceId, 'start'),
                },
            } : undefined);
            return;
        }

        if (!providerIdToSend || !modelIdToSend) {
            console.warn('Cannot send message: provider or model not selected');
            toast.error(t('chat.chatInput.toast.noModelSelected'));
            return;
        }

        const spaceRefusal = spaceTarget ? spaceModelRefusal(spaceTarget, providerIdToSend) : null;
        if (spaceRefusal) {
            const provider = useConfigStore.getState().providers.find((entry) => entry.id === spaceRefusal.providerId)?.name ?? spaceRefusal.providerId;
            toast.error(spaceRefusal.reason === 'opencode'
                ? t('spaces.draft.modelOpenCode')
                : spaceRefusal.reason === 'needs_again'
                    ? t('spaces.draft.modelNeedsKeyAgain', { provider })
                    : t('spaces.draft.modelNotGranted', { provider }), {
                action: {
                    label: t('spaces.group.access.give'),
                    onClick: () => useSpacesStore.getState().openAccessDialog(spaceRefusal.spaceId, spaceRefusal.reason === 'opencode' ? null : spaceRefusal.providerId),
                },
            });
            return;
        }

        if (currentSessionId && !queuedOnly && autoReviewRunning && !isBtwActive && !commandPlan) {
            void handleQueueMessage();
            return;
        }

        let deferredQuestions: readonly FormRequest[] = [];
        if (currentSessionId && !queuedOnly && !isBtwActive && !commandPlan) {
            const [deniedPermissions, forms] = await Promise.all([
                sessionActions.dismissOpenPermissionsForSession(currentSessionId),
                sessionActions.dismissOpenFormsForSession(currentSessionId, { deferQuestions: inputMode !== 'shell' }),
            ]);
            if ((deniedPermissions || forms.dismissed) && delivery !== 'steer' && forms.deferred.length === 0) {
                void handleQueueMessage();
                return;
            }
            deferredQuestions = forms.deferred;
        }

        if (commandPlan?.kind === 'action' && currentSessionId) {
            await runComposerActionCommand({
                setMessage, confirmedMentionsRef, persistDraftImmediately, chatDraftIdentity, messageHistory,
                setPromptHistorySearch, isBtwActive, setExpandedInput, isMobile, composerRef,
                currentSessionId, scrollToBottom, openTimelineDialog, setReviewDialogOpen, currentProviderId,
                currentModelId, currentAgentName, currentVariant, t, currentDirectory, getSubmitErrorMessage,
                commandPlan, capturedSendConfig, restoreComposerText,
            });
            return;
        }

        let sendMessageOptions: SendMessageOptions | undefined;
        if (isBtwActive && btwSessionId && btwDirectory) {
            sendMessageOptions = {
                target: { runtimeKey: submitRuntimeKey, sessionId: btwSessionId, directory: btwDirectory },
                sessionId: btwSessionId,
                directory: btwDirectory,
            };
        } else if (capturedTarget || capturedDraftSnapshot || delivery) {
            sendMessageOptions = {};
            if (capturedTarget) sendMessageOptions.target = capturedTarget;
            if (capturedDraftSnapshot) sendMessageOptions.draftSnapshot = capturedDraftSnapshot;
        }
        if (delivery && sendMessageOptions) sendMessageOptions.delivery = delivery;
        sendMessageOptions = { ...sendMessageOptions, isCurrentRuntime: isSubmitRuntime, userInitiated: true, recordEffort: !isBtwActive && !queuedOnly, effortRevision };
        let sent: SentMessage | undefined;
        if (deferredQuestions.length > 0) sendMessageOptions.onSent = (route) => { sent = route; };

        const reservedFilenames = new Set([
            ...attachedFiles.map((attachment) => attachment.filename),
            ...queuedProjection.flatMap((queued) => queued.attachments?.map((attachment) => attachment.filename) ?? []),
        ]);
        const readOnSendMentions = await prepareReadOnSendMentions(
            !isBtwActive && !queuedOnly && inputSnapshot.hasContent ? [inputSnapshot.message] : [],
            reservedFilenames,
            submitRuntimeKey,
            attachedFiles,
        );
        if (readOnSendMentions.status === 'runtime-changed') return;
        if (readOnSendMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: readOnSendMentions.filename }));
            return;
        }
        const preparedMentions = readOnSendMentions.prepared;

        let queuedMessagesToSend: QueuedMessage[] = [];
        if (capturedTarget && hasQueuedMessages && !commandPlan) {
            try {
                queuedMessagesToSend = await takeForSend(capturedTarget, queuedMessageId);
            } catch (error) {
                console.warn('[queue] failed to take queued messages for sending:', error);
                toast.error(t('chat.queuedMessage.toast.takeFailed'));
                return;
            }
            if (queuedOnly && queuedMessagesToSend.length === 0) return;
            const queuedGoal = queuedMessagesToSend.find((queued) => queued.goal)?.goal;
            if (queuedGoal || queuedOnly) {
                sendMessageOptions = { ...sendMessageOptions, queuedGoal: queuedGoal ?? null };
            }
        }

        const sentAttachedFiles = attachmentsToSend(inputSnapshot.message);
        const historySubmissions = buildChatInputHistorySubmissions({
            inputMode,
            queuedMessages: isServerOwnedMessageQueue() ? [] : queuedMessagesToSend,
            composerText: inputSnapshot.message,
            composerAttachments: sentAttachedFiles,
            includeComposer: !queuedOnly && inputSnapshot.hasContent,
        });
        if (historySubmissions?.length) {
            sendMessageOptions = { ...sendMessageOptions, historySubmissions };
        }

        const syntheticParts = isBtwActive ? [] : consumePendingSyntheticParts(mailboxTarget);
        const consumedDraftTarget = inlineDraftTarget;
        const drafts: InlineCommentDraft[] = consumedDraftTarget
            ? consumeDrafts(consumedDraftTarget)
            : [];
        const restoreConsumedDrafts = () => {
            if (consumedDraftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(consumedDraftTarget, drafts);
            }
        };
        const restoreConsumedInput = () => {
            restoreConsumedDrafts();
            if (syntheticParts?.length) {
                const inputState = useInputStore.getState();
                inputState.setPendingSyntheticParts([...syntheticParts, ...(inputState.getPendingSyntheticParts(mailboxTarget) ?? [])], mailboxTarget);
            }
            restoreComposerText();
            if (!queuedOnly && attachedFiles.length > 0) {
                useInputStore.getState().restoreAttachedFiles(attachedFiles, chatDraftIdentity);
            }
        };

        const availableSkillNames = new Set(
            availableSkills.map((skill) => skill.name),
        );

        const expandedDrafts = await expandCommentSnippets(drafts, useSnippetsStore.getState().expandText);

        const sentComposerText = !queuedOnly && inputSnapshot.hasContent ? inputSnapshot.message : '';
        const linkedReferencesToSend = await withRegisteredSharedPages(withReferencesFromText(referencesLinkedIn(sentComposerText, linkedReferences), referenceLinksIn(sentComposerText)));

        const outgoing = buildOutgoingMessage({
            queued: queuedMessagesToSend,
            composerText: !queuedOnly && inputSnapshot.hasContent ? withoutSharedPageLinks(inputSnapshot.message, linkedReferencesToSend) : null,
            composerAttachments: sentAttachedFiles,
            inlineComments: expandedDrafts,
            syntheticTexts: [
                ...buildBtwSyntheticTexts({ isBtwActive, isPromotedBtwSession }),
                ...(syntheticParts?.map((part) => part.text) ?? []),
            ],
            references: isBtwActive ? [] : linkedReferencesToSend.map(toContextReference).concat(
                !queuedOnly && inputSnapshot.hasContent ? sessionMentionsIn(inputSnapshot.message) : [],
            ),
        }, {
            parseAgentMention: (text) => {
                if (isBtwActive) return { text };
                const { sanitizedText, mention } = parseAgentMentions(text, mentionableAgents());
                return { text: sanitizedText, agentName: mention?.name };
            },
            extractFileMentions: (text) => {
                if (isBtwActive) return { text, attachments: [] };
                const { sanitizedText, attachments } = extractInlineFileMentions(text, preparedMentions, attachedFiles);
                return { text: sanitizedText, attachments };
            },
            sanitizeAttachments: sanitizeAttachmentsForSend,
            collectSkillNames: (text) => collectInlineSkillMentions(text, availableSkillNames),
        });

        let primaryText = outgoing.primaryText;
        const { primaryAttachments, additionalParts, agentMentionName, skillNames } = outgoing;

        if (outgoing.isEmpty) return;

        const actionsNote = isBtwActive ? null : planRunningActionsNote(currentSessionId ?? null, collectRunningActions(projectActionsRef.current));
        if (actionsNote?.text) additionalParts.push({ text: actionsNote.text, synthetic: true });

        if (skillNames.length > 0) {
            sendMessageOptions = {
                ...sendMessageOptions,
                skills: { names: skillNames, instructionFor: buildSkillMentionInstruction },
            };
        }

        // external: #3898 OpenCode rejects the entire prompt when an inline file mention does not exist.
        const { sendable: sendableAttachments } = await filterMissingInlineAttachments(
            primaryAttachments,
            opencodeClient,
        );

        const unconfirmedSend = !queuedOnly && !isBtwActive && chatDraftIdentity && inputSnapshot.message
            ? trackUnconfirmedSend({
                identity: chatDraftIdentity,
                text: inputSnapshot.message,
                confirmedMentions: confirmedMentionsSnapshot,
                attachmentNames: sentAttachedFiles.map((file) => file.filename),
            })
            : null;
        if (unconfirmedSend) sendMessageOptions = { ...sendMessageOptions, progress: unconfirmedSend.progress };

        if (!queuedOnly) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            setPromptHistorySearch(null);
            if (attachedFiles.length > 0) {
                clearAttachedFiles(chatDraftIdentity);
            }
            if (!isBtwActive) setExpandedInput(false);
        }

        if (isMobile) {
            composerRef.current?.blur();
        }

        if (commandPlan?.kind === 'prompt') {
            const { name: commandName, argument } = commandPlan.command;

            const command = findMagicPromptCommand(commandName);
            if (command) {
                const variables = buildCommandVariables(command, argument);
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const prompts = await loadMagicPrompts(magicPromptDirectory);
                    const visibleText = prompts.render(command.visiblePrompt, variables.visible);
                    const instructionsText = prompts.render(command.instructionsPrompt, variables.instructions);
                    scrollToBottom?.();
                    await sendMessage(
                        visibleText,
                        providerIdToSend,
                        modelIdToSend,
                        agentNameToSend,
                        sendableAttachments,
                        agentMentionName,
                        [...additionalParts, { text: instructionsText, synthetic: true }],
                        variantToSend,
                        inputMode,
                        sendMessageOptions,
                    );
                    if (currentSessionId) actionsNote?.commit(currentSessionId);
                } catch (error) {
                    restoreConsumedInput();
                    toast.error(getSubmitErrorMessage(error, t(command.errorToastKey)));
                }
                unconfirmedSend?.settle();
                return;
            }
        }

        const expandOutgoingSnippets = async () => {
            try {
                const expandText = useSnippetsStore.getState().expandText;
                primaryText = await expandText(primaryText);
                for (const part of additionalParts) {
                    if (!part.synthetic) part.text = await expandText(part.text);
                }
            } catch (error) {
                console.warn('[ChatInput] Failed to expand snippets, sending original text:', error);
            }
        };
        let pendingBtwSend: symbol | null = null;
        if (isBtwActive && btwPanel.pending && currentSessionId) {
            pendingBtwSend = await preparePendingBtwSend(currentSessionId, submitRuntimeKey, expandOutgoingSnippets);
            if (!pendingBtwSend) {
                if (getRuntimeKey() !== submitRuntimeKey) restoreComposerText();
                return;
            }
        } else {
            await expandOutgoingSnippets();
        }
        const ownsPendingBtwSend = () => Boolean(pendingBtwSend && currentSessionId
            && useBtwStore.getState().byParent[currentSessionId]?.pendingSend === pendingBtwSend);

        const allAttachments = [
            ...sendableAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        scrollToBottom?.();

        if (isBtwActive && btwPanel.pending && currentSessionId && btwComposerSessionId) {
            const targetDirectory = useSessionUIStore.getState().getDirectoryForSession(currentSessionId)
                || currentDirectory
                || null;
            if (!targetDirectory) {
                useBtwStore.getState().setPanelState(currentSessionId, { pendingSend: undefined });
                restoreConsumedInput();
                toast.error(t('chat.btw.toast.createFailed'));
                return;
            }
            try {
                const fork = await startBtwSession({
                    parentSessionId: currentSessionId,
                    expectedRuntimeKey: submitRuntimeKey,
                    question: primaryText,
                    directory: targetDirectory,
                    providerID: providerIdToSend,
                    modelID: modelIdToSend,
                    agent: agentNameToSend,
                    variant: variantToSend,
                    attachments: sendableAttachments,
                    additionalParts,
                    skills: sendMessageOptions?.skills,
                    permissionMode: pendingBtwPermissionMode,
                });
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    return;
                }
                const forkDirectory = fork.directory ?? targetDirectory;
                const forkIdentity = createChatDraftIdentity(activeRuntimeKey, forkDirectory, fork.id);
                migrateDraft(chatDraftIdentity, forkIdentity);
                useInputStore.getState().moveAttachedFiles(chatDraftIdentity, forkIdentity);
                if (inlineDraftTarget) {
                    const drafts = useInlineCommentDraftStore.getState();
                    drafts.restoreDrafts({ directory: forkDirectory, sessionKey: fork.id }, drafts.consumeDrafts(inlineDraftTarget));
                }
                useBtwStore.getState().setPanelState(currentSessionId, { pending: false, creating: false, pendingSend: undefined });
                useSelectionStore.getState().clearSessionSelections(btwComposerSessionId);
                scrollToBottom?.();
            } catch (error) {
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    restoreComposerText();
                    return;
                }
                useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false, pendingSend: undefined });
                restoreConsumedInput();
                toast.error(getSubmitErrorMessage(error, t('chat.btw.toast.createFailed')));
            }
            return;
        }

        const sendPromise = sendMessage(
            primaryText,
            providerIdToSend,
            modelIdToSend,
            agentNameToSend,
            sendableAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            variantToSend,
            inputMode,
            sendMessageOptions,
        );
        void sendPromise.then(() => {
            if (deferredQuestions.length > 0 && getRuntimeKey() === submitRuntimeKey) {
                void sessionActions.deferQuestionsAfterSend(deferredQuestions, sent);
            }
            if (isBtwActive) return;
            const sessionState = useSessionUIStore.getState();
            const linkTargetSessionId = currentSessionId ?? sessionState.currentSessionId;
            const linkTargetDirectory = currentSessionId
                ? currentSessionDirectoryForSync ?? currentDirectory
                : sessionState.currentSessionDirectory
                    ?? (linkTargetSessionId ? sessionState.getDirectoryForSession(linkTargetSessionId) : null)
                    ?? currentDirectory;
            if (linkTargetSessionId) {
                recordLinkedReferences(linkTargetSessionId, linkTargetDirectory, linkedReferencesToSend);
                actionsNote?.commit(linkTargetSessionId);
            }
            if (!currentSessionId && linkTargetSessionId) {
                for (const reference of linkedReferencesToSend) {
                    if (reference.kind !== 'tracker-item') continue;
                    void postTrackerSessionStarted(runtimeTrackers, reference.provider, {
                        sessionId: linkTargetSessionId,
                        identifier: reference.identifier,
                    });
                }
            }

            const sentKeys = new Set(linkedReferences.map(composerReferenceKey));
            updateLinkedReferencesFor(chatDraftIdentity, (current) => current.filter((reference) => !sentKeys.has(composerReferenceKey(reference))));
        }).catch((error) => handleComposerSendFailure(error, {
            currentChatDraftIdentityRef, handoffDraft, chatDraftIdentity, composerText, restoreDraft, t,
            sessionFolder, isBtwActive, allAttachments, submitRuntimeKey, restoreConsumedDrafts,
            restoreComposerText,
        })).finally(() => unconfirmedSend?.settle());

        if (!isMobile) {
            composerRef.current?.focus();
        }
    };

    return { handleSubmit };
}
