import React from 'react';

import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { ComposerDraftControls } from './useComposerDraft';

export type DictationOrigin = { newSessionDraftId: number | null; identity: ChatDraftIdentity | null };

export interface DictationOriginOptions {
    originRef: React.RefObject<DictationOrigin | null>;
    newSessionDraftId: number | null;
    identity: ChatDraftIdentity | null;
    restoreDraft: ComposerDraftControls['restoreDraft'];
    onKeptForOrigin?: () => void;
}

export interface DictationOriginControls {
    markDictationStart: () => void;
    markDictationSendConfirmed: () => void;
    keepTranscriptForOrigin: (text: string) => boolean;
    hasSendTargetMoved: () => boolean;
}

const isSameIdentity = (left: ChatDraftIdentity, right: ChatDraftIdentity | null): boolean => (
    right !== null && getChatDraftIdentityKey(left) === getChatDraftIdentityKey(right)
);

const isSameNewSessionDraft = (origin: DictationOrigin, current: DictationOrigin): boolean => (
    origin.newSessionDraftId !== null
    && origin.newSessionDraftId === current.newSessionDraftId
    && origin.identity?.runtimeKey === current.identity?.runtimeKey
);

export function followMovedNewSessionDraft(originRef: React.RefObject<DictationOrigin | null>, moved: DictationOrigin): void {
    if (originRef.current && isSameNewSessionDraft(originRef.current, moved)) originRef.current = moved;
}

export function useDictationOrigin(options: DictationOriginOptions): DictationOriginControls {
    const { originRef, newSessionDraftId, identity, restoreDraft, onKeptForOrigin } = options;
    const sendTargetRef = React.useRef<{ origin: DictationOrigin | null; identity: ChatDraftIdentity } | null>(null);
    const onKeptForOriginRef = React.useRef(onKeptForOrigin);
    onKeptForOriginRef.current = onKeptForOrigin;

    const markDictationStart = React.useCallback(() => {
        originRef.current = { newSessionDraftId, identity };
        sendTargetRef.current = null;
    }, [identity, newSessionDraftId, originRef]);

    const markDictationSendConfirmed = React.useCallback(() => {
        sendTargetRef.current = identity && { origin: originRef.current, identity };
    }, [identity, originRef]);

    const keepTranscriptForOrigin = React.useCallback((text: string) => {
        const origin = originRef.current;
        originRef.current = null;
        if (!origin?.identity || !text.trim()) return false;

        if (isSameNewSessionDraft(origin, { newSessionDraftId, identity })) return false;
        if (isSameIdentity(origin.identity, identity)) return false;

        restoreDraft(origin.identity, text.trim(), new Set());
        onKeptForOriginRef.current?.();
        return true;
    }, [identity, newSessionDraftId, originRef, restoreDraft]);

    const hasSendTargetMoved = React.useCallback(() => (
        sendTargetRef.current !== null
        && (sendTargetRef.current.origin !== originRef.current || !isSameIdentity(sendTargetRef.current.identity, identity))
    ), [identity, originRef]);

    return { markDictationStart, markDictationSendConfirmed, keepTranscriptForOrigin, hasSendTargetMoved };
}
