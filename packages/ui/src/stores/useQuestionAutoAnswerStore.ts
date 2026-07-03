import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { QuestionRequest } from "@/types/question";
import { getSafeStorage } from "./utils/safeStorage";
import { respondToQuestion } from "@/sync/session-actions";

export const MIN_QUESTION_AUTO_ANSWER_DELAY = 3;
export const MAX_QUESTION_AUTO_ANSWER_DELAY = 3600;
export const DEFAULT_QUESTION_AUTO_ANSWER_DELAY = 30;

export const clampQuestionAutoAnswerDelay = (value: number): number => {
    if (!Number.isFinite(value)) {
        return DEFAULT_QUESTION_AUTO_ANSWER_DELAY;
    }
    const rounded = Math.round(value);
    if (rounded < MIN_QUESTION_AUTO_ANSWER_DELAY) return MIN_QUESTION_AUTO_ANSWER_DELAY;
    if (rounded > MAX_QUESTION_AUTO_ANSWER_DELAY) return MAX_QUESTION_AUTO_ANSWER_DELAY;
    return rounded;
};

// Runtime-only timer bookkeeping. Cancelled ids are remembered so a question
// dismissed by user interaction is never rescheduled on card remount.
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const cancelledRequestIds = new Set<string>();

const buildFirstOptionAnswers = (question: QuestionRequest): string[][] | null => {
    const questions = question.questions ?? [];
    if (questions.length === 0) {
        return null;
    }
    const answers: string[][] = [];
    for (const info of questions) {
        const first = info.options?.[0]?.label;
        if (typeof first !== "string" || first.length === 0) {
            return null;
        }
        answers.push([first]);
    }
    return answers;
};

interface QuestionAutoAnswerState {
    enabled: boolean;
    delaySeconds: number;
    /** requestId -> epoch ms when the auto-answer fires */
    deadlines: Record<string, number>;
}

interface QuestionAutoAnswerActions {
    setEnabled: (enabled: boolean) => void;
    setDelaySeconds: (seconds: number) => void;
    schedule: (question: QuestionRequest) => void;
    /** User interacted with the question — stop the countdown for good. */
    cancel: (requestId: string) => void;
    /** Question was answered or rejected elsewhere — drop bookkeeping. */
    clear: (requestId: string) => void;
}

type QuestionAutoAnswerStore = QuestionAutoAnswerState & QuestionAutoAnswerActions;

const getStorage = () => createJSONStorage(() => getSafeStorage());

export const useQuestionAutoAnswerStore = create<QuestionAutoAnswerStore>()(
    devtools(
        persist(
            (set, get) => {
                const clearTimer = (requestId: string) => {
                    const timer = timers.get(requestId);
                    if (timer) {
                        clearTimeout(timer);
                        timers.delete(requestId);
                    }
                };

                const removeDeadline = (requestId: string) => {
                    set((state) => {
                        if (!(requestId in state.deadlines)) {
                            return state;
                        }
                        const deadlines = { ...state.deadlines };
                        delete deadlines[requestId];
                        return { deadlines };
                    });
                };

                return {
                    enabled: false,
                    delaySeconds: DEFAULT_QUESTION_AUTO_ANSWER_DELAY,
                    deadlines: {},

                    setEnabled: (enabled: boolean) => {
                        if (!enabled) {
                            for (const timer of timers.values()) {
                                clearTimeout(timer);
                            }
                            timers.clear();
                            set({ enabled: false, deadlines: {} });
                            return;
                        }
                        set({ enabled: true });
                    },

                    setDelaySeconds: (seconds: number) => {
                        set({ delaySeconds: clampQuestionAutoAnswerDelay(seconds) });
                    },

                    schedule: (question: QuestionRequest) => {
                        const state = get();
                        const requestId = question.id;
                        if (!state.enabled || !requestId) return;
                        if (timers.has(requestId) || cancelledRequestIds.has(requestId)) return;

                        const answers = buildFirstOptionAnswers(question);
                        if (!answers) return;

                        const delayMs = clampQuestionAutoAnswerDelay(state.delaySeconds) * 1000;
                        const sessionID = question.sessionID;

                        timers.set(requestId, setTimeout(() => {
                            timers.delete(requestId);
                            removeDeadline(requestId);
                            void respondToQuestion(sessionID, requestId, answers).catch(() => {
                                // Question may already be resolved; nothing to do.
                            });
                        }, delayMs));

                        set((current) => ({
                            deadlines: { ...current.deadlines, [requestId]: Date.now() + delayMs },
                        }));
                    },

                    cancel: (requestId: string) => {
                        if (!requestId) return;
                        cancelledRequestIds.add(requestId);
                        clearTimer(requestId);
                        removeDeadline(requestId);
                    },

                    clear: (requestId: string) => {
                        if (!requestId) return;
                        cancelledRequestIds.delete(requestId);
                        clearTimer(requestId);
                        removeDeadline(requestId);
                    },
                };
            },
            {
                name: "question-auto-answer-store",
                storage: getStorage(),
                partialize: (state) => ({
                    enabled: state.enabled,
                    delaySeconds: state.delaySeconds,
                }),
            }
        ),
        { name: "question-auto-answer-store" }
    )
);
