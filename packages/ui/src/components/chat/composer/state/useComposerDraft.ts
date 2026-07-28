/**
 * Per-session draft persistence for the composer.
 *
 * A draft belongs to a (runtime, directory, session) identity. Switching any
 * of those saves the outgoing draft and restores the incoming one, so moving
 * between sessions never loses typed text and never leaks it into the wrong
 * conversation.
 *
 * Writes are debounced while typing but forced at every edge where the page
 * may stop running — tab hidden, frozen, unloading, unmounting — because a
 * pending timer is not a saved draft.
 */

import React from 'react';

import {
    getChatDraftIdentityKey,
    readChatDraft,
    subscribeChatDraftDeletion,
    writeChatDraft,
    type ChatDraftIdentity,
} from '@/lib/chatDraftPersistence';

const PERSIST_DEBOUNCE_MS = 500;

/**
 * Identifies a stored draft's content. Comparing signatures lets a repeated
 * save of unchanged text skip the write entirely.
 */
function draftSignature(text: string, confirmedMentions: Iterable<string>): string {
    // NUL separates the fields: no draft text can contain it, so two different
    // (text, mentions) pairs can never produce the same signature.
    return `${text}\u0000${[...confirmedMentions].sort().join('\u0000')}`;
}

export interface ComposerDraftOptions {
    /** Current composer text. */
    message: string;
    /** Latest text without waiting for a render, for flush-on-unload paths. */
    messageRef: React.RefObject<string>;
    setMessage: (text: string) => void;
    /**
     * Mention paths the user confirmed through the picker. Mutated here:
     * mentions no longer present in the text are dropped before saving.
     */
    confirmedMentionsRef: React.RefObject<Set<string>>;
    /** The draft this composer currently belongs to. */
    identity: ChatDraftIdentity | null;
    /** User setting: when off, drafts are discarded rather than stored. */
    persistEnabled: boolean;
    /** The draft restored on mount, if any. */
    initialDraft: { text: string; identity: ChatDraftIdentity | null };
    /** Called when the composer switches to a different draft identity. */
    onIdentityChange?: () => void;
    /** Called after a non-empty draft is restored, to select its text. */
    onDraftRestored?: () => void;
}

export interface ComposerDraftControls {
    /**
     * Write a draft now, bypassing the debounce. Used on submit, where the
     * cleared composer must be stored before the send resolves.
     */
    persistNow: (identity: ChatDraftIdentity | null, draft: string) => void;
}

export function useComposerDraft(options: ComposerDraftOptions): ComposerDraftControls {
    const {
        message,
        messageRef,
        setMessage,
        confirmedMentionsRef,
        identity,
        persistEnabled,
        initialDraft,
        onIdentityChange,
        onDraftRestored,
    } = options;

    const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipNextPersistRef = React.useRef(false);
    const lastPersistedRef = React.useRef<Map<string, string>>(new Map());
    const currentIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);

    // Callbacks reach the effects through a ref so a caller passing inline
    // functions does not re-run the persistence effects on every render.
    const callbacksRef = React.useRef({ onIdentityChange, onDraftRestored });
    callbacksRef.current = { onIdentityChange, onDraftRestored };

    React.useEffect(() => {
        currentIdentityRef.current = identity;
    }, [identity]);

    const persistNow = React.useCallback((target: ChatDraftIdentity | null, draft: string) => {
        if (!target) return;
        const key = getChatDraftIdentityKey(target);

        // Only keep confirmed mentions the draft still contains: a mention the
        // user deleted must not resurrect as a file reference on restore.
        const activeMentions = new Set<string>();
        for (const mention of confirmedMentionsRef.current) {
            if (draft.includes(`@${mention}`)) activeMentions.add(mention);
        }
        confirmedMentionsRef.current = activeMentions;

        const signature = draftSignature(draft, activeMentions);
        if (lastPersistedRef.current.get(key) === signature) return;

        writeChatDraft(target, draft, activeMentions);
        lastPersistedRef.current.set(key, signature);
    }, [confirmedMentionsRef]);

    const clearPending = React.useCallback(() => {
        if (!persistTimerRef.current) return;
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
    }, []);

    // Mount: a restored draft is selected so typing replaces it; with the
    // setting off it is discarded instead of silently kept.
    const handledInitialRef = React.useRef(false);
    React.useEffect(() => {
        if (handledInitialRef.current) return;
        handledInitialRef.current = true;
        if (!initialDraft.text) return;

        if (!persistEnabled) {
            setMessage('');
            writeChatDraft(initialDraft.identity, '', []);
            return;
        }
        requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.());
        // Runs once; the initial draft is captured at mount by design.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [persistEnabled]);

    // Identity switch: save the outgoing draft, load the incoming one.
    const previousIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);
    React.useEffect(() => {
        const previous = previousIdentityRef.current;
        const previousKey = previous ? getChatDraftIdentityKey(previous) : null;
        const currentKey = identity ? getChatDraftIdentityKey(identity) : null;
        if (previousKey === currentKey) return;

        previousIdentityRef.current = identity;
        callbacksRef.current.onIdentityChange?.();
        clearPending();
        // The incoming draft is being written into state right now; the
        // debounced effect must not immediately write it back out.
        skipNextPersistRef.current = true;

        if (!persistEnabled) {
            setMessage('');
            confirmedMentionsRef.current = new Set();
            return;
        }

        persistNow(previous, messageRef.current);
        const restored = readChatDraft(identity);
        setMessage(restored.text);
        confirmedMentionsRef.current = restored.confirmedMentions;
        if (restored.text) {
            requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.());
        }
    }, [clearPending, confirmedMentionsRef, identity, messageRef, persistEnabled, persistNow, setMessage]);

    // A draft deleted elsewhere (session deleted, drafts cleared) clears the
    // composer if it is the one on screen.
    React.useEffect(() => subscribeChatDraftDeletion((deleted) => {
        const deletedKey = getChatDraftIdentityKey(deleted);
        // Record the empty signature so a queued write does not resurrect it.
        lastPersistedRef.current.set(deletedKey, draftSignature('', []));

        const current = currentIdentityRef.current;
        if (!current || getChatDraftIdentityKey(current) !== deletedKey) return;

        clearPending();
        skipNextPersistRef.current = true;
        messageRef.current = '';
        confirmedMentionsRef.current = new Set();
        setMessage('');
    }), [clearPending, confirmedMentionsRef, messageRef, setMessage]);

    // Debounced write while typing.
    React.useEffect(() => {
        if (!persistEnabled) {
            clearPending();
            persistNow(identity, '');
            return;
        }

        if (skipNextPersistRef.current) {
            skipNextPersistRef.current = false;
            return;
        }

        clearPending();
        const draftSnapshot = message;
        const identitySnapshot = identity;
        persistTimerRef.current = setTimeout(() => {
            persistTimerRef.current = null;
            persistNow(identitySnapshot, draftSnapshot);
        }, PERSIST_DEBOUNCE_MS);

        return clearPending;
    }, [clearPending, identity, message, persistEnabled, persistNow]);

    // Force a write wherever the page may stop running before the timer fires.
    React.useEffect(() => {
        const flush = () => {
            clearPending();
            if (persistEnabled) persistNow(currentIdentityRef.current, messageRef.current);
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flush();
        };

        document.addEventListener('visibilitychange', onVisibilityChange);
        document.addEventListener('freeze', flush);
        window.addEventListener('pagehide', flush);
        return () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            document.removeEventListener('freeze', flush);
            window.removeEventListener('pagehide', flush);
            flush();
        };
    }, [clearPending, messageRef, persistEnabled, persistNow]);

    return { persistNow };
}
