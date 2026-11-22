
import React from 'react';

import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { ComposerDraftControls } from './useComposerDraft';

export interface DictationOriginOptions {
    identityRef: React.RefObject<ChatDraftIdentity | null>;
    restoreDraft: ComposerDraftControls['restoreDraft'];
    onKeptForOrigin?: () => void;
}

export type DictationChannel = 'streaming' | 'facade';

export interface DictationOriginControls {
    markDictationStart: (channel?: DictationChannel) => void;
    keepTranscriptForOrigin: (text: string, channel?: DictationChannel) => boolean;
}

export function useDictationOrigin(options: DictationOriginOptions): DictationOriginControls {
    const { identityRef, restoreDraft, onKeptForOrigin } = options;
    const originRefs = React.useRef<Record<DictationChannel, ChatDraftIdentity | null>>({ streaming: null, facade: null });
    const onKeptForOriginRef = React.useRef(onKeptForOrigin);
    onKeptForOriginRef.current = onKeptForOrigin;

    const markDictationStart = React.useCallback((channel: DictationChannel = 'streaming') => {
        originRefs.current[channel] = identityRef.current;
    }, [identityRef]);

    const keepTranscriptForOrigin = React.useCallback((text: string, channel: DictationChannel = 'streaming') => {
        const origin = originRefs.current[channel];
        originRefs.current[channel] = null;
        if (!origin || !text.trim()) return false;

        const current = identityRef.current;
        if (current && getChatDraftIdentityKey(current) === getChatDraftIdentityKey(origin)) return false;

        restoreDraft(origin, text.trim(), new Set());
        onKeptForOriginRef.current?.();
        return true;
    }, [identityRef, restoreDraft]);

    return { markDictationStart, keepTranscriptForOrigin };
}
