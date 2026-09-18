/**
 * Keeps a dictation transcript with the draft it was started in.
 *
 * One composer stays mounted across session switches, and a transcript only
 * arrives after the recording is confirmed and transcribed. A switch inside
 * that window used to insert — or send — the transcript in whichever session
 * was on screen when it landed. The origin is recorded when recording starts;
 * a transcript whose origin is no longer the rendered draft is appended to the
 * origin's draft instead and never reaches the visible composer.
 */

import React from 'react';

import { getChatDraftIdentityKey, type ChatDraftIdentity } from '@/lib/chatDraftPersistence';
import type { ComposerDraftControls } from './useComposerDraft';

export interface DictationOriginOptions {
    /** The draft identity of the rendered composer. */
    identityRef: React.RefObject<ChatDraftIdentity | null>;
    restoreDraft: ComposerDraftControls['restoreDraft'];
    /** Called after a transcript was kept for a draft that is not on screen. */
    onKeptForOrigin?: () => void;
}

export interface DictationOriginControls {
    /** Record the draft a dictation belongs to. Call when recording starts. */
    markDictationStart: () => void;
    /**
     * Returns true when the transcript was stored in the originating draft
     * because the composer moved on; the caller must then neither insert nor
     * send it. Returns false when the origin is still the rendered draft.
     */
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
