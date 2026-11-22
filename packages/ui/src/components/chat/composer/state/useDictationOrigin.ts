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

export type DictationChannel = 'streaming' | 'facade';

export interface DictationOriginControls {
    /**
     * Record the draft a dictation belongs to. Call when recording starts.
     * Each capture path (streaming dictation, facade capture) keeps its OWN
     * origin: the two paths can overlap, and one path's start must never
     * overwrite the other's origin — a transcript is kept for the draft its
     * own path started in, in both directions.
     */
    markDictationStart: (channel?: DictationChannel) => void;
    /**
     * Returns true when the transcript was stored in the originating draft
     * because the composer moved on; the caller must then neither insert nor
     * send it. Returns false when the origin is still the rendered draft.
     */
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
