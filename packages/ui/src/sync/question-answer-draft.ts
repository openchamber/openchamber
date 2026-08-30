import React from 'react';

interface QuestionAnswerDraft {
    selectedOptions: Record<number, string[]>;
    customMode: Record<number, boolean>;
    customText: Record<number, string>;
}

const drafts = new Map<string, QuestionAnswerDraft>();
const pendingSubmissions = new Map<string, object>();
const pendingListeners = new Map<string, Set<() => void>>();

export const getQuestionAnswerDraftKey = (runtimeKey: string, sessionId: string, requestId: string): string =>
    JSON.stringify([runtimeKey, 'question', sessionId, requestId]);

const cloneDraft = (draft: QuestionAnswerDraft): QuestionAnswerDraft => ({
    selectedOptions: Object.fromEntries(
        Object.entries(draft.selectedOptions).map(([index, answers]) => [index, [...answers]]),
    ),
    customMode: { ...draft.customMode },
    customText: { ...draft.customText },
});

export const getQuestionAnswerDraft = (key: string): QuestionAnswerDraft | null => {
    const draft = drafts.get(key);
    return draft ? cloneDraft(draft) : null;
};

export const setQuestionAnswerDraft = (key: string, draft: QuestionAnswerDraft): void => {
    drafts.set(key, cloneDraft(draft));
};

export const clearQuestionAnswerDraft = (key: string): void => {
    drafts.delete(key);
    if (pendingSubmissions.delete(key)) notifyPending(key);
};

const notifyPending = (key: string): void => {
    for (const listener of pendingListeners.get(key) ?? []) listener();
};

export const beginQuestionAnswerSubmission = (key: string) => {
    if (pendingSubmissions.has(key)) return null;

    const submission = {};
    pendingSubmissions.set(key, submission);
    notifyPending(key);
    return {
        finish: () => {
            if (pendingSubmissions.get(key) !== submission) return;
            pendingSubmissions.delete(key);
            notifyPending(key);
        },
    };
};

export const useQuestionAnswerPending = (key: string): boolean => React.useSyncExternalStore(
    React.useCallback((listener) => {
        const listeners = pendingListeners.get(key) ?? new Set<() => void>();
        listeners.add(listener);
        pendingListeners.set(key, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) pendingListeners.delete(key);
        };
    }, [key]),
    () => pendingSubmissions.has(key),
    () => false,
);

export const resetQuestionAnswerDraftsForTests = (): void => {
    drafts.clear();
    const keys = [...pendingSubmissions.keys()];
    pendingSubmissions.clear();
    for (const key of keys) notifyPending(key);
};
