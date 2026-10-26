import { useEffect, useRef } from 'react';

import { claimReplyForAutoRead } from '@/lib/messages/autoReadClaims';
import type { LatestReply } from '@/lib/messages/latestReply';

export interface AutoReadAloudOptions {
    /** Identity of the session on screen; a switch starts a new baseline. */
    sessionKey: string;
    /** The session's message history is loaded for this session. */
    ready: boolean;
    /** The session is running a turn, permission prompts included. */
    sessionIsActive: boolean;
    /** Newest completed answer in the session, or null when there is none. */
    reply: LatestReply | null;
    enabled: boolean;
    play: (text: string) => Promise<void>;
    /** Claims a reply across windows so only one of them reads it. */
    claim?: (messageId: string) => Promise<boolean>;
}

/**
 * Reads the newest completed answer after a turn that this surface watched
 * run. History present when a session opens is recorded as the baseline so
 * opening a conversation never starts playback.
 */
export const useAutoReadAloud = ({
    sessionKey,
    ready,
    sessionIsActive,
    reply,
    enabled,
    play,
    claim = claimReplyForAutoRead,
}: AutoReadAloudOptions): void => {
    const activeSessionKeyRef = useRef<string | null>(null);
    const observedActiveRef = useRef(false);
    const initializedRef = useRef(false);
    const latestReplyIdRef = useRef<string | null>(null);
    // Every id this surface has already read, plus the baseline. Reverting a
    // turn makes an older answer the latest reply again, and that answer must
    // not be read a second time.
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
    }, [claim, enabled, play, ready, reply, sessionIsActive, sessionKey]);
};
