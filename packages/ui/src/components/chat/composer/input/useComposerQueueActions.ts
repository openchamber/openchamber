import type { useI18n } from '@/lib/i18n';
import type { useComposerSessionScope } from './useComposerSessionScope';
import type { useComposerSendAvailability } from './useComposerSendAvailability';
import type { useComposerSelection } from './useComposerSelection';
import type { useComposerReferenceDrafts } from './useComposerReferenceDrafts';
import type { useComposerQueueState } from './useComposerQueueState';
import type { useComposerPreferences } from './useComposerPreferences';
import type { useComposerMentionAttachments } from './useComposerMentionAttachments';
import type { useComposerLanguage } from './useComposerLanguage';
import type { useComposerInlineContext } from './useComposerInlineContext';
import type { useComposerEditorState } from './useComposerEditorState';
import type { useComposerDraftText } from './useComposerDraftText';
import type { useComposerAttachmentWork } from './useComposerAttachmentWork';
import type { ComposerSendHandlers } from './composerSendHandlers';
import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { type QueuedContextPart, type QueuedMessageGoal } from '@/stores/messageQueueStore';
import { useSessionGoalArmStore } from '@/stores/useSessionGoalArmStore';
import { useSelectionStore } from '@/sync/selection-store';
import { prepareUserMessageResume } from '@/sync/user-message-resume';
import { useInputStore, type SyntheticContextPart } from '@/sync/input-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { CONTEXT_METADATA_KEY, draftFromContextPayload } from '@/lib/messages/contextParts';
import { toast } from '@/components/ui';
import { collectRunningActions, planRunningActionsNote } from '../../lib/runningActionsNote';
import { toContextReference, withComposerReferences, type ComposerReference } from '../../composer/composerReferences';
import { referencesLinkedIn, withoutSharedPageLinks, withReferencesFromText } from '../../composer/referenceLinks';
import { type SessionReference } from '../../composer/sessionReferences';
import { routeGuestSlashCommand } from '../../composer/submit/guestCommands';
import { opencodeClient } from '@/lib/opencode/client';
import { buildSkillMentionInstruction } from '@/lib/skillMentionInstruction';
import { withMissingCitations } from '@/lib/attachmentIdentity';
import { filterMissingInlineAttachments } from '../../composer/attachments/inlineMentionAttachments';
import { buildComposerContext, expandCommentSnippets } from '../../composer/submit/buildOutgoingMessage';
import { planLocalSlashCommand } from '../../composer/submit/slashCommands';
import { withoutShareLinkKeys } from '@/lib/received-pages/link';
import { withRegisteredSharedPages } from '../../sharePages/received/takeShareLink';
import type { ChatInputProps } from './chatInputProps';
import { collectInlineSkillMentions } from './composerMentionTokens';
import { recordLinkedReferences } from './recordLinkedReferences';

type Dependencies = {
    inlineContext: Pick<ReturnType<typeof useComposerInlineContext>, 'isMobileCommentOpen' | 'hasDrafts' | 'attachmentsToSend' | 'inlineDraftTarget' | 'consumeDrafts'>;
    attachmentWork: Pick<ReturnType<typeof useComposerAttachmentWork>, 'waitForPendingAttachments'>;
    i18n: Pick<ReturnType<typeof useI18n>, 't'>;
    draftText: Pick<ReturnType<typeof useComposerDraftText>, 'setMessage' | 'confirmedMentionsRef' | 'composerText'>;
    editorState: Pick<ReturnType<typeof useComposerEditorState>, 'composerRef'>;
    sendHandlers: Pick<ComposerSendHandlers, 'handleQueueMessageRef' | 'handleSubmitRef'>;
    sendAvailability: Pick<ReturnType<typeof useComposerSendAvailability>, 'getCurrentInputSnapshot'>;
    sessionScope: Pick<ReturnType<typeof useComposerSessionScope>, 'currentSessionId' | 'inputMode' | 'sendHeldByMissingFolderRef' | 'consumePendingSyntheticParts' | 'projectActionsRef' | 'clearAttachedFiles' | 'chatDraftIdentity'>;
    queueState: Pick<ReturnType<typeof useComposerQueueState>, 'messageQueueTarget' | 'addToQueue' | 'popQueuedToInput'>;
    language: Pick<ReturnType<typeof useComposerLanguage>, 'guestCommands' | 'readSessionMentionsBeforeSend' | 'linkedReferences' | 'availableSkills' | 'referenceLinksIn' | 'sessionMentionsIn' | 'rememberSessionMentions'>;
    selection: Pick<ReturnType<typeof useComposerSelection>, 'currentProviderId' | 'currentModelId' | 'mailboxTarget' | 'currentAgentName' | 'currentVariant'>;
    mentionAttachments: Pick<ReturnType<typeof useComposerMentionAttachments>, 'sanitizeAttachmentsForSend' | 'prepareReadOnSendMentions' | 'mentionableAgents' | 'extractInlineFileMentions'>;
    props: Pick<ChatInputProps, 'scrollToLatest'>;
    referenceDrafts: Pick<ReturnType<typeof useComposerReferenceDrafts>, 'setLinkedReferencesFor' | 'updateLinkedReferencesFor' | 'updateLinkedReferences'>;
    preferences: Pick<ReturnType<typeof useComposerPreferences>, 'isMobile'>;
};

export function useComposerQueueActions({
    inlineContext, attachmentWork, i18n, draftText, editorState, sendHandlers, sendAvailability,
    sessionScope, queueState, language, selection, mentionAttachments, props, referenceDrafts,
    preferences,
}: Dependencies) {
    const { isMobileCommentOpen, hasDrafts, attachmentsToSend, inlineDraftTarget, consumeDrafts } = inlineContext;
    const { waitForPendingAttachments } = attachmentWork;
    const { t } = i18n;
    const { setMessage, confirmedMentionsRef, composerText } = draftText;
    const { composerRef } = editorState;
    const { handleQueueMessageRef, handleSubmitRef } = sendHandlers;
    const { getCurrentInputSnapshot } = sendAvailability;
    const {
        currentSessionId, inputMode, sendHeldByMissingFolderRef, consumePendingSyntheticParts,
        projectActionsRef, clearAttachedFiles, chatDraftIdentity,
    } = sessionScope;
    const { messageQueueTarget, addToQueue, popQueuedToInput } = queueState;
    const {
        guestCommands, readSessionMentionsBeforeSend, linkedReferences, availableSkills,
        referenceLinksIn, sessionMentionsIn, rememberSessionMentions,
    } = language;
    const { currentProviderId, currentModelId, mailboxTarget, currentAgentName, currentVariant } = selection;
    const {
        sanitizeAttachmentsForSend, prepareReadOnSendMentions, mentionableAgents,
        extractInlineFileMentions,
    } = mentionAttachments;
    const { scrollToLatest } = props;
    const { setLinkedReferencesFor, updateLinkedReferencesFor, updateLinkedReferences } = referenceDrafts;
    const { isMobile } = preferences;

    // Add message to queue instead of sending
    const handleQueueMessage = React.useCallback(async () => {
        // The comment's exit paths are attach/cancel; queueing a real prompt
        // underneath comment mode must never fire.
        if (isMobileCommentOpen()) return;
        // Files still being attached: queue once they are in.
        if (await waitForPendingAttachments()) {
            void handleQueueMessageRef.current();
            return;
        }
        const inputSnapshot = getCurrentInputSnapshot();
        if (!inputSnapshot.hasContent || !currentSessionId || !messageQueueTarget) return;

        // A local or extension command is run, not queued: the queue delivers
        // text to the model, and `/compact`, `/btw`, or `/task` mean nothing there.
        if (planLocalSlashCommand(inputSnapshot.message, inputMode, hasDrafts, true)
            || routeGuestSlashCommand(inputSnapshot.message, inputMode, guestCommands)) {
            void handleSubmitRef.current();
            return;
        }
        if (sendHeldByMissingFolderRef.current()) return;
        const queueRuntimeKey = getRuntimeKey();
        const queueTarget = messageQueueTarget;
        const queueSessionId = currentSessionId;
        const settleModelPick = useSelectionStore.getState().captureSessionModelPickSettlement(
            queueSessionId, currentProviderId, currentModelId, queueRuntimeKey,
        );
        // Queueing is the same user intent as sending, so an archived session
        // comes back once the queue accepts the message, not at delivery.
        const resumeAfterQueue = prepareUserMessageResume(queueSessionId, queueRuntimeKey);
        // A share link's key is never queued, even one the composer did not turn into a chip.
        const messageToQueue = withoutShareLinkKeys(inputSnapshot.message.replace(/^\n+|\n+$/g, ''));
        if (!(await readSessionMentionsBeforeSend(messageToQueue))) return;
        // Only the files the text still cites go, and the screenshots of the
        // annotations going with it: a deleted chip drops its file.
        const composerAttachments = sanitizeAttachmentsForSend(attachmentsToSend(messageToQueue));

        // A queued message is resolved now, not at delivery: the server that
        // sends it has no agent list, no confirmed mentions, and no way to read
        // a file the user named — and the mention must match what was
        // visible when the user typed it.
        const readOnSendMentions = await prepareReadOnSendMentions(
            [messageToQueue],
            new Set(composerAttachments.map((attachment) => attachment.filename)),
            queueRuntimeKey,
            composerAttachments,
        );
        if (readOnSendMentions.status === 'runtime-changed') return;
        if (readOnSendMentions.status === 'failed') {
            toast.error(t('chat.chatInput.toast.attachNamedFailed', { name: readOnSendMentions.filename }));
            return;
        }
        // A shared page goes as its card and content; its keyless link leaves the delivered text.
        const { sanitizedText, mention } = parseAgentMentions(withoutSharedPageLinks(messageToQueue, linkedReferences), mentionableAgents());
        const { attachments: extractedMentionAttachments } = extractInlineFileMentions(sanitizedText, readOnSendMentions.prepared, composerAttachments);
        // #3898: a queued message is delivered later without the composer, so
        // a phantom mention (`@masha.conner`) must be dropped now or the
        // delivery 400s.
        const { sendable: mentionAttachments } = await filterMissingInlineAttachments(
            extractedMentionAttachments,
            opencodeClient,
        );
        const availableSkillNames = new Set(
            availableSkills.map((skill) => skill.name),
        );
        const skillInstruction = buildSkillMentionInstruction(collectInlineSkillMentions(sanitizedText, availableSkillNames));
        // The server and the VS Code auto-send deliver `text` as is, so its
        // snippets expand now; `content` keeps them for editing.
        const textToQueue = await useSnippetsStore.getState().expandText(sanitizedText).catch((error) => {
            console.warn('[queue] Failed to expand snippets, queueing original text:', error);
            return sanitizedText;
        });

        // Everything attached to the composer leaves with the message: the
        // chips are part of what was queued, and come back if it is edited.
        const syntheticParts = consumePendingSyntheticParts(mailboxTarget) ?? [];
        const draftTarget = inlineDraftTarget;
        const drafts = draftTarget ? consumeDrafts(draftTarget) : [];
        // The items the text links: an item's chip is its link, so one deleted from the text stays behind.
        const linked = referencesLinkedIn(messageToQueue, linkedReferences);
        const linkedToQueue = await withRegisteredSharedPages(withReferencesFromText(linked, referenceLinksIn(messageToQueue)));
        // Queued context is delivered as captured, so comment snippets expand now.
        const expandedDrafts = await expandCommentSnippets(drafts, useSnippetsStore.getState().expandText);
        const actionsNote = currentSessionId
            ? planRunningActionsNote(currentSessionId, collectRunningActions(projectActionsRef.current))
            : null;
        const context = buildComposerContext({
            inlineComments: expandedDrafts,
            syntheticTexts: [...syntheticParts.map((part) => part.text), ...(actionsNote?.text ? [actionsNote.text] : [])],
            references: [...linkedToQueue.map(toContextReference), ...sessionMentionsIn(messageToQueue)],
        }, skillInstruction);
        const attachmentsToQueue = [...composerAttachments, ...mentionAttachments];
        // An armed goal belongs to this message: it leaves with it and starts
        // when this message is delivered, whatever is sent in between.
        const goalArm = textToQueue.trim()
            ? useSessionGoalArmStore.getState().consume()
            : { armed: false, objectiveOverride: null };
        const goalSettings = useUIStore.getState();
        const goal: QueuedMessageGoal | undefined = goalArm.armed ? {
            tokenBudget: goalSettings.sessionGoalDefaultBudgetEnabled ? goalSettings.sessionGoalDefaultBudget : null,
        } : undefined;
        if (goal && goalArm.objectiveOverride?.trim()) goal.objective = goalArm.objectiveOverride;

        // Sending while the agent works must still take the reader to the
        // live edge — a queued message produces no user row yet, so the
        // anchor path has nothing to claim and would leave the viewport
        // parked mid-history.
        scrollToLatest?.();

        // Clear the composer. The mentions it had confirmed were resolved
        // above, so nothing later needs them.
        setMessage('');
        confirmedMentionsRef.current.clear();
        if (composerAttachments.length > 0) {
            clearAttachedFiles(chatDraftIdentity);
        }
        setLinkedReferencesFor(chatDraftIdentity, []);
        if (!isMobile) {
            composerRef.current?.focus();
        }

        try {
            await addToQueue(queueTarget, {
                content: messageToQueue,
                text: textToQueue,
                agentMention: mention?.name,
                attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
                context: context.length > 0 ? context : undefined,
                sendConfig: currentProviderId && currentModelId ? {
                    providerID: currentProviderId,
                    modelID: currentModelId,
                    agent: currentAgentName ?? undefined,
                    variant: currentVariant ?? undefined,
                } : undefined,
                goal,
            });
        } catch (error) {
            console.warn('[queue] failed to queue message:', error);
            toast.error(t('chat.queuedMessage.toast.queueFailed'));
            if (goalArm.armed) useSessionGoalArmStore.getState().setArmed(true, goalArm.objectiveOverride);
            // The composer was cleared on queueing; give everything back. The
            // text is appended if the user has already typed something new.
            const currentInput = composerRef.current?.getValue() ?? composerText.get();
            if (!currentInput) {
                setMessage(messageToQueue);
            } else {
                useInputStore.getState().setPendingInputText(messageToQueue, 'append', mailboxTarget);
            }
            if (composerAttachments.length > 0) {
                useInputStore.getState().restoreAttachedFiles(composerAttachments, chatDraftIdentity);
            }
            if (draftTarget && drafts.length > 0) {
                useInlineCommentDraftStore.getState().restoreDrafts(draftTarget, drafts);
            }
            if (syntheticParts.length > 0) {
                useInputStore.getState().setPendingSyntheticParts(syntheticParts, mailboxTarget);
            }
            // Anything attached while the queue write was out stays, after these.
            updateLinkedReferencesFor(chatDraftIdentity, (current) => withComposerReferences(linked, current));
            return;
        }
        // The queued message carries the agent to the session now, whoever
        // delivers it.
        if (queueSessionId && currentAgentName) {
            useSelectionStore.getState().settleSessionAgentPick(queueSessionId, currentAgentName);
        }
        if (inputMode !== 'shell') settleModelPick();
        void resumeAfterQueue().catch(console.warn);
        recordLinkedReferences(queueSessionId, queueTarget.directory, linkedToQueue);
        if (currentSessionId) actionsNote?.commit(currentSessionId);
    }, [getCurrentInputSnapshot, currentSessionId, messageQueueTarget, inputMode, hasDrafts, guestCommands, attachmentsToSend, sanitizeAttachmentsForSend, prepareReadOnSendMentions, extractInlineFileMentions, mentionableAgents, availableSkills, consumePendingSyntheticParts, mailboxTarget, inlineDraftTarget, consumeDrafts, linkedReferences, scrollToLatest, clearAttachedFiles, chatDraftIdentity, setLinkedReferencesFor, updateLinkedReferencesFor, isMobile, isMobileCommentOpen, addToQueue, currentProviderId, currentModelId, currentAgentName, currentVariant, t, readSessionMentionsBeforeSend, sessionMentionsIn, referenceLinksIn, composerText, setMessage, waitForPendingAttachments, projectActionsRef, handleSubmitRef, handleQueueMessageRef, confirmedMentionsRef, sendHeldByMissingFolderRef, composerRef]);

    /** Put the context a queued message was captured with back on the composer chips. */
    const restoreQueuedContext = React.useCallback((context: readonly QueuedContextPart[]) => {
        const synthetic: SyntheticContextPart[] = [];
        const restored: Exclude<ComposerReference, { kind: 'shared-page' }>[] = [];
        const sharedPages: ComposerReference[] = [];
        const mentions: SessionReference[] = [];
        for (const part of context) {
            if (part.kind === 'synthetic') {
                synthetic.push({ text: part.text, synthetic: true });
                continue;
            }
            // An instruction is derived from the text, and derived again on send.
            if (part.kind !== 'context') continue;
            const payload = part.metadata[CONTEXT_METADATA_KEY];
            if (payload.kind === 'shared-page') {
                // A page someone else shared goes back as its chip; its text never held the link.
                sharedPages.push({
                    kind: 'shared-page',
                    shareKey: payload.receivedId ?? payload.host,
                    receivedId: payload.receivedId,
                    host: payload.host,
                    title: payload.title || null,
                    opened: payload.opened,
                    contextText: part.text,
                });
            } else if (payload.kind === 'repository-issue') {
                restored.push({
                    kind: 'repository-issue',
                    ...(payload.provider ? { provider: payload.provider } : {}),
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                });
            } else if (payload.kind === 'repository-discussion') {
                restored.push({
                    kind: 'repository-discussion',
                    provider: payload.provider,
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                });
            } else if (payload.kind === 'change-request') {
                // The captured context is final: whatever diff it includes is
                // already in the text, and the branches were not captured.
                // Messages written before providers other than GitHub existed
                // carry no provider, so the reference reads as GitHub's.
                restored.push({
                    kind: 'change-request',
                    provider: payload.provider ?? 'github',
                    number: payload.number,
                    title: payload.title,
                    url: payload.url,
                    head: '',
                    base: '',
                    includeDiff: false,
                    contextText: part.text,
                });
            } else if (payload.kind === 'tracker-item') {
                restored.push({ kind: 'tracker-item', provider: payload.provider, identifier: payload.identifier, title: payload.title, url: payload.url, contextText: part.text });
            } else if (payload.kind === 'session') {
                // The restored text still carries the link; it draws as a chip again.
                mentions.push({ kind: 'session', sessionId: payload.sessionId, title: payload.title, contextText: part.text });
            } else if (payload.kind === 'session-message') {
                mentions.push({
                    kind: 'session-message',
                    sessionId: payload.sessionId,
                    messageId: payload.messageId,
                    sessionTitle: payload.sessionTitle,
                    excerpt: payload.excerpt,
                    contextText: part.text,
                });
            } else if (payload.kind === 'guest-issue' || payload.kind === 'guest-pr') {
                restored.push({
                    kind: 'guest',
                    providerId: payload.providerId,
                    id: payload.id,
                    title: payload.title,
                    url: payload.url,
                    contextText: part.text,
                    thread: payload.kind === 'guest-pr' ? 'pull' : 'issue',
                    data: payload.data,
                });
            } else {
                const draft = draftFromContextPayload(payload);
                if (draft && inlineDraftTarget) {
                    useInlineCommentDraftStore.getState().addDraft(inlineDraftTarget, draft, { written: true });
                }
            }
        }
        // Every item goes back on the draft; one the text does not link yet gets its link written in.
        const chips: ComposerReference[] = [...restored, ...sharedPages];
        if (chips.length > 0) {
            updateLinkedReferences((current) => withComposerReferences(current, chips));
        }
        rememberSessionMentions(mentions);
        if (synthetic.length > 0) {
            const pending = useInputStore.getState().getPendingSyntheticParts(mailboxTarget) ?? [];
            useInputStore.getState().setPendingSyntheticParts([...pending, ...synthetic], mailboxTarget);
        }
    }, [inlineDraftTarget, mailboxTarget, rememberSessionMentions, updateLinkedReferences]);

    // Editing takes the message out of the queue, so sending it again queues
    // one message, not a copy.
    const handleQueuedMessageEdit = React.useCallback((messageId: string) => {
        if (!messageQueueTarget) return;
        // The full message (attachments included) comes back from the queue's
        // owner; the queue row only knows the summary.
        void popQueuedToInput(messageQueueTarget, messageId).then((queued) => {
            if (!queued) return;
            if (queued.attachments && queued.attachments.length > 0) {
                const currentAttachments = useInputStore.getState().attachedFiles;
                useInputStore.getState().setAttachedFiles([...currentAttachments, ...queued.attachments]);
            }
            setMessage(withMissingCitations(queued.content, queued.attachments ?? []));
            // Back in the composer, the message is armed again as it was queued.
            if (queued.goal) useSessionGoalArmStore.getState().setArmed(true, queued.goal.objective ?? null);
            restoreQueuedContext(queued.context ?? []);
            setTimeout(() => {
                composerRef.current?.focus();
            }, 0);
        }).catch((error) => {
            console.warn('[queue] failed to take queued message for editing:', error);
            toast.error(t('chat.queuedMessage.toast.takeFailed'));
        });
    }, [messageQueueTarget, popQueuedToInput, restoreQueuedContext, t, setMessage, composerRef]);

    const handleQueuedMessageSend = React.useCallback((messageId: string) => {
        // Force-sending from the queue during a busy session counts as steer
        void handleSubmitRef.current({ queuedOnly: true, queuedMessageId: messageId, delivery: 'steer' });
    }, [handleSubmitRef]);

    return {
        handleQueueMessage, handleQueuedMessageEdit, handleQueuedMessageSend,
    };
}
