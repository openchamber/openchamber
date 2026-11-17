import type { useComposerColumn } from './useComposerColumn';
import React from 'react';
import { readChatDraftClaimingFolderDraft, type ChatDraftIdentity, type ChatDraftSnapshot } from '@/lib/chatDraftPersistence';
import { createComposerText, useComposerTextValue } from '../../composer/state/composerText';
import { resolveChatDraftIdentity } from './composerDraftIdentity';



export function useComposerDraftText(chatColumnSession: ReturnType<typeof useComposerColumn>['chatColumnSession']) {
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);

    const initialDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(null);

    const initialDraftSnapshotRef = React.useRef<ChatDraftSnapshot>({ text: '', confirmedMentions: new Set() });

    // The draft text lives outside React state, so a keystroke re-renders only
    // what shows a value derived from it (see composerText.ts).
    const [composerText] = React.useState(() => {
        const identity = resolveChatDraftIdentity(chatColumnSession);
        const snapshot = readChatDraftClaimingFolderDraft(identity);
        initialDraftIdentityRef.current = identity;
        initialDraftSnapshotRef.current = snapshot;
        if (snapshot.text) {
            initialDraftRef.current = snapshot.text;
        }
        return createComposerText(snapshot.text);
    });

    // Bumped by every text the app puts into the composer, so the editor
    // writes it even when it equals the `value` it last rendered with.
    const [editorValueRevision, setEditorValueRevision] = React.useState(0);

    // Text the app puts into the composer: a restored draft, a picked command,
    // a cleared send. Typed text reaches `composerText` from the editor.
    const setMessage = React.useCallback((value: string) => {
        if (value === composerText.get()) return;
        composerText.set(value);
        setEditorValueRevision((revision) => revision + 1);
    }, [composerText]);

    const hasText = useComposerTextValue(composerText, (text) => text.trim().length > 0);

    const confirmedMentionsRef = React.useRef<Set<string>>(initialDraftSnapshotRef.current.confirmedMentions);

    const [storedInputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');

    const inputModeParentRef = React.useRef<string | null>(null);
    const currentChatDraftIdentityRef = React.useRef<ChatDraftIdentity | null>(initialDraftIdentityRef.current);

    return {
    initialDraftRef, initialDraftIdentityRef, composerText, editorValueRevision, setEditorValueRevision,
    setMessage, hasText, confirmedMentionsRef, storedInputMode, setInputMode, inputModeParentRef,
    currentChatDraftIdentityRef,
    };
}
