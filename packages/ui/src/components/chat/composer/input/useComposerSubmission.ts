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
import { getRuntimeKey } from '@/lib/runtime-switch';
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
import type { useComposerInputState } from './useComposerInputState';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerParallelRun } from './useComposerParallelRun';
import type { useComposerSessionLifecycle } from './useComposerSessionLifecycle';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerEnvironment } from './useComposerEnvironment';
import type { useComposerDraftHistory } from './useComposerDraftHistory';
import type { useComposerQueueActions } from './useComposerQueueActions';
import type { ChatInputProps, SubmitOptions } from './chatInputProps';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import { runComposerActionCommand } from './runComposerActionCommand';
import { collectInlineSkillMentions } from './composerMentionTokens';
import { recordLinkedReferences } from './recordLinkedReferences';
import { handleComposerSendFailure } from './handleComposerSendFailure';
import { createComposerSubmitErrorMessage } from './createComposerSubmitErrorMessage';

type Dependencies = Pick<ReturnType<typeof useComposerInputState>, 't' | 'waitForPendingAttachments' | 'confirmedMentionsRef' | 'setMessage' | 'setPromptHistorySearch' | 'composerRef' | 'openTimelineDialog' | 'sendMessage' | 'currentChatDraftIdentityRef' | 'composerText'>
    & Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen' | 'hasDrafts' | 'attachmentsToSend' | 'inlineDraftTarget' | 'consumeDrafts'>
    & Pick<ReturnType<typeof useComposerSendAvailability>, 'handleSubmitRef' | 'pendingFirstSend' | 'composerQueuedMessages' | 'getCurrentInputSnapshot' | 'hasQueuedMessages'>
    & Pick<ReturnType<typeof useComposerSessionScope>, 'isBtwActive' | 'currentSessionId' | 'btwPanel' | 'newSessionDraftOpen' | 'newSessionDraft' | 'btwDirectory' | 'currentSessionDirectoryForSync' | 'currentDirectory' | 'attachedFiles' | 'inputMode' | 'btwSessionId' | 'activeRuntimeKey' | 'chatDraftIdentity' | 'immediateBtwSubmitRef' | 'sendHeldByMissingFolder' | 'setReviewDialogOpen' | 'consumePendingSyntheticParts' | 'isPromotedBtwSession' | 'projectActionsRef' | 'clearAttachedFiles' | 'btwComposerSessionId' | 'sessionFolder'>
    & Pick<ReturnType<typeof useComposerParallelRun>, 'parallel'>
    & Pick<ReturnType<typeof useComposerSessionLifecycle>, 'sessionPhase' | 'autoReviewRunning'>
    & Pick<ReturnType<typeof useComposerQueueState>, 'messageQueueTarget' | 'takeForSend'>
    & Pick<ReturnType<typeof useComposerSelection>, 'effectiveBtwSelection' | 'currentProviderId' | 'currentModelId' | 'currentAgentName' | 'currentVariant' | 'mailboxTarget'>
    & Pick<ReturnType<typeof useComposerLanguage>, 'readSessionMentionsBeforeSend' | 'guestCommands' | 'availableSkills' | 'linkedReferences' | 'referenceLinksIn' | 'sessionMentionsIn'>
    & Pick<ReturnType<typeof useComposerEnvironment>, 'isMobile' | 'setExpandedInput' | 'pendingBtwPermissionMode' | 'runtimeTrackers'>
    & Pick<ReturnType<typeof useComposerDraftHistory>, 'handoffDraft' | 'restoreDraft' | 'persistDraftImmediately' | 'messageHistory' | 'migrateDraft'>
    & Pick<ReturnType<typeof useComposerQueueActions>, 'handleQueueMessage'>
    & Pick<ChatInputProps, 'scrollToBottom'>
    & Pick<ReturnType<typeof useComposerMentionAttachments>, 'prepareReadOnSendMentions' | 'mentionableAgents' | 'extractInlineFileMentions' | 'sanitizeAttachmentsForSend'>
    & Pick<ReturnType<typeof useComposerReferenceDrafts>, 'updateLinkedReferencesFor'>;

export function useComposerSubmission({
    t, isMobileCommentOpen, waitForPendingAttachments, handleSubmitRef, isBtwActive, currentSessionId,
    btwPanel, pendingFirstSend, parallel, sessionPhase, messageQueueTarget, newSessionDraftOpen,
    newSessionDraft, composerQueuedMessages, effectiveBtwSelection, currentProviderId, currentModelId,
    currentAgentName, currentVariant, btwDirectory, currentSessionDirectoryForSync, currentDirectory,
    attachedFiles, hasDrafts, getCurrentInputSnapshot, autoReviewRunning, readSessionMentionsBeforeSend,
    hasQueuedMessages, inputMode, isMobile, btwSessionId, activeRuntimeKey, handoffDraft, chatDraftIdentity,
    immediateBtwSubmitRef, sendHeldByMissingFolder, confirmedMentionsRef, restoreDraft, guestCommands,
    setMessage, persistDraftImmediately, messageHistory, setPromptHistorySearch, handleQueueMessage,
    setExpandedInput, composerRef, scrollToBottom, openTimelineDialog, setReviewDialogOpen,
    prepareReadOnSendMentions, takeForSend, attachmentsToSend, consumePendingSyntheticParts, mailboxTarget,
    inlineDraftTarget, consumeDrafts, availableSkills, linkedReferences, referenceLinksIn,
    isPromotedBtwSession, sessionMentionsIn, mentionableAgents, extractInlineFileMentions,
    sanitizeAttachmentsForSend, projectActionsRef, clearAttachedFiles, sendMessage, btwComposerSessionId,
    pendingBtwPermissionMode, migrateDraft, runtimeTrackers, updateLinkedReferencesFor,
    currentChatDraftIdentityRef, composerText, sessionFolder,
}: Dependencies) {
    const getSubmitErrorMessage = createComposerSubmitErrorMessage(t);

    const handleSubmit = async (options?: SubmitOptions) => {
        // Comment mode's only submit is attach; every other send path must be
        // inert while it is open.
        if (isMobileCommentOpen()) return;
        // Files still being attached: send once they are in, with the handler
        // of the render that has them.
        if (await waitForPendingAttachments()) {
            void handleSubmitRef.current(options);
            return;
        }
        if (isBtwActive && currentSessionId && (btwPanel.creating || useBtwStore.getState().byParent[currentSessionId]?.pendingSend)) return;
        if (pendingFirstSend) return;
        // "Run in parallel" launches the run instead of sending a message.
        if (parallel.isActive && !options?.queuedOnly) {
            if (parallel.runCount >= 2) void parallel.launch();
            return;
        }
        const submitRuntimeKey = getRuntimeKey();
        const queuedOnly = options?.queuedOnly ?? false;
        const queuedMessageId = options?.queuedMessageId;
        const delivery = options?.delivery === 'steer' && sessionPhase !== 'idle' ? 'steer' : undefined;
        const capturedTarget = messageQueueTarget;
        // Snapshot the draft and current-session identity before the first
        // async gap so a later sidebar selection cannot reroute the send.
        const capturedDraftSnapshot = newSessionDraftOpen ? { ...newSessionDraft } : null;
        // Capture the level and its revision together, before mention reads or
        // any other preparation can yield to a newer picker choice.
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
        // Magic prompts come from the directory this send lands in, routed the
        // way sendMessage routes it: the /btw fork, the session, else the
        // draft. A new chat has no folder yet and reads the global prompts.
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

        // Local slash commands are planned before anything is taken or
        // consumed. An action command must leave the queue and the attached
        // context where they are; a prompt command must send that context with
        // the prompt it produces. A command the composer cannot run here is not
        // a local command at all and goes out as typed.
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

        // Enter BTW before sending so the question uses its isolated selections.
        // A bare command waits for input; an argument requests one immediate send.
        if (commandPlan?.kind === 'prompt' && commandPlan.command.name === 'btw' && currentSessionId) {
            const targetComposerId = btwSessionId ?? btwPendingComposerKey(currentSessionId);
            const targetIdentity = createChatDraftIdentity(
                activeRuntimeKey,
                btwDirectory ?? currentSessionDirectoryForSync ?? currentDirectory,
                targetComposerId,
            );
            const argument = commandPlan.command.argument.trim();
            handoffDraft(targetIdentity, isBtwActive ? argument : argument || null);
            // Files pasted with the question go with it; their `[image-1.png]` citations moved above.
            useInputStore.getState().moveAttachedFiles(chatDraftIdentity, targetIdentity);
            if (argument && targetIdentity) immediateBtwSubmitRef.current = { identity: targetIdentity, text: argument };
            if (btwSessionId) {
                useBtwStore.getState().setPanelState(currentSessionId, { collapsed: false });
                return;
            }
            useBtwStore.getState().setPanelState(currentSessionId, { pending: true, creating: false, collapsed: false });
            return;
        }

        // Opening BTW is local and still works while authentication is expired.
        if (useAuthSessionStore.getState().state !== 'ok') {
            toast.error(t('sessionAuth.expired.sendBlocked'));
            return;
        }

        if (sendHeldByMissingFolder()) return;

        // A failed send returns the typed prompt no matter WHY it failed —
        // auth, network, server, anything. Losing a long prompt to a toast is
        // the one outcome this handler must never produce. The mentions are
        // snapshotted here because sending clears them before it can fail.
        const confirmedMentionsSnapshot = new Set(confirmedMentionsRef.current);
        const restoreComposerText = (target: ChatDraftIdentity | null = chatDraftIdentity) => {
            if (queuedOnly || !inputSnapshot.message) return;
            restoreDraft(target, inputSnapshot.message, confirmedMentionsSnapshot);
        };

        // An extension command never reaches the model: the extension turns
        // `/name args` into a chip, which lands through the same pending slot
        // a guest panel's `attach` uses. Nothing else in the composer moves.
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
                    // Nothing matched: give the command back so the user can fix the argument.
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

        // The isolated space the message targets, if any: a session by its directory, a draft by
        // the creation request it still waits on or by its directory.
        const spaceTarget = currentSessionId
            ? { requestId: null, directory: currentSessionDirectoryForSync ?? currentDirectory ?? null }
            : newSessionDraftOpen
                ? { requestId: newSessionDraft?.pendingWorktreeRequestId ?? null, directory: newSessionDraft?.directoryOverride ?? null }
                : null;
        // A stopped space takes no message on any model, and its catalog does not load while it is
        // stopped, so this comes before the model check. The message stays in the composer;
        // "Start", where the group's menu offers it, brings the space back and the user sends again.
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

        // A message to an isolated space goes only on a model the space holds a key for; otherwise
        // it stays in the input with the reason and the way to the grant dialog.
        const spaceRefusal = spaceTarget ? spaceModelRefusal(spaceTarget, providerIdToSend) : null;
        if (spaceRefusal) {
            const provider = useConfigStore.getState().providers.find((entry) => entry.id === spaceRefusal.providerId)?.name ?? spaceRefusal.providerId;
            // No grant gives a space OpenCode's models, so that dialog opens on no provider.
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

        // Auto-review owns the active workflow; follow-ups wait in its queue.
        if (currentSessionId && !queuedOnly && autoReviewRunning && !isBtwActive && !commandPlan) {
            void handleQueueMessage();
            return;
        }

        // btw mode: the child fork's blocking prompts are answered inside the
        // panel; the composer send goes straight to the fork (routeMessage
        // queues if the fork's own turn is busy).
        let deferredQuestions: readonly FormRequest[] = [];
        if (currentSessionId && !queuedOnly && !isBtwActive && !commandPlan) {
            // Sending is authoritative for blocking prompts: deny pending
            // permissions and dismiss the open forms that hold a turn in the
            // session subtree (a form whose tool call ended stays). The
            // deny/clear vanishes the card instantly (optimistic); rejecting
            // unblocks the agent's tool but does NOT end its turn. The
            // session's own waiting question is deferred instead, after the
            // send below (#5391); a shell command is no message to defer to.
            const [deniedPermissions, forms] = await Promise.all([
                sessionActions.dismissOpenPermissionsForSession(currentSessionId),
                sessionActions.dismissOpenFormsForSession(currentSessionId, { deferQuestions: inputMode !== 'shell' }),
            ]);
            // An explicit Steer goes straight to the session inbox, which
            // takes it while the turn is still active. Any other send would
            // race with that run, so it is queued; the queued-message auto-send
            // hook delivers it once the session returns to idle (#1740, #3369).
            // A deferred question still holds the session's turn, so the queue
            // would never deliver: the message goes to the inbox instead, even
            // when a subagent's request was dismissed alongside it.
            if ((deniedPermissions || forms.dismissed) && delivery !== 'steer' && forms.deferred.length === 0) {
                void handleQueueMessage();
                return;
            }
            deferredQuestions = forms.deferred;
        }

        // Action commands change session or UI state and send nothing. The
        // command text goes; the queue and whatever the composer had attached
        // stay exactly where they are.
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
        // BTW and queued-only sends carry their own saved configuration and
        // leave the main composer's remembered level alone.
        sendMessageOptions = { ...sendMessageOptions, userInitiated: true, recordEffort: !isBtwActive && !queuedOnly, effortRevision };
        let sent: SentMessage | undefined;
        if (deferredQuestions.length > 0) sendMessageOptions.onSent = (route) => { sent = route; };

        // Queued messages resolved their mentions when they were queued; only
        // the composer's own text can still name a file to read.
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

        // The composer delivers these itself, so they leave the queue now — the
        // queue's own delivery (server-side, or the auto-send hook in VS Code)
        // skips anything already in flight, and a message already being
        // delivered stays out of this send so it cannot go out twice.
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
            // A taken message brings the goal it was queued with. Without one,
            // the composer's armed goal is for the composer text: a queued-only
            // send leaves it alone.
            const queuedGoal = queuedMessagesToSend.find((queued) => queued.goal)?.goal;
            if (queuedGoal || queuedOnly) {
                sendMessageOptions = { ...sendMessageOptions, queuedGoal: queuedGoal ?? null };
            }
        }

        // Only the files the text still cites go, and the screenshots of the
        // annotations going with it: a deleted chip drops its file, and undo,
        // which only rewrites the text, brings it back.
        const sentAttachedFiles = attachmentsToSend(inputSnapshot.message);
        const historySubmissions = buildChatInputHistorySubmissions({
            inputMode,
            // Server-owned items were recorded on acceptance. VS Code records
            // the full items actually taken, never the metadata projection.
            queuedMessages: isServerOwnedMessageQueue() ? [] : queuedMessagesToSend,
            composerText: inputSnapshot.message,
            composerAttachments: sentAttachedFiles,
            includeComposer: !queuedOnly && inputSnapshot.hasContent,
        });
        if (historySubmissions?.length) {
            sendMessageOptions = { ...sendMessageOptions, historySubmissions };
        }

        // Inline review comments and synthetic context are consumed before
        // assembly so a failed send can restore exactly what it took. What is
        // here belongs to this send: queueing took its own context with it.
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
        // Everything a prompt command consumed comes back if it fails: the
        // attached context, the typed text, and the files.
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

        // Comments become synthetic context, which the send-time expansion
        // below skips, so their own words expand here.
        const expandedDrafts = await expandCommentSnippets(drafts, useSnippetsStore.getState().expandText);

        // The chips, then the items the text links that are not chips already.
        const sentComposerText = !queuedOnly && inputSnapshot.hasContent ? inputSnapshot.message : '';
        // A page chip whose link the server is still taking goes out with its id.
        // An item goes when the text links it: its chip is its link.
        const linkedReferencesToSend = await withRegisteredSharedPages(withReferencesFromText(referencesLinkedIn(sentComposerText, linkedReferences), referenceLinksIn(sentComposerText)));

        const outgoing = buildOutgoingMessage({
            queued: queuedMessagesToSend,
            // A shared page goes as its card and content; its keyless link leaves the text.
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

        // After the empty check: the note alone is no reason to send.
        const actionsNote = isBtwActive ? null : planRunningActionsNote(currentSessionId ?? null, collectRunningActions(projectActionsRef.current));
        if (actionsNote?.text) additionalParts.push({ text: actionsNote.text, synthetic: true });

        // Skills named inline are attached to the prompt so OpenCode loads
        // them with the message, rather than hoping the model follows a hint.
        if (skillNames.length > 0) {
            sendMessageOptions = {
                ...sendMessageOptions,
                skills: { names: skillNames, instructionFor: buildSkillMentionInstruction },
            };
        }

        // #3898: inline @-mentions resolve to server paths without checking
        // the file exists, and OpenCode 400s the whole prompt on a missing
        // file. Silently drop the unresolvable ones and submit the rest;
        // the prompt text itself is untouched. Filtered once here so every
        // send path below (magic-prompt, btw fork, optimistic row, main send)
        // carries the same list.
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

        // Clear input (the queue was taken above)
        if (!queuedOnly) {
            setMessage('');
            confirmedMentionsRef.current.clear();
            // Clear per-session draft on submit
            persistDraftImmediately(chatDraftIdentity, '');
            messageHistory.reset();
            setPromptHistorySearch(null);
            if (attachedFiles.length > 0) {
                clearAttachedFiles(chatDraftIdentity);
            }
            // Close expanded input overlay when submitting
            if (!isBtwActive) setExpandedInput(false);
        }

        if (isMobile) {
            composerRef.current?.blur();
        }

        // Prompt commands render a visible prompt and send it with everything
        // the composer had attached. `/btw` was handled above as a composer
        // transition and never reaches this sending path.
        if (commandPlan?.kind === 'prompt') {
            const { name: commandName, argument } = commandPlan.command;

            // The rest render a visible prompt plus synthetic instructions and
            // send them as one message, the attached context riding along.
            const command = findMagicPromptCommand(commandName);
            if (command) {
                const variables = buildCommandVariables(command, argument);
                try {
                    await sessionActions.waitForConnectionOrThrow();
                    const prompts = await loadMagicPrompts(magicPromptDirectory);
                    const visibleText = prompts.render(command.visiblePrompt, variables.visible);
                    const instructionsText = prompts.render(command.instructionsPrompt, variables.instructions);
                    // Before the sent row commits, as for a plain send below.
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

        // Collect all attachments for error recovery
        const allAttachments = [
            ...sendableAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        // Arm the timeline anchor BEFORE the optimistic user row can commit;
        // arming after (or a frame later) races the commit and the anchor
        // never claims the new message.
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
                // The files pasted while the fork was being created are this composer's.
                useInputStore.getState().moveAttachedFiles(chatDraftIdentity, forkIdentity);
                if (inlineDraftTarget) {
                    const drafts = useInlineCommentDraftStore.getState();
                    drafts.restoreDrafts({ directory: forkDirectory, sessionKey: fork.id }, drafts.consumeDrafts(inlineDraftTarget));
                }
                useBtwStore.getState().setPanelState(currentSessionId, { pending: false, creating: false, pendingSend: undefined });
                // The pending composer's picks live on the fork now
                // (`startBtwSession` saved them there). Left under the pending
                // key they outlive this question, and the next `/btw` in this
                // parent would open on its agent, model and effort instead of
                // Plan and what the main composer is on.
                useSelectionStore.getState().clearSessionSelections(btwComposerSessionId);
                scrollToBottom?.();
            } catch (error) {
                if (!ownsPendingBtwSend()) return;
                if (getRuntimeKey() !== submitRuntimeKey) {
                    useBtwStore.getState().clearPanelState(currentSessionId);
                    restoreComposerText();
                    return;
                }
                // Preserve the pending owner before restoring text so a failed
                // first send never drops back into the parent draft.
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
            // The message is admitted, so the question's note can follow it; a failed send defers nothing,
            // and the route decides whether it was a message to the question's session at all.
            if (deferredQuestions.length > 0 && getRuntimeKey() === submitRuntimeKey) {
                void sessionActions.deferQuestionsAfterSend(deferredQuestions, sent);
            }
            if (isBtwActive) return;
            // On a draft there is no session yet in this closure: the send path
            // creates one and makes it current before resolving, so the id is
            // read from the store. The fallback is used only when the closure
            // had no session at all, so a mid-send session switch cannot
            // redirect the write to an unrelated session.
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
            // A session that starts with a tracker item attached reports itself
            // on that item (the tracker's Session comments, where it has them),
            // however it was started: a draft, a worktree made from the item.
            if (!currentSessionId && linkTargetSessionId) {
                for (const reference of linkedReferencesToSend) {
                    if (reference.kind !== 'tracker-item') continue;
                    void postTrackerSessionStarted(runtimeTrackers, reference.provider, {
                        sessionId: linkTargetSessionId,
                        identifier: reference.identifier,
                    });
                }
            }

            // Clear only the draft captured by this send; newly attached references stay.
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

    // Update ref with latest handleSubmit on every render
    handleSubmitRef.current = handleSubmit;

    return {
        handleSubmit,
    };
}
