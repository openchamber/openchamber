import { useEffect, useRef } from 'react';

import { claimReplyForAutoRead } from '@/lib/messages/autoReadClaims';
import { findCompletedReplyIds, type LatestReply, type LatestReplyRecord } from '@/lib/messages/latestReply';

export interface AutoReadAloudOptions {
    /** Identity of the session on screen; a switch starts a new baseline. */
    sessionKey: string;
    /** The session's message history is loaded for this session. */
    ready: boolean;
    /** The session is running a turn, permission prompts included. */
    sessionIsActive: boolean;
    /** Newest completed answer in the session, or null when there is none. */
    reply: LatestReply | null;
    /** Loaded session history; every finished answer in it belongs to the baseline. */
    history: readonly LatestReplyRecord[];
    enabled: boolean;
    play: (text: string) => Promise<void>;
    /** Claims a reply across windows so only one of them reads it. */
    claim?: (messageId: string) => Promise<boolean>;
}

/**
 * Reads the newest completed answer after a turn that this surface watched
 * run. Every finished answer present when a session opens is recorded as the
 * baseline, so opening a conversation never starts playback and trimming back
 * to an older answer does not read it for the first time.
 */
export const useAutoReadAloud = ({
    sessionKey,
    ready,
    sessionIsActive,
    reply,
    history,
    enabled,
    play,
    claim = claimReplyForAutoRead,
}: AutoReadAloudOptions): void => {
    const activeSessionKeyRef = useRef<string | null>(null);
    const observedActiveRef = useRef(false);
    const initializedRef = useRef(false);
    const latestReplyIdRef = useRef<string | null>(null);
    // Every id this surface has already read, plus every answer present at
    // the baseline. Reverting or trimming a turn makes an older answer the
    // latest reply again, and it must not be read as if it just finished.
    const heardReplyIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (activeSessionKeyRef.current !== sessionKey) {
            activeSessionKeyRef.current = sessionKey;
            observedActiveRef.current = sessionIsActive;
            initializedRef.current = false;
            latestReplyIdRef.current = null;
            heardReplyIdsRef.current = new Set();
        } else if (sessionIsActive) {
            observedActiveRef.current = true;
        }

        if (!ready) return;

        if (!initializedRef.current) {
            initializedRef.current = true;
            latestReplyIdRef.current = reply?.messageId ?? null;
            heardReplyIdsRef.current = new Set(findCompletedReplyIds(history));
            if (reply) heardReplyIdsRef.current.add(reply.messageId);
            return;
        }

        if (!reply || reply.messageId === latestReplyIdRef.current) return;

        latestReplyIdRef.current = reply.messageId;
        if (!enabled || !observedActiveRef.current || heardReplyIdsRef.current.has(reply.messageId)) {
            return;
        }

        heardReplyIdsRef.current.add(reply.messageId);
        const { messageId, text } = reply;
        void claim(messageId).then((claimed) => {
            if (claimed) void play(text);
        });
    }, [claim, enabled, history, play, ready, reply, sessionIsActive, sessionKey]);
};
