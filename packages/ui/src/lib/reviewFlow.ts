import type { Message, Session } from '@opencode-ai/sdk/v2/client';
import { opencodeClient } from '@/lib/opencode/client';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import {
  getOriginalSessionID,
  getReviewSessionID,
  getSessionMetadata,
  isReviewSession,
  withoutReviewSessionLink,
  withReviewSessionLink,
  withReviewSessionMarker,
} from '@/lib/sessionReviewMetadata';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { optimisticSend, patchSessionMetadata, waitForConnectionOrThrow } from '@/sync/session-actions';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages, getSyncParts, registerSessionDirectory } from '@/sync/sync-refs';
import { markPendingUserSendAnimation } from '@/lib/userSendAnimation';

const HANDOFF_TIMEOUT_MS = 180_000;
const HANDOFF_POLL_MS = 400;
const REVIEW_SESSION_TITLE = 'Review of workspace changes';

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

const waitForAssistantText = async (sessionID: string, directory: string, afterCreatedAt: number): Promise<string> => {
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
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
  additionalParts?: Array<{ text: string; synthetic?: boolean }>,
): Promise<void> => {
  const resolved = modelContext ?? resolveModelContext(sessionID);
  if (!resolved) throw new Error('Select a model before sending review flow messages');
  const selection = useSelectionStore.getState();
  selection.saveSessionModelSelection(sessionID, resolved.providerID, resolved.modelID);
  if (resolved.agent) {
    selection.saveSessionAgentSelection(sessionID, resolved.agent);
    selection.saveAgentModelForSession(sessionID, resolved.agent, resolved.providerID, resolved.modelID);
    selection.saveAgentModelVariantForSession(sessionID, resolved.agent, resolved.providerID, resolved.modelID, resolved.variant);
  }
  markPendingUserSendAnimation(sessionID);
  await optimisticSend({
    sessionId: sessionID,
    content: text,
    directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    agent: resolved.agent,
    onOptimisticInsert: () => requestChatForceScrollBottom(sessionID),
    send: (messageID) => opencodeClient.sendMessage({
      id: sessionID,
      directory,
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      agent: resolved.agent,
      variant: resolved.variant,
      text,
      additionalParts,
      messageId: messageID,
    }).then(() => undefined),
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
  });
};

const getSessionOrNull = async (sessionID: string, directory: string): Promise<Session | null> => {
  try {
    return await opencodeClient.getSession(sessionID, directory);
  } catch {
    return null;
  }
};

const createOrReuseReviewSession = async (originalSessionID: string, directory: string): Promise<Session> => {
  const original = await opencodeClient.getSession(originalSessionID, directory);
  const existingReviewID = getReviewSessionID(original);
  if (existingReviewID) {
    const existing = await getSessionOrNull(existingReviewID, directory);
    if (existing && isReviewSession(existing)) return existing;
    await patchSessionMetadata(originalSessionID, directory, (metadata) => {
      const next = { ...metadata };
      const openchamber = next.openchamber;
      if (openchamber && typeof openchamber === 'object' && !Array.isArray(openchamber)) {
        const rest = { ...(openchamber as Record<string, unknown>) };
        delete rest.reviewSessionID;
        next.openchamber = rest;
      }
      return next;
    });
  }

  const review = await opencodeClient.createSession({
    title: REVIEW_SESSION_TITLE,
    metadata: withReviewSessionMarker({}, originalSessionID),
  }, directory);
  registerSessionDirectory(review.id, directory);
  try {
    await patchSessionMetadata(originalSessionID, directory, (metadata) => withReviewSessionLink(metadata, review.id));
  } catch (error) {
    await opencodeClient.deleteSession(review.id, directory).catch((deleteError) => {
      console.warn('[review-flow] failed to delete unlinked review session after link failure', deleteError);
    });
    throw error;
  }
  useGlobalSessionsStore.getState().upsertSession(review);
  return review;
};

export const startReviewFlow = async (input: StartReviewFlowInput): Promise<void> => {
  await waitForConnectionOrThrow();
  let reviewPrompt: string;

  if (input.generateHandoff ?? true) {
    const visibleText = await renderMagicPrompt('session.reviewHandoff.visible');
    const instructionsText = await renderMagicPrompt('session.reviewHandoff.instructions');
    const startedAt = Date.now();
    await sendPlainMessage(input.originalSessionID, input.directory, visibleText, null, [
      { text: instructionsText, synthetic: true },
    ]);

    const continueFromHandoff = async (): Promise<void> => {
      const handoff = await waitForAssistantText(input.originalSessionID, input.directory, startedAt);
      const handoffReviewPrompt = await renderMagicPrompt('session.reviewSession.visible', { handoff });
      const reviewSession = await createOrReuseReviewSession(input.originalSessionID, input.directory);
      await sendPlainMessage(reviewSession.id, input.directory, handoffReviewPrompt, {
        providerID: input.providerID,
        modelID: input.modelID,
        agent: input.agent,
        variant: input.variant,
      });
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
  } else {
    reviewPrompt = await renderMagicPrompt('session.reviewSessionWithoutHandoff.visible');
  }

  const reviewSession = await createOrReuseReviewSession(input.originalSessionID, input.directory);
  await sendPlainMessage(reviewSession.id, input.directory, reviewPrompt, {
    providerID: input.providerID,
    modelID: input.modelID,
    agent: input.agent,
    variant: input.variant,
  });
  openReviewSessionPanel(input.directory, reviewSession);
};

export const sendReviewFeedbackToOriginal = async (reviewSessionID: string, directory: string, reviewFeedback: string): Promise<void> => {
  const reviewSession = await opencodeClient.getSession(reviewSessionID, directory);
  const originalSessionID = getOriginalSessionID(reviewSession);
  if (!originalSessionID) throw new Error('Original session is missing');
  const prompt = await renderMagicPrompt('session.reviewFeedbackToImplementer.visible', { review_feedback: reviewFeedback });
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
  const prompt = await renderMagicPrompt('session.implementationResponseToReviewer.visible', { implementation_response: implementationResponse });
  await sendPlainMessage(reviewSessionID, directory, prompt);
  openReviewSessionPanel(directory, reviewSession);
};

export type ReviewTransferDirection = 'review-to-original' | 'original-to-review';

export const getReviewTransferDirection = (session: Session | null | undefined): ReviewTransferDirection | null => {
  if (isReviewSession(session)) return 'review-to-original';
  if (getReviewSessionID(session)) return 'original-to-review';
  return null;
};

export const readSessionReviewMetadata = (session: Session | null | undefined) => getSessionMetadata(session);
