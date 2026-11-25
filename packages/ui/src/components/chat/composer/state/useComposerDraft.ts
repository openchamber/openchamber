
import React from 'react';
import { useInputStore } from '@/sync/input-store';
import { attachmentBasename, withMissingCitations } from '@/lib/attachmentIdentity';
import { isBtwPendingComposerKey } from '@/lib/btw';
import { isMentionEntryInText } from '../language/mentions';
import { useLinkedReferenceDrafts } from '../linkedReferenceDrafts';
import { useComposerTextEffect, type ComposerText } from './composerText';

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

function draftSignature(text: string, confirmedMentions: Iterable<string>): string {
    return `${text}\u0000${[...confirmedMentions].sort().join('\u0000')}`;
}

export interface ComposerDraftOptions {
    text: ComposerText;
    setMessage: (text: string) => void;
    confirmedMentionsRef: React.RefObject<Set<string>>;
    identity: ChatDraftIdentity | null;
    selectAttachmentsOnIdentityChange?: boolean;
    initialDraft: { text: string; identity: ChatDraftIdentity | null };
    newSessionDraftId?: number | null;
    onIdentityChange?: () => void;
    onNewSessionDraftMoved?: (moved: { newSessionDraftId: number; identity: ChatDraftIdentity }) => void;
    onDraftRestored?: (source: 'saved' | 'fork') => void;
}

export interface ComposerDraftControls {
    persistNow: (identity: ChatDraftIdentity | null, draft: string) => void;
    handoffDraft: (identity: ChatDraftIdentity | null, draft: string | null) => void;
    restoreDraft: (identity: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => void;
    migrateDraft: (from: ChatDraftIdentity | null, to: ChatDraftIdentity | null) => void;
}

export function useComposerDraft(options: ComposerDraftOptions): ComposerDraftControls {
    const {
        text,
        setMessage,
        confirmedMentionsRef,
        identity,
        selectAttachmentsOnIdentityChange = true,
        initialDraft,
        newSessionDraftId = null,
        onIdentityChange,
        onNewSessionDraftMoved,
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

    React.useLayoutEffect(() => {
        if (!selectAttachmentsOnIdentityChange) return;
        useInputStore.getState().selectAttachmentDraft(identity);
    }, [identity, selectAttachmentsOnIdentityChange]);

    const callbacksRef = React.useRef({ onIdentityChange, onNewSessionDraftMoved, onDraftRestored });
    callbacksRef.current = { onIdentityChange, onNewSessionDraftMoved, onDraftRestored };

    React.useEffect(() => {
        currentIdentityRef.current = identity;
    }, [identity]);

    const persistNow = React.useCallback((target: ChatDraftIdentity | null, draft: string) => {
        if (!target) return;
        const key = getChatDraftIdentityKey(target);

        const activeMentions = new Set<string>();
        for (const mention of confirmedMentionsRef.current) {
            if (isMentionEntryInText(mention, draft)) activeMentions.add(mention);
        }
        confirmedMentionsRef.current = activeMentions;

        if (isBtwPendingComposerKey(target.sessionId)) {
            draftMemoryRef.current.set(key, { text: draft, confirmedMentions: activeMentions });
            return;
        }

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

    const handledInitialRef = React.useRef(false);
    React.useEffect(() => {
        if (handledInitialRef.current) return;
        handledInitialRef.current = true;
        if (!initialDraft.text) return;
        requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const previousIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraft.identity);
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
        skipNextPersistRef.current = true;

        const outgoing = { text: text.get(), confirmedMentions: new Set(confirmedMentionsRef.current) };
        const sameDraftMoved = !skipOutgoingDraftRef.current
            && previous !== null
            && identity !== null
            && previous.runtimeKey === identity.runtimeKey
            && (isNewSessionDraftIdentity(previous)
                ? sameNewSessionDraft && isNewSessionDraftIdentity(identity)
                : previous.sessionId === identity.sessionId);
        const carriesText = sameDraftMoved && outgoing.text.length > 0;
        if (sameDraftMoved) {
            useInputStore.getState().moveAttachedFiles(previous, identity);
            useLinkedReferenceDrafts.getState().move(previous, identity);
            if (sameNewSessionDraft) callbacksRef.current.onNewSessionDraftMoved?.({ newSessionDraftId, identity });
        }
        if (carriesText && previousKey) {
            draftMemoryRef.current.set(previousKey, { text: '', confirmedMentions: new Set() });
            persistNow(previous, '');
        } else if (!skipOutgoingDraftRef.current && previousKey) {
            draftMemoryRef.current.set(previousKey, outgoing);
            persistNow(previous, outgoing.text);
        }
        skipOutgoingDraftRef.current = false;

        const saved = (currentKey && draftMemoryRef.current.get(currentKey))
            || (identity && isBtwPendingComposerKey(identity.sessionId)
                ? { text: '', confirmedMentions: new Set<string>() }
                : readChatDraftClaimingFolderDraft(identity));
        const restored = carriesText
            ? {
                text: saved.text && saved.text !== outgoing.text ? `${saved.text}\n\n${outgoing.text}` : outgoing.text,
                confirmedMentions: saved.confirmedMentions,
            }
            : saved;
        confirmedMentionsRef.current = new Set(restored.confirmedMentions);
        setMessage(restored.text);
        if (carriesText) {
            persistNow(identity, restored.text);
        } else if (restored.text) {
            requestAnimationFrame(() => callbacksRef.current.onDraftRestored?.('saved'));
        }
    }, [clearPending, confirmedMentionsRef, identity, newSessionDraftId, persistNow, setMessage, text]);

    React.useEffect(() => {
        if (!pendingComposerRestore) return;
        const input = useInputStore.getState();
        const pending = input.consumePendingComposerRestore(identity);
        if (!pending) return;

        clearPending();
        skipNextPersistRef.current = true;
        confirmedMentionsRef.current = new Set();
        const text = withMissingCitations(pending.text, pending.files.map((file) => ({ filename: attachmentBasename(file.filename) })));
        setMessage(text);
        persistNow(pending.target, text);
        input.clearAttachedFiles();
        for (const file of pending.files) input.addRestoredAttachment(file);
        requestAnimationFrame(() => {
            const current = currentIdentityRef.current;
            if (current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(pending.target)) {
                callbacksRef.current.onDraftRestored?.('fork');
            }
        });
    }, [clearPending, confirmedMentionsRef, identity, pendingComposerRestore, persistNow, setMessage]);

    React.useEffect(() => subscribeChatDraftDeletion((deleted) => {
        const deletedKey = getChatDraftIdentityKey(deleted);
        lastPersistedRef.current.set(deletedKey, draftSignature('', []));
        draftMemoryRef.current.set(deletedKey, { text: '', confirmedMentions: new Set() });

        const current = currentIdentityRef.current;
        if (!current || getChatDraftIdentityKey(current) !== deletedKey) return;

        clearPending();
        skipNextPersistRef.current = true;
        confirmedMentionsRef.current = new Set();
        setMessage('');
    }), [clearPending, confirmedMentionsRef, setMessage]);

    useComposerTextEffect(text, (draftSnapshot) => {
        if (skipNextPersistRef.current) {
            skipNextPersistRef.current = false;
            return;
        }

        clearPending();
        const identitySnapshot = identity;
        persistTimerRef.current = setTimeout(() => {
            persistTimerRef.current = null;
            persistNow(identitySnapshot, draftSnapshot);
        }, PERSIST_DEBOUNCE_MS);

        return clearPending;
    }, [clearPending, identity, persistNow]);

    React.useEffect(() => {
        const flush = () => {
            clearPending();
            persistNow(currentIdentityRef.current, text.get());
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
    }, [clearPending, persistNow, text]);

    const restoreDraft = React.useCallback((target: ChatDraftIdentity | null, draft: string, confirmedMentions: Set<string>) => {
        const targetKey = target ? getChatDraftIdentityKey(target) : null;
        const current = currentIdentityRef.current;
        const isCurrent = target && current && getChatDraftIdentityKey(target) === getChatDraftIdentityKey(current);
        const existing = isCurrent
            ? { text: text.get(), confirmedMentions: confirmedMentionsRef.current }
            : (targetKey && draftMemoryRef.current.get(targetKey))
                || (isBtwPendingComposerKey(target?.sessionId) ? null : readChatDraft(target));
        const merged = existing?.text && existing.text !== draft ? `${existing.text}\n\n${draft}` : draft;
        const mentions = new Set([...(existing?.confirmedMentions ?? []), ...confirmedMentions]);
        if (targetKey) draftMemoryRef.current.set(targetKey, { text: merged, confirmedMentions: mentions });
        if (isCurrent) {
            confirmedMentionsRef.current = new Set(mentions);
            setMessage(merged);
        }
        if (target && !isBtwPendingComposerKey(target.sessionId)) {
            writeChatDraft(target, merged, mentions);
            lastPersistedRef.current.set(getChatDraftIdentityKey(target), draftSignature(merged, mentions));
        }
    }, [confirmedMentionsRef, setMessage, text]);

    const handoffDraft = React.useCallback((target: ChatDraftIdentity | null, draft: string | null) => {
        const targetKey = target ? getChatDraftIdentityKey(target) : null;
        if (targetKey && draft !== null) draftMemoryRef.current.set(targetKey, { text: draft, confirmedMentions: new Set() });
        const currentKey = currentIdentityRef.current ? getChatDraftIdentityKey(currentIdentityRef.current) : null;
        if (targetKey === currentKey) {
            if (draft !== null) {
                confirmedMentionsRef.current = new Set();
                setMessage(draft);
                persistNow(target, draft);
            }
            return;
        }
        if (currentKey) draftMemoryRef.current.set(currentKey, { text: '', confirmedMentions: new Set() });
        persistNow(currentIdentityRef.current, '');
        skipOutgoingDraftRef.current = true;
        confirmedMentionsRef.current = new Set();
        setMessage('');
    }, [confirmedMentionsRef, persistNow, setMessage]);

    const migrateDraft = React.useCallback((from: ChatDraftIdentity | null, to: ChatDraftIdentity | null) => {
        if (!to) return;
        const current = currentIdentityRef.current;
        const draft = from && current && getChatDraftIdentityKey(from) === getChatDraftIdentityKey(current)
            ? { text: text.get(), confirmedMentions: new Set(confirmedMentionsRef.current) }
            : (from && draftMemoryRef.current.get(getChatDraftIdentityKey(from)))
            || (isBtwPendingComposerKey(from?.sessionId)
                ? { text: '', confirmedMentions: new Set<string>() }
                : readChatDraft(from));
        draftMemoryRef.current.set(getChatDraftIdentityKey(to), { text: draft.text, confirmedMentions: new Set(draft.confirmedMentions) });
        writeChatDraft(to, draft.text, draft.confirmedMentions);
        lastPersistedRef.current.set(getChatDraftIdentityKey(to), draftSignature(draft.text, draft.confirmedMentions));
        if (from) draftMemoryRef.current.set(getChatDraftIdentityKey(from), { text: '', confirmedMentions: new Set() });
        if (from && current && getChatDraftIdentityKey(from) === getChatDraftIdentityKey(current)) {
            clearPending();
            skipOutgoingDraftRef.current = true;
            confirmedMentionsRef.current = new Set();
            setMessage('');
        }
    }, [clearPending, confirmedMentionsRef, setMessage, text]);

    return { persistNow, handoffDraft, restoreDraft, migrateDraft };
}
