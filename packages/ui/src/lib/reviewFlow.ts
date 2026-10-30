import { isSameModelRef, toModelRef, type Message, type Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { loadMagicPrompts, type MagicPromptSnapshot } from '@/lib/magicPrompts';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import {
  getOriginalSessionID,
  getReviewSessionID,
  isReviewSession,
  withoutReviewSessionLink,
  withReviewSessionLink,
  withReviewSessionMarker,
} from '@/lib/sessionReviewMetadata';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { optimisticSend, patchSessionMetadata, waitForConnectionOrThrow } from '@/sync/session-actions';
import { useSelectionStore } from '@/sync/selection-store';
import { resolveSendSelection, useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages, getSyncParts, getSyncSessionStatus, getSyncSessions, registerSessionDirectory } from '@/sync/sync-refs';
import { markPendingUserSendAnimation } from '@/lib/userSendAnimation';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { syncSessionKnowledge } from '@/lib/sessionKnowledgeApi';

const HANDOFF_TIMEOUT_MS = 180_000;
const HANDOFF_POLL_MS = 400;

type SessionModelContext = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

type StartReviewFlowInput = SessionModelContext & {
  originalSessionID: string;
  directory: string;
  agentMentionName?: string;
  generateHandoff?: boolean;
  returnAfterHandoffRequest?: boolean;
  autoReview?: boolean;
};

const isMessageCompleted = (message: Message): boolean => {
  const finish = (message as { finish?: unknown }).finish;
  if (typeof finish === 'string' && finish.length > 0) return true;
  const completed = (message as { time?: { completed?: unknown } }).time?.completed;
  return typeof completed === 'number' && completed > 0;
};

const getMessageCreatedAt = (message: Message): number => {
  const created = (message as { time?: { created?: unknown } }).time?.created;
  return typeof created === 'number' && Number.isFinite(created) ? created : 0;
};

const getMessageRole = (message: Message): string => {
  const role = (message as { role?: unknown }).role;
  return typeof role === 'string' ? role : '';
};

/**
 * The turn is over only when the session is idle and none of its subagents is
 * still running. A parent goes idle while a background subagent works; OpenCode
 * then hands the result back and the parent runs again, so the reply it left
 * at that pause is not the finished work. Child statuses come from the same
 * live directory store as the parent's.
 */
const isSessionIdle = (sessionID: string, directory: string): boolean => {
  if (getSyncSessionStatus(sessionID, directory)?.type !== 'idle') return false;
  return !getSyncSessions(directory).some((session) => {
    if (session.parentID !== sessionID) return false;
    const childStatus = getSyncSessionStatus(session.id, directory);
    return childStatus !== undefined && childStatus.type !== 'idle';
  });
};

export const isAutoReviewRuntimeCurrent = (runtimeKey: string): boolean => runtimeKey === getRuntimeKey();

export const assertAutoReviewRuntimeStillCurrent = (expectedRuntimeKey?: string): void => {
  if (expectedRuntimeKey && !isAutoReviewRuntimeCurrent(expectedRuntimeKey)) {
    throw new Error('Auto-review stopped because the runtime changed.');
  }
};

// A review session starts with the same review rules as /workspace-review,
// so its findings carry severities the user (or the server's loop) can read.
const reviewSessionInstructions = (prompts: MagicPromptSnapshot): Array<{ text: string }> => [
  { text: prompts.render('session.review.instructions') },
];

// OpenCode v2 messages carry no `parentID`, so a reply can no longer be tied to
// the prompt that caused it. The wait identifies the handoff by ordering
// instead: the newest completed assistant message created after the prompt.
const waitForAssistantText = async (sessionID: string, directory: string, afterCreatedAt: number): Promise<string> => {
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // v2 completes every step, and a step that says "let me check" before a
    // tool call has text too. Only the finished turn holds the handoff.
    if (!isSessionIdle(sessionID, directory)) {
      await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
      continue;
    }
    const messages = getSyncMessages(sessionID, directory);
    const candidates = messages
      .filter((message) => getMessageRole(message) === 'assistant')
      .filter((message) => getMessageCreatedAt(message) >= afterCreatedAt - 1000)
      .filter(isMessageCompleted)
      .sort((left, right) => getMessageCreatedAt(right) - getMessageCreatedAt(left));

    for (const message of candidates) {
      const text = flattenAssistantTextParts(getSyncParts(message.id, directory)).trim();
      if (text) return text;
    }

    await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
  }
  throw new Error('Timed out waiting for handoff response');
};

const resolveModelContext = (sessionID: string): SessionModelContext | null => {
  const selection = useSelectionStore.getState();
  const config = useConfigStore.getState();
  const lastChoice = useSessionUIStore.getState().getLastUserChoice(sessionID);
  const agent = lastChoice?.agent || selection.getSessionAgentSelection(sessionID) || config.currentAgentName || undefined;
  const sessionModel = selection.getSessionModelSelection(sessionID);
  const agentModel = agent ? selection.getAgentModelForSession(sessionID, agent) : null;
  const lastChoiceModel = lastChoice?.providerID && lastChoice.modelID
    ? { providerId: lastChoice.providerID, modelId: lastChoice.modelID }
    : null;
  const selectedModel = lastChoiceModel || agentModel || sessionModel || (config.currentProviderId && config.currentModelId
    ? { providerId: config.currentProviderId, modelId: config.currentModelId }
    : null);
  if (!selectedModel?.providerId || !selectedModel?.modelId) return null;
  if (lastChoiceModel) {
    return {
      providerID: lastChoiceModel.providerId,
      modelID: lastChoiceModel.modelId,
      agent,
      variant: lastChoice?.variant,
    };
  }
  // Variants are model-specific; only reuse one resolved for the same model.
  const selectionVariant = agent
    ? selection.getAgentModelVariantForSession(sessionID, agent, selectedModel.providerId, selectedModel.modelId)
    : undefined;
  const configVariant = config.currentProviderId === selectedModel.providerId && config.currentModelId === selectedModel.modelId
    ? config.currentVariant
    : undefined;
  return {
    providerID: selectedModel.providerId,
    modelID: selectedModel.modelId,
    agent,
    variant: selectionVariant || configVariant || undefined,
  };
};

const sendPlainMessage = async (
  sessionID: string,
  directory: string,
  text: string,
  modelContext?: SessionModelContext | null,
  /** Context items sent ahead of the prompt as synthetic messages. */
  context?: Array<{ text: string }>,
): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const resolved = modelContext ?? resolveModelContext(sessionID);
  if (!resolved) throw new Error('Select a model before sending review flow messages');
  const selection = useSelectionStore.getState();
  selection.saveSessionModelSelection(sessionID, resolved.providerID, resolved.modelID);
  if (resolved.agent) {
    selection.saveSessionAgentSelection(sessionID, resolved.agent);
    selection.saveAgentModelForSession(sessionID, resolved.agent, resolved.providerID, resolved.modelID);
    selection.saveAgentModelVariantForSession(sessionID, resolved.agent, resolved.providerID, resolved.modelID, resolved.variant);
  }
  // Review sessions are real work sessions, so they carry the project's
  // standing context (pinned notes, memory) exactly as a composer send would.
  // The response style is left out: the handoff and the feedback land in the
  // user's own session, whose entry must stay as it is, and a review session
  // starts with no entry of its own.
  await syncSessionKnowledge(directory, sessionID, undefined, runtimeKey);
  markPendingUserSendAnimation(sessionID);
  await optimisticSend({
    runtimeKey,
    sessionId: sessionID,
    content: text,
    directory,
    context,
    onOptimisticInsert: () => requestChatForceScrollBottom(sessionID),
    send: (messageID, context) => {
      // Only a genuine change travels with the prompt; the review session was
      // created on this selection, so normally nothing is switched.
      const selection = resolveSendSelection(sessionID, directory, resolved);
      return opencodeClient.sendMessage({
        runtimeKey,
        id: sessionID,
        directory,
        providerID: resolved.providerID,
        model: selection.model,
        agent: selection.agent,
        text,
        context,
        messageId: messageID,
      }).then(() => undefined);
    },
  });
};

const requestChatForceScrollBottom = (sessionId: string): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('openchamber:chat-force-scroll-bottom', {
    detail: { sessionId },
  }));
};

const openReviewSessionPanel = (directory: string, session: Session): void => {
  useUIStore.getState().openContextPanelTab(directory, {
    mode: 'chat',
    dedupeKey: `session:${session.id}`,
    label: session.title ?? null,
    sessionTitleFallback: session.title ?? null,
  });
};

const getSessionOrNull = async (sessionID: string, directory: string): Promise<Session | null> => {
  try {
    return await opencodeClient.getSession(sessionID, directory);
  } catch {
    return null;
  }
};

const getReviewSessionTitle = (original: Session): string => {
  const implementationTitle = original.title?.trim() || original.id;
  return `Review: ${implementationTitle}`;
};

// A review session runs tools too (reads other directories, verifies with commands),
// so a fresh one starts with the same permission mode as the session it reviews.
// Failure only leaves the reviewer on the default mode the server gave it.
const inheritPermissionAutoAccept = async (originalSessionID: string, reviewSessionID: string): Promise<void> => {
  const permissions = usePermissionStore.getState();
  // `ask` is copied too: otherwise the server's default could make the
  // reviewer more permissive than the session it reviews.
  const mode = permissions.getSessionMode(originalSessionID);
  try {
    await permissions.setSessionMode(reviewSessionID, mode);
  } catch (error) {
    console.warn('[review-flow] failed to inherit permission auto-accept for review session', error);
  }
};

const createOrReuseReviewSession = async (
  originalSessionID: string,
  directory: string,
  selection: SessionModelContext,
  expectedRuntimeKey?: string,
): Promise<Session> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const original = await opencodeClient.getSession(originalSessionID, directory);
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const existingReviewID = getReviewSessionID(original);
  if (existingReviewID) {
    const existing = await getSessionOrNull(existingReviewID, directory);
    assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
    if (existing && isReviewSession(existing)) return existing;
    await patchSessionMetadata(originalSessionID, directory, (metadata) => {
      const next = { ...metadata };
      const openchamber = next.openchamber;
      if (openchamber && typeof openchamber === 'object' && !Array.isArray(openchamber)) {
        const rest = { ...openchamber };
        delete rest.reviewSessionID;
        next.openchamber = rest;
      }
      return next;
    });
  }

  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  // The reviewer's model and agent are known here, so the session is created
  // on them instead of being switched by the first prompt.
  const review = await opencodeClient.createSession({
    title: getReviewSessionTitle(original),
    metadata: withReviewSessionMarker({}, originalSessionID),
    model: { providerID: selection.providerID, id: selection.modelID, variant: selection.variant },
    agent: selection.agent,
  }, directory);
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  registerSessionDirectory(review.id, directory);
  try {
    assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
    await patchSessionMetadata(originalSessionID, directory, (metadata) => withReviewSessionLink(metadata, review.id));
  } catch (error) {
    assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
    await opencodeClient.deleteSession(review.id, directory).catch((deleteError) => {
      console.warn('[review-flow] failed to delete unlinked review session after link failure', deleteError);
    });
    throw error;
  }
  useGlobalSessionsStore.getState().upsertSession(review);
  await inheritPermissionAutoAccept(originalSessionID, review.id);
  return review;
};

/**
 * Auto-review runs on the server: the UI prepares the review session and hands
 * the server every prompt it will send, rendered from the same magic prompts
 * a manual review uses, with their placeholders left for the server to fill.
 * From here on the server sends the handoff request, the review, the fixes and
 * the re-reviews, whether or not this window stays open.
 */
const startAutoReview = async (input: StartReviewFlowInput, selection: SessionModelContext, prompts: MagicPromptSnapshot): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const reviewSession = await createOrReuseReviewSession(input.originalSessionID, input.directory, selection, runtimeKey);
  // A review session kept from an earlier review still runs on the model it
  // had then, and the server's prompts switch nothing: the dialog's choice is
  // put on the session here. A new one was created on it already.
  const model = { providerID: selection.providerID, id: selection.modelID, variant: selection.variant };
  if (!reviewSession.model || !isSameModelRef(reviewSession.model, toModelRef(model))) {
    assertAutoReviewRuntimeStillCurrent(runtimeKey);
    await opencodeClient.switchSessionModel(reviewSession.id, model, input.directory);
  }
  if (selection.agent && reviewSession.agent !== selection.agent) {
    assertAutoReviewRuntimeStillCurrent(runtimeKey);
    await opencodeClient.switchSessionAgent(reviewSession.id, selection.agent, input.directory);
  }
  const withHandoff = input.generateHandoff ?? true;
  assertAutoReviewRuntimeStillCurrent(runtimeKey);
  await useAutoReviewStore.getState().startRun({
    originalSessionID: input.originalSessionID,
    reviewSessionID: reviewSession.id,
    directory: input.directory,
    handoff: withHandoff
      ? { text: prompts.render('session.reviewHandoff.visible'), instructions: prompts.render('session.reviewHandoff.instructions') }
      : undefined,
    prompts: {
      reviewStart: withHandoff
        ? prompts.render('session.reviewSession.visible', { handoff: '{{handoff}}' })
        : prompts.render('session.reviewSessionWithoutHandoff.visible'),
      reviewRules: prompts.render('session.review.instructions'),
      feedbackToImplementer: prompts.render('session.reviewFeedbackToImplementer.visible', { review_feedback: '{{review_feedback}}' }),
      responseToReviewer: prompts.render('session.implementationResponseToReviewer.visible', { implementation_response: '{{implementation_response}}' }),
    },
  });
};

export const startReviewFlow = async (input: StartReviewFlowInput): Promise<void> => {
  await waitForConnectionOrThrow();
  const reviewSelection: SessionModelContext = {
    providerID: input.providerID,
    modelID: input.modelID,
    agent: input.agent,
    variant: input.variant,
  };
  // One read for the whole flow: the half after the handoff renders from the
  // same overrides as the request that started it.
  const prompts = await loadMagicPrompts(input.directory);
  if (input.autoReview) return startAutoReview(input, reviewSelection, prompts);

  if (input.generateHandoff ?? true) {
    const visibleText = prompts.render('session.reviewHandoff.visible');
    const instructionsText = prompts.render('session.reviewHandoff.instructions');
    const startedAt = Date.now();
    await sendPlainMessage(input.originalSessionID, input.directory, visibleText, null, [
      { text: instructionsText },
    ]);

    const continueFromHandoff = async (): Promise<void> => {
      const handoff = await waitForAssistantText(input.originalSessionID, input.directory, startedAt);
      const handoffReviewPrompt = prompts.render('session.reviewSession.visible', { handoff });
      const reviewSession = await createOrReuseReviewSession(input.originalSessionID, input.directory, reviewSelection);
      await sendPlainMessage(reviewSession.id, input.directory, handoffReviewPrompt, reviewSelection, reviewSessionInstructions(prompts));
      openReviewSessionPanel(input.directory, reviewSession);
    };

    if (input.returnAfterHandoffRequest) {
      void continueFromHandoff().catch((error) => {
        console.error('[review-flow] failed to finish background review flow', error);
      });
      return;
    }

    await continueFromHandoff();
    return;
  }

  const reviewPrompt = prompts.render('session.reviewSessionWithoutHandoff.visible');
  const reviewSession = await createOrReuseReviewSession(input.originalSessionID, input.directory, reviewSelection);
  await sendPlainMessage(reviewSession.id, input.directory, reviewPrompt, reviewSelection, reviewSessionInstructions(prompts));
  openReviewSessionPanel(input.directory, reviewSession);
};

export const sendReviewFeedbackToOriginal = async (reviewSessionID: string, directory: string, reviewFeedback: string): Promise<void> => {
  const reviewSession = await opencodeClient.getSession(reviewSessionID, directory);
  const originalSessionID = getOriginalSessionID(reviewSession);
  if (!originalSessionID) throw new Error('Original session is missing');
  const prompt = (await loadMagicPrompts(directory)).render('session.reviewFeedbackToImplementer.visible', { review_feedback: reviewFeedback });
  await sendPlainMessage(originalSessionID, directory, prompt);
};

export const sendImplementationResponseToReviewer = async (originalSessionID: string, directory: string, implementationResponse: string): Promise<void> => {
  const originalSession = await opencodeClient.getSession(originalSessionID, directory);
  const reviewSessionID = getReviewSessionID(originalSession);
  if (!reviewSessionID) throw new Error('Review session is missing');
  let reviewSession: Session;
  try {
    reviewSession = await opencodeClient.getSession(reviewSessionID, directory);
  } catch (error) {
    await patchSessionMetadata(originalSessionID, directory, (metadata) => withoutReviewSessionLink(metadata, reviewSessionID));
    throw error;
  }
  const prompt = (await loadMagicPrompts(directory)).render('session.implementationResponseToReviewer.visible', { implementation_response: implementationResponse });
  await sendPlainMessage(reviewSessionID, directory, prompt);
  openReviewSessionPanel(directory, reviewSession);
};

export type ReviewTransferDirection = 'review-to-original' | 'original-to-review';

export const getReviewTransferDirection = (session: Session | null | undefined): ReviewTransferDirection | null => {
  if (isReviewSession(session)) return 'review-to-original';
  if (getReviewSessionID(session)) return 'original-to-review';
  return null;
};
