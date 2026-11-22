import { useEffect, useRef } from 'react';

import { claimReplyForAutoRead } from '@/lib/messages/autoReadClaims';
import { findCompletedReplyIds, type LatestReply, type LatestReplyRecord } from '@/lib/messages/latestReply';
import { isCapacitorApp } from '@/lib/platform';
import type { PlayMessageTTSOptions } from './useMessageTTS';

export interface AutoReadAloudOptions {
    sessionKey: string;
    ready: boolean;
    sessionIsActive: boolean;
    reply: LatestReply | null;
    history: readonly LatestReplyRecord[];
    olderCompletedReplyIds: ReadonlySet<string>;
    enabled: boolean;
    play: (text: string, options?: PlayMessageTTSOptions) => Promise<void>;
    claim?: (messageId: string) => Promise<boolean>;
}

export const useAutoReadAloud = ({
    sessionKey,
    ready,
    sessionIsActive,
    reply,
    history,
    olderCompletedReplyIds,
    enabled,
    play,
    claim = claimReplyForAutoRead,
}: AutoReadAloudOptions): void => {
    const activeSessionKeyRef = useRef<string | null>(null);
    const observedActiveRef = useRef(false);
    const initializedRef = useRef(false);
    const latestReplyIdRef = useRef<string | null>(null);
    const heardReplyIdsRef = useRef<Set<string>>(new Set());
    const nativeMobile = isCapacitorApp();
    const foregroundRef = useRef(!nativeMobile);
    const backgroundEpochRef = useRef(0);
    const currentRef = useRef({ sessionKey, enabled, reply });
    currentRef.current = { sessionKey, enabled, reply };

    useEffect(() => {
        if (!enabled) backgroundEpochRef.current += 1;
    }, [enabled]);

    useEffect(() => {
        let disposed = false;
        let removeNativeListener: (() => void) | undefined;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') backgroundEpochRef.current += 1;
        };
        if (nativeMobile) {
            document.addEventListener('visibilitychange', onVisibility);
            void import('@capacitor/app').then(async ({ App }) => {
                let stateChanged = false;
                const listener = await App.addListener('appStateChange', ({ isActive }) => {
                    stateChanged = true;
                    foregroundRef.current = isActive;
                    if (!isActive) backgroundEpochRef.current += 1;
                });
                if (disposed) {
                    void listener.remove();
                    return;
                }
                removeNativeListener = () => void listener.remove();
                const state = await App.getState();
                if (!disposed && !stateChanged) foregroundRef.current = state.isActive;
            }).catch(() => {
                foregroundRef.current = false;
            });
        }
        return () => {
            disposed = true;
            backgroundEpochRef.current += 1;
            if (nativeMobile) document.removeEventListener('visibilitychange', onVisibility);
            removeNativeListener?.();
        };
    }, [nativeMobile]);

    useEffect(() => {
        if (activeSessionKeyRef.current !== sessionKey) {
            backgroundEpochRef.current += 1;
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
        if (!enabled || !observedActiveRef.current || heardReplyIdsRef.current.has(reply.messageId) || olderCompletedReplyIds.has(reply.messageId)) {
            return;
        }

        heardReplyIdsRef.current.add(reply.messageId);
        const { messageId, text } = reply;
        const epoch = backgroundEpochRef.current;
        const canStart = () => (!nativeMobile || (foregroundRef.current && document.visibilityState !== 'hidden'))
            && backgroundEpochRef.current === epoch
            && currentRef.current.enabled
            && currentRef.current.sessionKey === sessionKey
            && currentRef.current.reply?.messageId === messageId;
        if (!canStart()) return;
        void claim(messageId).then((claimed) => {
            if (claimed && canStart()) void play(text, { canStart });
        }).catch((error) => console.warn('[useAutoReadAloud] Claim failed:', error));
    }, [claim, enabled, history, olderCompletedReplyIds, nativeMobile, play, ready, reply, sessionIsActive, sessionKey]);
};
