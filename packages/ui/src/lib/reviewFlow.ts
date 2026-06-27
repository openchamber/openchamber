import type { Message, Session } from '@opencode-ai/sdk/v2/client';
import { opencodeClient } from '@/lib/opencode/client';
import { renderMagicPrompt } from '@/lib/magicPrompts';
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
import { useAutoReviewStore, type AutoReviewRun } from '@/stores/useAutoReviewStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { optimisticSend, patchSessionMetadata, waitForConnectionOrThrow } from '@/sync/session-actions';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages, getSyncParts, getSyncSessionStatus, registerSessionDirectory } from '@/sync/sync-refs';
import { markPendingUserSendAnimation } from '@/lib/userSendAnimation';
import { getRuntimeKey } from '@/lib/runtime-switch';

const HANDOFF_TIMEOUT_MS = 180_000;
const HANDOFF_POLL_MS = 400;
const AUTO_REVIEW_POLL_MS = 300;
const AUTO_REVIEW_MAX_ITERATIONS = 15;
const AUTO_REVIEW_FINAL_MARKER = 'FINAL_REVIEW_STATUS: no_remaining_findings';
const AUTO_REVIEW_FINAL_MARKER_NORMALIZED = AUTO_REVIEW_FINAL_MARKER.toLowerCase();
const REVIEW_SESSION_TITLE = 'Review of workspace changes';
const activeAutoReviewLoops = new Set<string>();
const activeAutoReviewForwardKeys = new Set<string>();

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

type AssistantTextMessage = {
  id: string;
  text: string;
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

const getMessageParentID = (message: Message): string | null => {
  const parentID = (message as { parentID?: unknown }).parentID;
  return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : null;
};

const isCompactionCommandMessage = (message: Message, directory: string): boolean => {
  const parts = getSyncParts(message.id, directory);
  return parts.some((part) => {
    const type = (part as { type?: unknown }).type;
    if (type === 'compaction') return true;
    if (type !== 'text') return false;
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' && text.trim() === '/compact';
  });
};

const getLatestAssistantTextMessage = (
  sessionID: string,
  directory: string,
  lastForwardedMessageID?: string,
  afterCreatedAt = 0,
  expectedParentID?: string,
): AssistantTextMessage | null => {
  const messages = getSyncMessages(sessionID, directory);
  const compactionCommandIDs = new Set<string>();
  for (const message of messages) {
    if (isCompactionCommandMessage(message, directory)) {
      compactionCommandIDs.add(message.id);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.id === lastForwardedMessageID) return null;
    if (getMessageRole(message) !== 'assistant') continue;
    if (!isMessageCompleted(message)) continue;
    if (getMessageCreatedAt(message) < afterCreatedAt - 1000) continue;
    const parentID = getMessageParentID(message);
    if (!isExpectedAutoReviewAssistantParent(message, expectedParentID)) continue;
    if (parentID && compactionCommandIDs.has(parentID)) continue;
    const text = flattenAssistantTextParts(getSyncParts(message.id, directory)).trim();
    if (!text) continue;
    return { id: message.id, text };
  }

  return null;
};

const isSessionIdle = (sessionID: string, directory: string): boolean => {
  const status = getSyncSessionStatus(sessionID, directory);
  return status?.type === 'idle';
};

export const isAutoReviewRuntimeCurrent = (runtimeKey: string): boolean => runtimeKey === getRuntimeKey();

const stopRunForRuntimeMismatch = (run: AutoReviewRun): void => {
  useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
    ...current,
    status: 'stopped',
    error: 'Auto-review stopped because the runtime changed.',
  }));
};

export const assertAutoReviewRuntimeStillCurrent = (expectedRuntimeKey?: string): void => {
  if (expectedRuntimeKey && !isAutoReviewRuntimeCurrent(expectedRuntimeKey)) {
    throw new Error('Auto-review stopped because the runtime changed.');
  }
};

const isRuntimeChangeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('runtime changed');
};

export const hasFinalReviewMarker = (text: string): boolean => {
  const lines = text.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1)?.toLowerCase() === AUTO_REVIEW_FINAL_MARKER_NORMALIZED;
};

export const stripFinalReviewMarker = (text: string): string => {
  const lines = text.trimEnd().split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.at(-1)?.trim().toLowerCase() === AUTO_REVIEW_FINAL_MARKER_NORMALIZED) {
    lines.pop();
  }
  return lines.join('\n').trim();
};

export const isExpectedAutoReviewAssistantParent = (message: Message, expectedParentID?: string): boolean => {
  if (!expectedParentID) return true;
  return getMessageParentID(message) === expectedParentID;
};

const getAutoReviewForwardKey = (run: AutoReviewRun, messageID: string): string => [
  run.runtimeKey,
  run.originalSessionID,
  run.phase,
  run.expectedAssistantParentID ?? '',
  messageID,
].join(':');

export const claimAutoReviewForward = (run: AutoReviewRun, messageID: string): string | null => {
  const key = getAutoReviewForwardKey(run, messageID);
  if (activeAutoReviewForwardKeys.has(key)) return null;
  activeAutoReviewForwardKeys.add(key);
  return key;
};

export const releaseAutoReviewForward = (key: string): void => {
  activeAutoReviewForwardKeys.delete(key);
};

const autoReviewReviewerInstructions = (): Array<{ text: string; synthetic: true }> => [{
  synthetic: true,
  text: `This review is part of an automatic review loop. If there are no remaining issues, end your response with this exact final line:\n${AUTO_REVIEW_FINAL_MARKER}\nIf you found issues that require changes, do not include that final status line.`,
}];

const runAutoReviewLoop = async (originalSessionID: string): Promise<void> => {
  while (true) {
    const run = useAutoReviewStore.getState().runsByOriginalSessionID[originalSessionID];
    if (!run || run.status !== 'running') return;
    if (!isAutoReviewRuntimeCurrent(run.runtimeKey)) {
      stopRunForRuntimeMismatch(run);
      return;
    }

    const sourceSessionID = run.phase === 'waiting_for_reviewer' ? run.reviewSessionID : run.originalSessionID;
    if (!isSessionIdle(sourceSessionID, run.directory)) {
      await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
      continue;
    }

    const latest = getLatestAssistantTextMessage(
      sourceSessionID,
      run.directory,
      run.lastForwardedMessageID,
      run.waitAfterCreatedAt,
      run.expectedAssistantParentID,
    );
    if (!latest) {
      await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
      continue;
    }

    if (run.phase === 'waiting_for_reviewer') {
      const forwardKey = claimAutoReviewForward(run, latest.id);
      if (!forwardKey) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
        continue;
      }
      if (!isAutoReviewRuntimeCurrent(run.runtimeKey)) {
        releaseAutoReviewForward(forwardKey);
        stopRunForRuntimeMismatch(run);
        return;
      }
      try {
        const waitAfterCreatedAt = Date.now();
        const isFinalReview = hasFinalReviewMarker(latest.text);
        const reviewFeedback = isFinalReview ? stripFinalReviewMarker(latest.text) : latest.text;
        const sentMessageID = await sendReviewFeedbackToOriginal(run.reviewSessionID, run.directory, reviewFeedback, run.runtimeKey);
        if (isFinalReview) {
          useAutoReviewStore.getState().completeRun(run.originalSessionID);
          return;
        }
        useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
          ...current,
          phase: 'waiting_for_implementer',
          lastForwardedMessageID: latest.id,
          expectedAssistantParentID: sentMessageID,
          waitAfterCreatedAt,
        }));
      } finally {
        releaseAutoReviewForward(forwardKey);
      }
    } else {
      if (run.iteration >= run.maxIterations) {
        useAutoReviewStore.getState().stopRun(run.originalSessionID);
        return;
      }
      const forwardKey = claimAutoReviewForward(run, latest.id);
      if (!forwardKey) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_REVIEW_POLL_MS));
        continue;
      }
      if (!isAutoReviewRuntimeCurrent(run.runtimeKey)) {
        releaseAutoReviewForward(forwardKey);
        stopRunForRuntimeMismatch(run);
        return;
      }
      try {
        const waitAfterCreatedAt = Date.now();
        const sentMessageID = await sendImplementationResponseToReviewer(run.originalSessionID, run.directory, latest.text, true, run.runtimeKey);
        useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
          ...current,
          phase: 'waiting_for_reviewer',
          iteration: current.iteration + 1,
          lastForwardedMessageID: latest.id,
          expectedAssistantParentID: sentMessageID,
          waitAfterCreatedAt,
        }));
      } finally {
        releaseAutoReviewForward(forwardKey);
      }
    }
  }
};

const startAutoReviewRun = (run: AutoReviewRun): void => {
  useAutoReviewStore.getState().upsertRun(run);
  resumeAutoReviewRun(run.originalSessionID);
};

export const resumeAutoReviewRun = (originalSessionID: string): void => {
  const run = useAutoReviewStore.getState().runsByOriginalSessionID[originalSessionID];
  if (!run || run.status !== 'running' || !isAutoReviewRuntimeCurrent(run.runtimeKey) || activeAutoReviewLoops.has(originalSessionID)) return;
  activeAutoReviewLoops.add(originalSessionID);
  void runAutoReviewLoop(run.originalSessionID).catch((error) => {
    console.error('[review-flow] auto-review loop failed', error);
    useAutoReviewStore.getState().updateRun(run.originalSessionID, (current) => ({
      ...current,
      status: isRuntimeChangeError(error) ? 'stopped' : 'error',
      error: error instanceof Error ? error.message : String(error),
    }));
  }).finally(() => {
    activeAutoReviewLoops.delete(originalSessionID);
  });
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
  expectedRuntimeKey?: string,
): Promise<string> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
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
  let sentMessageID: string | null = null;
  await optimisticSend({
    sessionId: sessionID,
    content: text,
    directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    agent: resolved.agent,
    onMessageID: (messageID) => {
      sentMessageID = messageID;
    },
    beforeOptimisticInsert: () => assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey),
    onOptimisticInsert: () => requestChatForceScrollBottom(sessionID),
    send: (messageID) => {
      assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
      return opencodeClient.sendMessage({
        id: sessionID,
        directory,
        providerID: resolved.providerID,
        modelID: resolved.modelID,
        agent: resolved.agent,
        variant: resolved.variant,
        text,
        additionalParts,
        messageId: messageID,
      }).then(() => undefined);
    },
  });
  if (!sentMessageID) throw new Error('Failed to prepare review flow message');
  return sentMessageID;
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

const createOrReuseReviewSession = async (originalSessionID: string, directory: string, expectedRuntimeKey?: string): Promise<Session> => {
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
        const rest = { ...(openchamber as Record<string, unknown>) };
        delete rest.reviewSessionID;
        next.openchamber = rest;
      }
      return next;
    });
  }

  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const review = await opencodeClient.createSession({
    title: REVIEW_SESSION_TITLE,
    metadata: withReviewSessionMarker({}, originalSessionID),
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
  return review;
};

export const startReviewFlow = async (input: StartReviewFlowInput): Promise<void> => {
  await waitForConnectionOrThrow();
  const expectedAutoReviewRuntimeKey = input.autoReview ? getRuntimeKey() : undefined;
  let reviewPrompt: string;

  if (input.generateHandoff ?? true) {
    const visibleText = await renderMagicPrompt('session.reviewHandoff.visible');
    const instructionsText = await renderMagicPrompt('session.reviewHandoff.instructions');
    const startedAt = Date.now();
    await sendPlainMessage(input.originalSessionID, input.directory, visibleText, null, [
      { text: instructionsText, synthetic: true },
    ], expectedAutoReviewRuntimeKey);

    const continueFromHandoff = async (): Promise<void> => {
      const handoff = await waitForAssistantText(input.originalSessionID, input.directory, startedAt);
      assertAutoReviewRuntimeStillCurrent(expectedAutoReviewRuntimeKey);
      const handoffReviewPrompt = await renderMagicPrompt('session.reviewSession.visible', { handoff });
      const reviewSession = await createOrReuseReviewSession(input.originalSessionID, input.directory, expectedAutoReviewRuntimeKey);
      const runtimeKey = expectedAutoReviewRuntimeKey ?? getRuntimeKey();
      const waitAfterCreatedAt = Date.now();
      const sentMessageID = await sendPlainMessage(reviewSession.id, input.directory, handoffReviewPrompt, {
        providerID: input.providerID,
        modelID: input.modelID,
        agent: input.agent,
        variant: input.variant,
      }, input.autoReview ? autoReviewReviewerInstructions() : undefined, input.autoReview ? runtimeKey : undefined);
      if (input.autoReview) {
        startAutoReviewRun({
          originalSessionID: input.originalSessionID,
          reviewSessionID: reviewSession.id,
          directory: input.directory,
          runtimeKey,
          status: 'running',
          phase: 'waiting_for_reviewer',
          iteration: 0,
          maxIterations: AUTO_REVIEW_MAX_ITERATIONS,
          expectedAssistantParentID: sentMessageID,
          waitAfterCreatedAt,
        });
      }
      if (!input.autoReview) {
        openReviewSessionPanel(input.directory, reviewSession);
      }
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

  const reviewSession = await createOrReuseReviewSession(input.originalSessionID, input.directory, expectedAutoReviewRuntimeKey);
  const runtimeKey = expectedAutoReviewRuntimeKey ?? getRuntimeKey();
  const waitAfterCreatedAt = Date.now();
  const sentMessageID = await sendPlainMessage(reviewSession.id, input.directory, reviewPrompt, {
    providerID: input.providerID,
    modelID: input.modelID,
    agent: input.agent,
    variant: input.variant,
  }, input.autoReview ? autoReviewReviewerInstructions() : undefined, input.autoReview ? runtimeKey : undefined);
  if (input.autoReview) {
    startAutoReviewRun({
      originalSessionID: input.originalSessionID,
      reviewSessionID: reviewSession.id,
      directory: input.directory,
      runtimeKey,
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 0,
      maxIterations: AUTO_REVIEW_MAX_ITERATIONS,
      expectedAssistantParentID: sentMessageID,
      waitAfterCreatedAt,
    });
  }
  if (!input.autoReview) {
    openReviewSessionPanel(input.directory, reviewSession);
  }
};

export const sendReviewFeedbackToOriginal = async (reviewSessionID: string, directory: string, reviewFeedback: string, expectedRuntimeKey?: string): Promise<string> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const reviewSession = await opencodeClient.getSession(reviewSessionID, directory);
  const originalSessionID = getOriginalSessionID(reviewSession);
  if (!originalSessionID) throw new Error('Original session is missing');
  const prompt = await renderMagicPrompt('session.reviewFeedbackToImplementer.visible', { review_feedback: reviewFeedback });
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  return sendPlainMessage(originalSessionID, directory, prompt, undefined, undefined, expectedRuntimeKey);
};

export const sendImplementationResponseToReviewer = async (originalSessionID: string, directory: string, implementationResponse: string, autoReview = false, expectedRuntimeKey?: string): Promise<string> => {
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const originalSession = await opencodeClient.getSession(originalSessionID, directory);
  const reviewSessionID = getReviewSessionID(originalSession);
  if (!reviewSessionID) throw new Error('Review session is missing');
  let reviewSession: Session;
  try {
    reviewSession = await opencodeClient.getSession(reviewSessionID, directory);
  } catch (error) {
    assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
    await patchSessionMetadata(originalSessionID, directory, (metadata) => withoutReviewSessionLink(metadata, reviewSessionID));
    throw error;
  }
  const prompt = await renderMagicPrompt('session.implementationResponseToReviewer.visible', { implementation_response: implementationResponse });
  assertAutoReviewRuntimeStillCurrent(expectedRuntimeKey);
  const sentMessageID = await sendPlainMessage(reviewSessionID, directory, prompt, undefined, autoReview ? autoReviewReviewerInstructions() : undefined, expectedRuntimeKey);
  if (!autoReview) {
    openReviewSessionPanel(directory, reviewSession);
  }
  return sentMessageID;
};

export type ReviewTransferDirection = 'review-to-original' | 'original-to-review';

export const getReviewTransferDirection = (session: Session | null | undefined): ReviewTransferDirection | null => {
  if (isReviewSession(session)) return 'review-to-original';
  if (getReviewSessionID(session)) return 'original-to-review';
  return null;
};
