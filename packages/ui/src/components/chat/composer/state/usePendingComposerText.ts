/**
 * Takes the text other parts of the app leave for a composer through
 * `input-store.pendingInputText` (git conflict prompts, plugins, file
 * selections, reverts) and puts it into this composer.
 *
 * The main chat's composer lives in a column that shows the deferred
 * selection (see chatColumnSession.ts): right after a switch it still shows
 * the outgoing session for a render. Text left at that moment belongs to the
 * session the user is going to, so the composer waits until its column
 * shows the live selection. Taking it earlier would save it into the
 * outgoing session's draft and leave the incoming one empty.
 */

import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useChatColumnActions, useChatColumnSession } from '../../chatColumnSession';
import { appendInlineText, appendWithLineBreaks } from '../text';

export interface PendingComposerTextOptions {
    /** Off while the composer is talking to a `/btw` fork. */
    enabled: boolean;
    /** Who this composer takes text for; see input-store `pendingInputTarget`. */
    target: string | null;
    setMessage: React.Dispatch<React.SetStateAction<string>>;
    focus: () => void;
}

export function usePendingComposerText({ enabled, target, setMessage, focus }: PendingComposerTextOptions): void {
    const column = useChatColumnSession();
    const { pinned } = useChatColumnActions();
    // A pinned column keeps its own session and takes only text addressed to it.
    const columnBehindSelection = useSessionUIStore((state) => (
        column !== null && !pinned && column.sessionId !== state.currentSessionId
    ));
    const pendingInputText = useInputStore((state) => state.pendingInputText);
    const focusRef = React.useRef(focus);
    focusRef.current = focus;

    React.useEffect(() => {
        if (!enabled || columnBehindSelection || pendingInputText === null) return;
        const pending = useInputStore.getState().consumePendingInputText(target);
        if (!pending?.text) return;
        if (pending.mode === 'append') {
            setMessage((prev) => {
                const next = pending.text;
                if (!next.trim()) return prev;
                return appendWithLineBreaks(prev, next);
            });
        } else if (pending.mode === 'append-inline') {
            setMessage((prev) => appendInlineText(prev, pending.text));
        } else {
            setMessage(pending.text);
        }
        setTimeout(() => focusRef.current(), 0);
    }, [columnBehindSelection, enabled, pendingInputText, setMessage, target]);
}
