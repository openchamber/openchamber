/**
 * Closes an agent's question without an answer so the agent goes on, in two
 * ways: once it has waited longer than the Settings timeout
 * (`questionTimeoutMinutes`), and at once when the user chooses Answer later
 * in the question dock, or has questions set to run in the background
 * (`questionsInBackground`).
 *
 * Each close cancels the form with a message for the agent
 * (`cancelForm(…, message)`): OpenCode hands the message to the agent as the
 * question's result and the turn goes on, where a plain Dismiss ends the
 * turn. The agent never gets an answer it did not get from the user. The
 * `question` call is remembered with why it closed, so its transcript row
 * shows a timed-out question greyed out, an answer-later one as waiting for
 * the user, and both offer a late answer.
 *
 * A form carries no creation time, so the timeout clock starts when this
 * client first sees the form; that time is kept on the device so a reload does
 * not restart it. Runs in every window that mounts it; the first cancel wins
 * and the others find the form gone. A question asked while no OpenChamber
 * window is open starts its clock when one opens.
 */
import React from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { questionCallKey, questionFormCall } from '@/lib/opencode/question';
import { questionDeadline } from '@/lib/questionTimeout';
import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';
import { useUIStore } from '@/stores/useUIStore';
import { useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { cancelForm, listPendingForms } from './session-actions';

/** A form waiting for an answer; `call` is its `question` call's key when it has one. */
export type PendingQuestionForm = { id: string; sessionId: string; call?: string };

/** Why OpenChamber closed a question the user had not answered. */
export type QuestionCloseReason = 'timeout' | 'later';

type ClosedQuestion = { reason: QuestionCloseReason; at: number };

type QuestionTimeoutState = {
  /** Form id → when this device first saw it. */
  seenAt: Record<string, number>;
  /** `questionCallKey` → why and when its question was closed. */
  closed: Record<string, ClosedQuestion>;
};

/** Enough for every question a busy day asks; the oldest go first. */
const MAX_ENTRIES = 200;
const TICK_MS = 5_000;

const newest = <T>(entries: Record<string, T>, at: (entry: T) => number): Record<string, T> => {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return entries;
  return Object.fromEntries(Object.entries(entries).sort((a, b) => at(b[1]) - at(a[1])).slice(0, MAX_ENTRIES));
};

export const useQuestionTimeoutStore = create<QuestionTimeoutState>()(
  persist(
    () => ({ seenAt: {}, closed: {} }),
    {
      name: 'question-timeouts',
      storage: createDeferredSafeJSONStorage(),
      version: 1,
    },
  ),
);

/** Why the `question` call with this key was closed unanswered, or null. */
export const useQuestionCloseReason = (callKey: string | null): QuestionCloseReason | null => (
  useQuestionTimeoutStore((state) => (callKey ? state.closed[callKey]?.reason ?? null : null))
);

/** When the form times out, or null when it does not (no timeout set, or not seen yet). */
export const useQuestionDeadline = (formId: string): number | null => {
  const seenAt = useQuestionTimeoutStore((state) => state.seenAt[formId]);
  const minutes = useUIStore((state) => state.questionTimeoutMinutes);
  return seenAt === undefined ? null : questionDeadline(seenAt, minutes);
};

/**
 * Cancels the form with `message` for the agent and records why. The mark is
 * set before the cancel so the row changes as the dock closes, and removed
 * when the cancel fails: then the form was answered elsewhere, or it still
 * waits and can be closed again.
 */
export const closeQuestionUnanswered = async (
  form: PendingQuestionForm,
  reason: QuestionCloseReason,
  message: string,
  cancel: (sessionId: string, formId: string, message: string) => Promise<void> = cancelForm,
  now: number = Date.now(),
): Promise<boolean> => {
  const store = useQuestionTimeoutStore;
  const call = form.call;
  if (call) store.setState((state) => ({ closed: newest({ ...state.closed, [call]: { reason, at: now } }, (entry) => entry.at) }));
  try {
    await cancel(form.sessionId, form.id, message);
    return true;
  } catch {
    if (call) {
      store.setState((state) => {
        const rest = { ...state.closed };
        delete rest[call];
        return { closed: rest };
      });
    }
    return false;
  }
};

type QuestionTimeoutDeps = {
  now: () => number;
  timeoutMinutes: () => number;
  /** Close every question as soon as it is seen, so the agent never waits. */
  inBackground: () => boolean;
  /** What the agent reads when a question closes for each reason. */
  message: (reason: QuestionCloseReason, minutes: number) => string;
  pendingForms: () => PendingQuestionForm[];
  cancel: (sessionId: string, formId: string, message: string) => Promise<void>;
  onClosed?: (form: PendingQuestionForm, reason: QuestionCloseReason) => void;
};

/**
 * One pass over the pending forms: note the ones seen for the first time and
 * close the ones past their deadline, or every one while questions run in the
 * background. Returns a function to run on every tick; a close still in flight
 * is not started again.
 */
export const createQuestionTimeoutRunner = (deps: QuestionTimeoutDeps) => {
  const inFlight = new Set<string>();

  return async (): Promise<void> => {
    const now = deps.now();
    const forms = deps.pendingForms();
    const store = useQuestionTimeoutStore;

    const unseen = forms.filter((form) => store.getState().seenAt[form.id] === undefined);
    if (unseen.length > 0) {
      store.setState((state) => ({
        seenAt: newest({ ...state.seenAt, ...Object.fromEntries(unseen.map((form) => [form.id, now])) }, (at) => at),
      }));
    }

    const minutes = deps.timeoutMinutes();
    const background = deps.inBackground();
    const due = forms.flatMap((form): Array<{ form: PendingQuestionForm; reason: QuestionCloseReason }> => {
      if (inFlight.has(form.id)) return [];
      // Only an agent's question can be answered later from its row; other
      // forms (an MCP server's request) keep waiting in the background mode.
      if (background && form.call) return [{ form, reason: 'later' }];
      const deadline = questionDeadline(store.getState().seenAt[form.id] ?? now, minutes);
      return deadline !== null && now >= deadline ? [{ form, reason: 'timeout' }] : [];
    });

    await Promise.all(due.map(async ({ form, reason }) => {
      inFlight.add(form.id);
      try {
        if (await closeQuestionUnanswered(form, reason, deps.message(reason, minutes), deps.cancel, now)) {
          deps.onClosed?.(form, reason);
        }
      } finally {
        inFlight.delete(form.id);
      }
    }));
  };
};

/**
 * The forms waiting now: those in open directories, which carry their full
 * metadata, and those the cross-directory index knows for directories never
 * opened here.
 */
const currentPendingForms = (): PendingQuestionForm[] => {
  const byId = new Map<string, PendingQuestionForm>();
  for (const { sessionId, form } of listPendingForms()) {
    const call = questionFormCall(form);
    byId.set(form.id, call ? { id: form.id, sessionId, call: questionCallKey(call) } : { id: form.id, sessionId });
  }
  for (const entry of useGlobalBlockingRequestsStore.getState().bySession.values()) {
    for (const form of entry.forms) {
      if (byId.has(form.id)) continue;
      byId.set(form.id, form.call ? { id: form.id, sessionId: form.sessionID, call: form.call } : { id: form.id, sessionId: form.sessionID });
    }
  }
  return [...byId.values()];
};

/** Mounted once per window, beside the other background work. */
export const useQuestionTimeouts = ({ enabled, message, onClosed }: {
  enabled: boolean;
  message: (reason: QuestionCloseReason, minutes: number) => string;
  onClosed?: (form: PendingQuestionForm, reason: QuestionCloseReason) => void;
}): void => {
  const messageRef = React.useRef(message);
  messageRef.current = message;
  const onClosedRef = React.useRef(onClosed);
  onClosedRef.current = onClosed;

  React.useEffect(() => {
    if (!enabled) return;
    const tick = createQuestionTimeoutRunner({
      now: Date.now,
      timeoutMinutes: () => useUIStore.getState().questionTimeoutMinutes,
      inBackground: () => useUIStore.getState().questionsInBackground,
      message: (reason, minutes) => messageRef.current(reason, minutes),
      pendingForms: currentPendingForms,
      cancel: cancelForm,
      onClosed: (form, reason) => onClosedRef.current?.(form, reason),
    });
    void tick();
    const interval = setInterval(() => void tick(), TICK_MS);
    // A new form gets its first-seen time, or closes in the background mode, at once.
    const unsubscribe = useGlobalBlockingRequestsStore.subscribe(() => void tick());
    const unsubscribeSettings = useUIStore.subscribe((state, previous) => {
      if (state.questionsInBackground !== previous.questionsInBackground || state.questionTimeoutMinutes !== previous.questionTimeoutMinutes) void tick();
    });
    return () => {
      clearInterval(interval);
      unsubscribe();
      unsubscribeSettings();
    };
  }, [enabled]);
};
