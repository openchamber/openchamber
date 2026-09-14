import React from 'react';

import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';

type ComposerSubmission = {
    identity: ChatDraftIdentity | null;
    text: string;
    confirmedMentions: Set<string>;
};

const submissions = new Set<ComposerSubmission>();
const listeners = new Set<() => void>();
let version = 0;

const notify = (): void => {
    version += 1;
    for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

const getVersion = (): number => version;

const sameIdentity = (left: ChatDraftIdentity | null, right: ChatDraftIdentity | null): boolean => (
    left === right || Boolean(left && right && getChatDraftIdentityKey(left) === getChatDraftIdentityKey(right))
);

const getPendingSubmission = (identity: ChatDraftIdentity | null): ComposerSubmission | null => {
    for (const submission of submissions) {
        if (sameIdentity(submission.identity, identity)) return submission;
    }
    return null;
};

export function useComposerSubmission(identity: ChatDraftIdentity | null) {
    React.useSyncExternalStore(subscribe, getVersion, getVersion);

    const begin = React.useCallback((text = '', confirmedMentions: ReadonlySet<string> = new Set()) => {
        if (getPendingSubmission(identity)) return null;

        const submission = { identity, text, confirmedMentions: new Set(confirmedMentions) };
        submissions.add(submission);
        notify();
        const finish = () => {
            if (submissions.delete(submission)) notify();
        };
        return {
            finish,
            transfer: (nextIdentity: ChatDraftIdentity) => {
                submission.identity = nextIdentity;
                notify();
            },
            finishAfterPaint: () => {
                submission.text = '';
                submission.confirmedMentions.clear();
                notify();
                const scheduleFrame = globalThis.requestAnimationFrame;
                if (!scheduleFrame) {
                    finish();
                    return;
                }

                const fallback = setTimeout(finish, 1000);
                scheduleFrame(() => {
                    scheduleFrame(() => {
                        clearTimeout(fallback);
                        finish();
                    });
                });
            },
        };
    }, [identity]);

    const pendingSubmission = getPendingSubmission(identity);

    return {
        isPending: pendingSubmission !== null,
        pendingText: pendingSubmission?.text ?? null,
        pendingConfirmedMentions: pendingSubmission?.confirmedMentions ?? null,
        begin,
    };
}
