
import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useChatColumnActions, useChatColumnSession } from '../../chatColumnSession';
import { appendInlineText, appendWithLineBreaks, withLeadingSlashCommand } from '../text';
import type { ComposerText } from './composerText';

export interface PendingComposerTextOptions {
    target: string | null;
    sessionId?: string | null;
    text: ComposerText;
    setMessage: (text: string) => void;
    focus: () => void;
    holdSlashCommand?: boolean;
    onSlashCommand?: () => void;
}

export function usePendingComposerText({
    target,
    sessionId = null,
    text,
    setMessage,
    focus,
    holdSlashCommand = false,
    onSlashCommand,
}: PendingComposerTextOptions): void {
    const column = useChatColumnSession();
    const { pinned } = useChatColumnActions();
    const columnBehindSelection = useSessionUIStore((state) => (
        column !== null && !pinned && column.sessionId !== state.currentSessionId
    ));
    const pendingInputText = useInputStore((state) => state.pendingInputText);
    const pendingInputTarget = useInputStore((state) => state.pendingInputTarget);
    const pendingRestore = useInputStore((state) => sessionId ? state.pendingSessionRestores.get(sessionId) : undefined);
    const focusRef = React.useRef(focus);
    focusRef.current = focus;
    const onSlashCommandRef = React.useRef(onSlashCommand);
    onSlashCommandRef.current = onSlashCommand;

    React.useEffect(() => {
        if (columnBehindSelection) return;
        const store = useInputStore.getState();
        const restored = sessionId ? store.consumePendingSessionRestore(sessionId) : null;
        if (restored !== null) setMessage(restored);
        const pending = holdSlashCommand && store.pendingInputMode === 'slash-command'
            ? null
            : store.consumePendingInputText(target);
        if (restored !== null) setTimeout(() => focusRef.current(), 0);
        if (!pending?.text) return;
        if (pending.mode === 'append') {
            if (pending.text.trim()) setMessage(appendWithLineBreaks(text.get(), pending.text));
        } else if (pending.mode === 'append-inline') {
            setMessage(appendInlineText(text.get(), pending.text));
        } else if (pending.mode === 'slash-command') {
            onSlashCommandRef.current?.();
            setMessage(withLeadingSlashCommand(text.get(), pending.text));
        } else {
            setMessage(pending.text);
        }
        setTimeout(() => focusRef.current(), 0);
    }, [columnBehindSelection, holdSlashCommand, pendingRestore, pendingInputTarget, pendingInputText, sessionId, setMessage, target, text]);
}
