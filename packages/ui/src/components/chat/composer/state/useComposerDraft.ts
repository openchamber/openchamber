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
import { useInputStore } from '@/sync/input-store';

import {
    clearChatDraft,
    getChatDraftIdentityKey,
    notifyAcceptedChatDraft,
    readChatDraft,
    subscribeAcceptedChatDraft,
    subscribeChatDraftDeletion,
    writeChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
} from '@/lib/chatDraftPersistence';
import { appendWithLineBreaks } from '../text';

const PERSIST_DEBOUNCE_MS = 500;

type SubmittedDraftTransfer = {
    from: ChatDraftIdentity | null;
    to: ChatDraftIdentity;
};

const sameDraftIdentity = (left: ChatDraftIdentity | null, right: ChatDraftIdentity | null): boolean => (
    left === right || Boolean(left && right && getChatDraftIdentityKey(left) === getChatDraftIdentityKey(right))
);

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
    /** User setting: when off, drafts stay in memory without durable writes. */
    persistEnabled: boolean;
    /** The draft restored on mount, if any. */
    initialDraft: { text: string; identity: ChatDraftIdentity | null };
    /** Session materialized from the new-session draft currently on screen. */
    submittedDraftSessionId?: string | null;
    /** Called when the composer switches to a different draft identity. */
    onIdentityChange?: (kind: 'switch' | 'submitted-draft') => void;
    /** Called after restoring a saved draft or fork replay, to select its text. */
    onDraftRestored?: (source: 'saved' | 'fork') => void;
}

export interface ComposerDraftControls {
    /** Clear exactly the draft snapshot accepted by a remote send. */
    clearSubmittedDraft: (
        submittedIdentity: ChatDraftIdentity | null,
        submittedText: string,
        submittedMentions: ReadonlySet<string>,
        materializedIdentity?: ChatDraftIdentity | null,
    ) => boolean;
    /**
     * Write a draft now, bypassing the debounce. Used on submit, where the
     * cleared composer must be stored before the send resolves.
     */
    persistNow: (identity: ChatDraftIdentity | null, draft: string) => void;
    /** Consume a command in the current draft while opening another draft. */
    handoffDraft: (identity: ChatDraftIdentity | null, draft: string | null) => void;
    /** Restore a draft after a failed send without using persistence as state. */
    restoreDraft: (identity: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => void;
    /** Move an in-memory draft to an identity materialized during an async flow. */
    migrateDraft: (from: ChatDraftIdentity | null, to: ChatDraftIdentity | null) => void;
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
        submittedDraftSessionId = null,
        onIdentityChange,
        onDraftRestored,
    } = options;

    const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const persistTimerIdentityKeyRef = React.useRef<string | null>(null);
    const skipNextPersistRef = React.useRef(false);
    const lastPersistedRef = React.useRef<Map<string, string>>(new Map());
    const currentIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);
    const draftMemoryRef = React.useRef(new Map<string, ChatDraftSnapshot>());
    const skipOutgoingDraftRef = React.useRef(false);
    const submittedDraftTransferRef = React.useRef<SubmittedDraftTransfer | null>(null);
    const initialKey = initialDraft.identity ? getChatDraftIdentityKey(initialDraft.identity) : null;
    if (persistEnabled && initialKey && !draftMemoryRef.current.has(initialKey) && initialDraft.text) {
        draftMemoryRef.current.set(initialKey, {
            text: initialDraft.text,
            confirmedMentions: new Set(confirmedMentionsRef.current),
        });
    }
    const pendingComposerRestore = useInputStore((state) => state.pendingComposerRestore);

    // Callbacks reach the effects through a ref so a caller passing inline
    // functions does not re-run the persistence effects on every render.
    const callbacksRef = React.useRef({ onIdentityChange, onDraftRestored });
    callbacksRef.current = { onIdentityChange, onDraftRestored };

    currentIdentityRef.current = identity;

    React.useEffect(() => {
        // Persistence off keeps in-memory drafts, but must not retain old disk copies.
        if (!persistEnabled && identity) clearChatDraft(identity);
    }, [identity, persistEnabled]);

    const persistNow = React.useCallback((target: ChatDraftIdentity | null, draft: string) => {
        if (!persistEnabled || !target) return;
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
    }, [confirmedMentionsRef, persistEnabled]);

    const clearPending = React.useCallback((identityKey?: string) => {
        if (!persistTimerRef.current) return;
        if (identityKey && persistTimerIdentityKeyRef.current !== identityKey) return;
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        persistTimerIdentityKeyRef.current = null;
    }, []);

    const clearSubmittedDraft = React.useCallback((
        submittedIdentity: ChatDraftIdentity | null,
        submittedText: string,
        submittedMentions: ReadonlySet<string>,
        materializedIdentity?: ChatDraftIdentity | null,
        notify = true,
    ): boolean => {
        const transfer = submittedDraftTransferRef.current;
        const target = materializedIdentity
            ?? (transfer && sameDraftIdentity(transfer.from, submittedIdentity) ? transfer.to : submittedIdentity);
        if (!target) return false;

        const targetKey = getChatDraftIdentityKey(target);
        const isCurrent = sameDraftIdentity(target, currentIdentityRef.current);
        const persisted = persistEnabled ? readChatDraft(target) : null;
        const submittedSignature = draftSignature(submittedText, submittedMentions);
        if (persisted && (persisted.text || persisted.confirmedMentions.size > 0)
            && draftSignature(persisted.text, persisted.confirmedMentions) !== submittedSignature) {
            return false;
        }
        const stored = persisted && (persisted.text || persisted.confirmedMentions.size > 0)
            ? persisted
            : draftMemoryRef.current.get(targetKey);
        const current = isCurrent
            ? { text: messageRef.current, confirmedMentions: confirmedMentionsRef.current }
            : stored;
        if (!current || draftSignature(current.text, current.confirmedMentions) !== submittedSignature) {
            if (transfer && sameDraftIdentity(transfer.to, target)) submittedDraftTransferRef.current = null;
            return false;
        }

        clearPending(targetKey);
        draftMemoryRef.current.set(targetKey, { text: '', confirmedMentions: new Set() });
        if (persistEnabled) {
            writeChatDraft(target, '', []);
            lastPersistedRef.current.set(targetKey, draftSignature('', []));
        }
        if (isCurrent) {
            messageRef.current = '';
            confirmedMentionsRef.current = new Set();
            setMessage('');
        }
        if (transfer && sameDraftIdentity(transfer.to, target)) submittedDraftTransferRef.current = null;
        if (notify) {
            notifyAcceptedChatDraft({
                identity: target,
                text: submittedText,
                confirmedMentions: new Set(submittedMentions),
            });
        }
        return isCurrent;
    }, [clearPending, confirmedMentionsRef, messageRef, persistEnabled, setMessage]);

    React.useEffect(() => subscribeAcceptedChatDraft((accepted) => {
        const current = currentIdentityRef.current;
        if (current && sameDraftIdentity(current, accepted.identity)) {
            const currentSignature = draftSignature(messageRef.current, confirmedMentionsRef.current);
            const acceptedSignature = draftSignature(accepted.text, accepted.confirmedMentions);
            if (currentSignature !== acceptedSignature) {
                if (persistEnabled) {
                    writeChatDraft(current, messageRef.current, confirmedMentionsRef.current);
                    lastPersistedRef.current.set(getChatDraftIdentityKey(current), currentSignature);
                }
                return;
            }
        }
        clearSubmittedDraft(
            accepted.identity,
            accepted.text,
            accepted.confirmedMentions,
            accepted.identity,
            false,
        );
    }), [clearSubmittedDraft, confirmedMentionsRef, messageRef, persistEnabled]);

    // Mount: a restored draft is selected so typing replaces it; with the
    // setting off it is discarded instead of silently kept.
    const handledInitialRef = React.useRef(false);
    React.useEffect(() => {
        if (handledInitialRef.current) return;
        handledInitialRef.current = true;
        if (!initialDraft.text) return;

        if (!persistEnabled) {
            messageRef.current = '';
            confirmedMentionsRef.current = new Set();
            setMessage('');
            return;
        }
        requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
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
        clearPending();
        // The incoming draft is being written into state right now; the
        // debounced effect must not immediately write it back out.
        skipNextPersistRef.current = true;

        if (
            identity
            && submittedDraftSessionId !== null
            && identity.sessionId === submittedDraftSessionId
            && previous?.sessionId === null
            && previous.runtimeKey === identity.runtimeKey
        ) {
            callbacksRef.current.onIdentityChange?.('submitted-draft');
            submittedDraftTransferRef.current = { from: previous, to: identity };
            const transferred = { text: messageRef.current, confirmedMentions: new Set(confirmedMentionsRef.current) };
            draftMemoryRef.current.set(currentKey!, transferred);
            if (persistEnabled) {
                persistNow(identity, transferred.text);
                if (previous) {
                    writeChatDraft(previous, '', []);
                    lastPersistedRef.current.set(previousKey!, draftSignature('', []));
                }
            }
            return;
        }

        callbacksRef.current.onIdentityChange?.('switch');
        if (!skipOutgoingDraftRef.current && previousKey) {
            const outgoing = { text: messageRef.current, confirmedMentions: new Set(confirmedMentionsRef.current) };
            draftMemoryRef.current.set(previousKey, outgoing);
            if (persistEnabled) persistNow(previous, outgoing.text);
        }
        skipOutgoingDraftRef.current = false;

        const restored = (currentKey && draftMemoryRef.current.get(currentKey))
            || (persistEnabled ? readChatDraft(identity) : { text: '', confirmedMentions: new Set<string>() });
        messageRef.current = restored.text;
        setMessage(restored.text);
        confirmedMentionsRef.current = new Set(restored.confirmedMentions);
        if (restored.text) {
            requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
        }
    }, [clearPending, confirmedMentionsRef, identity, messageRef, persistEnabled, persistNow, setMessage, submittedDraftSessionId]);

    // The chat column can still show the source after navigation selects a fork.
    // Apply its replay only after the destination's draft has been loaded above.
    React.useEffect(() => {
        if (!pendingComposerRestore) return;
        const input = useInputStore.getState();
        const pending = input.consumePendingComposerRestore(identity);
        if (!pending) return;

        clearPending();
        skipNextPersistRef.current = true;
        messageRef.current = pending.text;
        confirmedMentionsRef.current = new Set();
        setMessage(pending.text);
        // Equal source/replay text need not trigger another render to persist.
        if (persistEnabled) persistNow(pending.target, pending.text);
        input.clearAttachedFiles();
        for (const file of pending.files) input.addRestoredAttachment(file);
        requestAnimationFrame(() => {
            const current = currentIdentityRef.current;
            if (current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(pending.target)) {
                callbacksRef.current.onDraftRestored?.('fork');
            }
        });
    }, [clearPending, confirmedMentionsRef, identity, messageRef, pendingComposerRestore, persistEnabled, persistNow, setMessage]);

    // A draft deleted elsewhere (session deleted, drafts cleared) clears the
    // composer if it is the one on screen.
    React.useEffect(() => subscribeChatDraftDeletion((deleted) => {
        const deletedKey = getChatDraftIdentityKey(deleted);
        // Record the empty signature so a queued write does not resurrect it.
        lastPersistedRef.current.set(deletedKey, draftSignature('', []));
        draftMemoryRef.current.set(deletedKey, { text: '', confirmedMentions: new Set() });

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
        if (!persistEnabled) return;

        if (skipNextPersistRef.current) {
            skipNextPersistRef.current = false;
            return;
        }

        clearPending();
        const draftSnapshot = message;
        const identitySnapshot = identity;
        persistTimerIdentityKeyRef.current = identitySnapshot ? getChatDraftIdentityKey(identitySnapshot) : null;
        persistTimerRef.current = setTimeout(() => {
            persistTimerRef.current = null;
            persistTimerIdentityKeyRef.current = null;
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

    const restoreDraft = React.useCallback((target: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => {
        const targetKey = target ? getChatDraftIdentityKey(target) : null;
        const current = currentIdentityRef.current;
        const isCurrent = target && current && getChatDraftIdentityKey(target) === getChatDraftIdentityKey(current);
        const existing = isCurrent
            ? { text: messageRef.current, confirmedMentions: confirmedMentionsRef.current }
            : (targetKey && draftMemoryRef.current.get(targetKey)) || (persistEnabled ? readChatDraft(target) : null);
        const text = existing?.text && existing.text !== draft ? appendWithLineBreaks(existing.text, draft) : draft;
        const mentions = new Set([...(existing?.confirmedMentions ?? []), ...confirmedMentions]);
        if (targetKey) draftMemoryRef.current.set(targetKey, { text, confirmedMentions: mentions });
        if (isCurrent) {
            messageRef.current = text;
            confirmedMentionsRef.current = new Set(mentions);
            setMessage(text);
        }
        if (persistEnabled && target) {
            writeChatDraft(target, text, mentions);
            lastPersistedRef.current.set(getChatDraftIdentityKey(target), draftSignature(text, mentions));
        }
    }, [confirmedMentionsRef, messageRef, persistEnabled, setMessage]);

    const handoffDraft = React.useCallback((target: ChatDraftIdentity | null, draft: string | null) => {
        const targetKey = target ? getChatDraftIdentityKey(target) : null;
        if (targetKey && draft !== null) draftMemoryRef.current.set(targetKey, { text: draft, confirmedMentions: new Set() });
        const currentKey = currentIdentityRef.current ? getChatDraftIdentityKey(currentIdentityRef.current) : null;
        if (targetKey === currentKey) {
            if (draft !== null) {
                messageRef.current = draft;
                confirmedMentionsRef.current = new Set();
                setMessage(draft);
                persistNow(target, draft);
            }
            return;
        }
        if (currentKey) draftMemoryRef.current.set(currentKey, { text: '', confirmedMentions: new Set() });
        persistNow(currentIdentityRef.current, '');
        skipOutgoingDraftRef.current = true;
        messageRef.current = '';
        confirmedMentionsRef.current = new Set();
        setMessage('');
    }, [confirmedMentionsRef, messageRef, persistNow, setMessage]);

    const migrateDraft = React.useCallback((from: ChatDraftIdentity | null, to: ChatDraftIdentity | null) => {
        if (!to) return;
        const current = currentIdentityRef.current;
        const draft = from && current && getChatDraftIdentityKey(from) === getChatDraftIdentityKey(current)
            ? { text: messageRef.current, confirmedMentions: new Set(confirmedMentionsRef.current) }
            : (from && draftMemoryRef.current.get(getChatDraftIdentityKey(from)))
            || (persistEnabled ? readChatDraft(from) : null);
        if (!draft) return;
        draftMemoryRef.current.set(getChatDraftIdentityKey(to), { text: draft.text, confirmedMentions: new Set(draft.confirmedMentions) });
        if (persistEnabled) {
            writeChatDraft(to, draft.text, draft.confirmedMentions);
            lastPersistedRef.current.set(getChatDraftIdentityKey(to), draftSignature(draft.text, draft.confirmedMentions));
        }
    }, [confirmedMentionsRef, messageRef, persistEnabled]);

    return { clearSubmittedDraft, persistNow, handoffDraft, restoreDraft, migrateDraft };
}
