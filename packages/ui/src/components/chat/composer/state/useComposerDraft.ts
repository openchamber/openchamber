/**
 * Per-session draft persistence for the composer.
 *
 * A draft belongs to a (runtime, directory, session) identity. Switching any
 * of those saves the outgoing draft and restores the incoming one, so moving
 * between sessions never loses typed text and never leaks it into the wrong
 * conversation. The exception is the same draft changing directory: the open
 * new-session draft changing its project or worktree, or a session moved to
 * another directory. Its text and files move to the new directory.
 *
 * Writes are debounced while typing but forced at every edge where the page
 * may stop running — tab hidden, frozen, unloading, unmounting — because a
 * pending timer is not a saved draft.
 */

import React from 'react';
import { useInputStore } from '@/sync/input-store';

import {
    getChatDraftIdentityKey,
    isNewSessionDraftIdentity,
    readChatDraft,
    readChatDraftClaimingFolderDraft,
    subscribeChatDraftDeletion,
    writeChatDraft,
    type ChatDraftIdentity,
    type ChatDraftSnapshot,
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
    /**
     * Makes this draft's attachments the app's selected attachment slot when
     * the identity changes. Off for a chat pinned in the side panel: it takes
     * the slot only when the user works in it, so the main composer keeps
     * receiving app-wide attachments meanwhile.
     */
    selectAttachmentsOnIdentityChange?: boolean;
    /** The draft restored on mount, if any. */
    initialDraft: { text: string; identity: ChatDraftIdentity | null };
    /**
     * Id of the open new-session draft shown in this composer, or null. It
     * stays the same while the user changes the draft's project or worktree
     * and changes when a new draft opens.
     */
    newSessionDraftId?: number | null;
    /** Called when the composer switches to a different draft identity. */
    onIdentityChange?: () => void;
    /** Called after restoring a saved draft or fork replay, to select its text. */
    onDraftRestored?: (source: 'saved' | 'fork') => void;
}

export interface ComposerDraftControls {
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
        selectAttachmentsOnIdentityChange = true,
        initialDraft,
        newSessionDraftId = null,
        onIdentityChange,
        onDraftRestored,
    } = options;

    const persistTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const skipNextPersistRef = React.useRef(false);
    const lastPersistedRef = React.useRef<Map<string, string>>(new Map());
    const currentIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);
    const draftMemoryRef = React.useRef(new Map<string, ChatDraftSnapshot>());
    const skipOutgoingDraftRef = React.useRef(false);
    const initialKey = initialDraft.identity ? getChatDraftIdentityKey(initialDraft.identity) : null;
    if (initialKey && !draftMemoryRef.current.has(initialKey) && initialDraft.text) {
        draftMemoryRef.current.set(initialKey, {
            text: initialDraft.text,
            confirmedMentions: new Set(confirmedMentionsRef.current),
        });
    }
    const pendingComposerRestore = useInputStore((state) => state.pendingComposerRestore);

    // Follow the rendered composer, not the sidebar's deferred selection.
    // Layout timing prevents the incoming composer painting outgoing files.
    React.useLayoutEffect(() => {
        if (!selectAttachmentsOnIdentityChange) return;
        useInputStore.getState().selectAttachmentDraft(identity);
    }, [identity, selectAttachmentsOnIdentityChange]);

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

    // Mount: a restored draft is selected so typing replaces it.
    const handledInitialRef = React.useRef(false);
    React.useEffect(() => {
        if (handledInitialRef.current) return;
        handledInitialRef.current = true;
        if (!initialDraft.text) return;
        requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
        // Runs once; the initial draft is captured at mount by design.
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Identity switch: save the outgoing draft, load the incoming one.
    const previousIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);
    // The new-session draft id seen at the last run, so a switch can tell the
    // same draft moving from a new draft replacing it.
    const previousNewSessionDraftIdRef = React.useRef<number | null>(newSessionDraftId);
    React.useEffect(() => {
        const sameNewSessionDraft = newSessionDraftId !== null && previousNewSessionDraftIdRef.current === newSessionDraftId;
        previousNewSessionDraftIdRef.current = newSessionDraftId;
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

        const outgoing = { text: messageRef.current, confirmedMentions: new Set(confirmedMentionsRef.current) };
        // Picking another project or worktree for the open new-session draft
        // changes where it will run, not which draft it is, so its text and
        // files go along instead of staying with the old directory. A new
        // draft opened elsewhere gets a new id and leaves this one in place.
        // A session moved to another directory keeps its id, so the same
        // session in a new directory is the same draft too.
        const sameDraftMoved = !skipOutgoingDraftRef.current
            && previous !== null
            && identity !== null
            && previous.runtimeKey === identity.runtimeKey
            && (isNewSessionDraftIdentity(previous)
                ? sameNewSessionDraft && isNewSessionDraftIdentity(identity)
                : previous.sessionId === identity.sessionId);
        const carriesText = sameDraftMoved && outgoing.text.length > 0;
        if (sameDraftMoved) useInputStore.getState().moveAttachedFiles(previous, identity);
        if (carriesText && previousKey) {
            draftMemoryRef.current.set(previousKey, { text: '', confirmedMentions: new Set() });
            persistNow(previous, '');
        } else if (!skipOutgoingDraftRef.current && previousKey) {
            draftMemoryRef.current.set(previousKey, outgoing);
            persistNow(previous, outgoing.text);
        }
        skipOutgoingDraftRef.current = false;

        const saved = (currentKey && draftMemoryRef.current.get(currentKey))
            || readChatDraftClaimingFolderDraft(identity);
        // Mentions name files of the old directory, so only the text travels.
        // A draft already saved for the new directory is kept above it.
        const restored = carriesText
            ? {
                text: saved.text && saved.text !== outgoing.text ? `${saved.text}\n\n${outgoing.text}` : outgoing.text,
                confirmedMentions: saved.confirmedMentions,
            }
            : saved;
        messageRef.current = restored.text;
        setMessage(restored.text);
        confirmedMentionsRef.current = new Set(restored.confirmedMentions);
        if (carriesText) {
            // The text is the one the user is typing, so it is neither
            // selected as a restored draft nor left to the skipped debounce.
            persistNow(identity, restored.text);
        } else if (restored.text) {
            requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
        }
    }, [clearPending, confirmedMentionsRef, identity, messageRef, newSessionDraftId, persistNow, setMessage]);

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
        persistNow(pending.target, pending.text);
        input.clearAttachedFiles();
        for (const file of pending.files) input.addRestoredAttachment(file);
        requestAnimationFrame(() => {
            const current = currentIdentityRef.current;
            if (current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(pending.target)) {
                callbacksRef.current.onDraftRestored?.('fork');
            }
        });
    }, [clearPending, confirmedMentionsRef, identity, messageRef, pendingComposerRestore, persistNow, setMessage]);

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
    }, [clearPending, identity, message, persistNow]);

    // Force a write wherever the page may stop running before the timer fires.
    React.useEffect(() => {
        const flush = () => {
            clearPending();
            persistNow(currentIdentityRef.current, messageRef.current);
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
    }, [clearPending, messageRef, persistNow]);

    const restoreDraft = React.useCallback((target: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => {
        const targetKey = target ? getChatDraftIdentityKey(target) : null;
        const current = currentIdentityRef.current;
        const isCurrent = target && current && getChatDraftIdentityKey(target) === getChatDraftIdentityKey(current);
        const existing = isCurrent
            ? { text: messageRef.current, confirmedMentions: confirmedMentionsRef.current }
            : (targetKey && draftMemoryRef.current.get(targetKey)) || readChatDraft(target);
        const text = existing?.text && existing.text !== draft ? `${existing.text}\n\n${draft}` : draft;
        const mentions = new Set([...(existing?.confirmedMentions ?? []), ...confirmedMentions]);
        if (targetKey) draftMemoryRef.current.set(targetKey, { text, confirmedMentions: mentions });
        if (isCurrent) {
            messageRef.current = text;
            confirmedMentionsRef.current = new Set(mentions);
            setMessage(text);
        }
        if (target) {
            writeChatDraft(target, text, mentions);
            lastPersistedRef.current.set(getChatDraftIdentityKey(target), draftSignature(text, mentions));
        }
    }, [confirmedMentionsRef, messageRef, setMessage]);

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
            || readChatDraft(from);
        draftMemoryRef.current.set(getChatDraftIdentityKey(to), { text: draft.text, confirmedMentions: new Set(draft.confirmedMentions) });
        writeChatDraft(to, draft.text, draft.confirmedMentions);
        lastPersistedRef.current.set(getChatDraftIdentityKey(to), draftSignature(draft.text, draft.confirmedMentions));
    }, [confirmedMentionsRef, messageRef]);

    return { persistNow, handoffDraft, restoreDraft, migrateDraft };
}
