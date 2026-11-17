
import React from 'react';

import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { ComposerDraftControls } from './useComposerDraft';

export interface DictationOriginOptions {
    identityRef: React.RefObject<ChatDraftIdentity | null>;
    restoreDraft: ComposerDraftControls['restoreDraft'];
    onKeptForOrigin?: () => void;
}

export interface DictationOriginControls {
    markDictationStart: () => void;
    keepTranscriptForOrigin: (text: string) => boolean;
}

export function useDictationOrigin(options: DictationOriginOptions): DictationOriginControls {
    const { identityRef, restoreDraft, onKeptForOrigin } = options;
    const originRef = React.useRef<ChatDraftIdentity | null>(null);
    const onKeptForOriginRef = React.useRef(onKeptForOrigin);
    onKeptForOriginRef.current = onKeptForOrigin;

    const markDictationStart = React.useCallback(() => {
        originRef.current = identityRef.current;
    }, [identityRef]);

    const keepTranscriptForOrigin = React.useCallback((text: string) => {
        const origin = originRef.current;
        originRef.current = null;
        if (!origin || !text.trim()) return false;

        const current = identityRef.current;
        if (current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(origin)) return false;

        restoreDraft(origin, text.trim(), new Set());
        onKeptForOriginRef.current?.();
        return true;
    }, [identityRef, restoreDraft]);

    return { markDictationStart, keepTranscriptForOrigin };
}
