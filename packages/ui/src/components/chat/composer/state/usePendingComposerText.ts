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
 *
 * Two addresses are taken here, and nothing else. The column's own (`null` for
 * the main chat, its session id for a pinned chat) is what surfaces acting on
 * the chat on screen write — a `/btw` fork, being that same composer, takes
 * them while it is expanded and the parent takes them once it is collapsed.
 * The session this composer shows is what a session-scoped restore writes (a
 * reverted message's prompt), so the fork takes its own and the parent's waits
 * for the parent to come back.
 */

import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useChatColumnActions, useChatColumnSession } from '../../chatColumnSession';
import { appendInlineText, appendWithLineBreaks } from '../text';

export interface PendingComposerTextOptions {
    /** Column role: null for the main chat's composer, a session id for a pinned one. */
    target: string | null;
    /** The session this composer is showing, which a session-scoped restore addresses. */
    sessionId?: string | null;
    setMessage: React.Dispatch<React.SetStateAction<string>>;
    focus: () => void;
}

export function usePendingComposerText({ target, sessionId = null, setMessage, focus }: PendingComposerTextOptions): void {
    const column = useChatColumnSession();
    const { pinned } = useChatColumnActions();
    // A pinned column keeps its own session and takes only text addressed to it.
    const columnBehindSelection = useSessionUIStore((state) => (
        column !== null && !pinned && column.sessionId !== state.currentSessionId
    ));
    const pendingInputText = useInputStore((state) => state.pendingInputText);
    const pendingInputTarget = useInputStore((state) => state.pendingInputTarget);
    const pendingRestore = useInputStore((state) => sessionId ? state.pendingSessionRestores.get(sessionId) : undefined);
    const focusRef = React.useRef(focus);
    focusRef.current = focus;

    React.useEffect(() => {
        if (columnBehindSelection) return;
        const store = useInputStore.getState();
        const restored = sessionId ? store.consumePendingSessionRestore(sessionId) : null;
        if (restored !== null) setMessage(restored);
        const pending = store.consumePendingInputText(target);
        if (restored !== null) setTimeout(() => focusRef.current(), 0);
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
    }, [columnBehindSelection, pendingRestore, pendingInputTarget, pendingInputText, sessionId, setMessage, target]);
}
