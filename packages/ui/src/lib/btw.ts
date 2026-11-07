import { OpencodeApiError, opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useBtwStore, type BtwFailureReason } from '@/stores/useBtwStore';

/**
 * The framing native `/btw` sends with every side question. `session.generate`
 * exposes the session's tools but runs no tool loop, so a tool call would
 * surface as an empty answer.
 */
export const BTW_INSTRUCTION = [
  'The user is asking a quick side question about the conversation so far.',
  'Answer directly and concisely in markdown from what you already know.',
  'Do not call any tools and do not take any actions.',
].join(' ');

const BTW_GENERATE_TIMEOUT_MS = 300_000;

/**
 * Sent with every message in a session promoted out of the old forked `/btw`.
 * Those transcripts still carry the old boundary instructions, and message
 * parts cannot be removed, so a promoted session has to be told they no
 * longer apply.
 */
export const BTW_PROMOTION_NOTICE = [
  'This session started as a btw side conversation and has since been promoted to a normal session.',
  'The btw constraints in the history above no longer apply: this is now the main thread, and the',
  'usual tool, sub-agent and workspace permissions are in force.',
].join(' ');

export const buildBtwSyntheticTexts = (state: { isPromotedBtwSession: boolean }): string[] =>
  state.isPromotedBtwSession ? [BTW_PROMOTION_NOTICE] : [];

export const buildBtwPrompt = (question: string): string =>
  [BTW_INSTRUCTION, question.trim()].join('\n\n');

const activeRequests = new Map<string, AbortController>();

const newRequestId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `btw-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isCurrent = (requestId: string, controller: AbortController): boolean =>
  activeRequests.get(requestId) === controller;

type BtwFailure = {
  reason: BtwFailureReason;
  message?: string;
};

const failureForError = (error: Error): BtwFailure => {
  if (error instanceof OpencodeApiError) {
    if (error.status === 404) {
      return error.tag === 'SessionNotFoundError'
        ? { reason: 'session-missing', message: error.detail }
        : { reason: 'unsupported', message: error.detail };
    }
    return { reason: 'error', message: error.detail || error.message };
  }
  return { reason: 'error', message: error.message };
};

export type BtwQuestionInput = {
  parentSessionId: string;
  ownerKey: string;
  directory: string | null;
  question: string;
  runtimeKey?: string;
};

/**
 * Asks one transient side question from the parent session's settled context.
 *
 * No session, message, draft or metadata is written. The request owns its
 * AbortController, so dismissing it never touches the main agent's turn.
 */
export async function runBtwQuestion(input: BtwQuestionInput): Promise<void> {
  const question = input.question.trim();
  if (!question) return;

  const runtimeKey = input.runtimeKey ?? getRuntimeKey();
  if (getRuntimeKey() !== runtimeKey) return;
  const requestId = newRequestId();
  const controller = new AbortController();
  const store = useBtwStore.getState();
  if (!store.begin(input.parentSessionId, requestId, input.ownerKey, question, input.directory, runtimeKey)) return;

  activeRequests.set(requestId, controller);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BTW_GENERATE_TIMEOUT_MS);

  try {
    const answer = await opencodeClient.generateSessionText(
      input.parentSessionId,
      buildBtwPrompt(question),
      { directory: input.directory, signal: controller.signal },
    );
    if (!isCurrent(requestId, controller) || controller.signal.aborted) return;
    if (getRuntimeKey() !== runtimeKey) {
      useBtwStore.getState().clear(input.parentSessionId);
      return;
    }

    const text = answer.trim();
    if (!text) {
      useBtwStore.getState().fail(input.parentSessionId, requestId, 'empty');
      return;
    }
    useBtwStore.getState().succeed(input.parentSessionId, requestId, text, Date.now());
  } catch (error) {
    if (!isCurrent(requestId, controller)) return;
    if (controller.signal.aborted) {
      if (timedOut) useBtwStore.getState().fail(input.parentSessionId, requestId, 'timeout');
      return;
    }
    if (getRuntimeKey() !== runtimeKey) {
      useBtwStore.getState().clear(input.parentSessionId);
      return;
    }
    const failure = error instanceof Error
      ? failureForError(error)
      : failureForError(new Error(String(error)));
    useBtwStore.getState().fail(input.parentSessionId, requestId, failure.reason, failure.message);
  } finally {
    clearTimeout(timeout);
    if (isCurrent(requestId, controller)) activeRequests.delete(requestId);
  }
}

/** Opens the `/btw` question field without starting a model call. */
export function openBtwComposer(
  parentSessionId: string,
  ownerKey: string,
  directory: string | null,
  initialQuestion?: string,
): boolean {
  return useBtwStore.getState().openComposer(parentSessionId, ownerKey, directory, initialQuestion);
}

/** Aborts one side question and forgets its state. Nothing else is touched. */
export function dismissBtw(parentSessionId: string): void {
  const request = useBtwStore.getState().byParent[parentSessionId];
  if (request?.status === 'running') {
    const active = activeRequests.get(request.id);
    if (active) {
      activeRequests.delete(request.id);
      active.abort();
    }
  }
  useBtwStore.getState().dismiss(parentSessionId);
}

/** Runtime switches abandon requests that belong to the old endpoint. */
export function disposeBtwRequests(): void {
  for (const request of activeRequests.values()) request.abort();
  activeRequests.clear();
  useBtwStore.setState({ byParent: {} });
}

subscribeRuntimeEndpointWillChange(() => disposeBtwRequests());
