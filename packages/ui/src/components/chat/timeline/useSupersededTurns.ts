import React from 'react';

import { isOperatorChildSession } from '@/lib/sessionOperatorChild';
import { useSurfaceAttention } from '@/hooks/useSurfaceAttention';
import { isSurfaceAttended } from '@/lib/surfaceAttention';
import { endSessionVisit, readVisitBaseline } from '@/sync/session-unread';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { planExchanges } from '../lib/turns/exchanges';
import type { SupersededTurns } from '../lib/turns/timelineRows';
import type { RenderEntry } from './types';

const isTurnHeld = (turnId: string): boolean => {
    const selection = document.getSelection();
    const anchor = selection && !selection.isCollapsed ? selection.anchorNode : null;
    const rows = document.querySelectorAll(`[data-turn-row="${CSS.escape(turnId)}"]`);
    return [...rows].some((row) => (anchor !== null && row.contains(anchor)) || row.querySelector('textarea, [contenteditable="true"]') !== null);
};

export const useSupersededTurns = (sessionKey: string, entries: readonly RenderEntry[]): SupersededTurns => {
    const sessionPromptsAreOwn = useGlobalSessionsStore((state) => isOperatorChildSession(state.entityById.get(sessionKey)));
    const plan = React.useMemo(() => planExchanges(entries, sessionPromptsAreOwn), [entries, sessionPromptsAreOwn]);
    const [visit, setVisit] = React.useState(0);
    const witnessedRef = React.useRef({ sessionKey, turnIds: new Set<string>() });
    if (witnessedRef.current.sessionKey !== sessionKey) witnessedRef.current = { sessionKey, turnIds: new Set() };
    const baselineRef = React.useRef<{ sessionKey: string; visit: number; viewed: number | undefined } | null>(null);
    if (baselineRef.current?.sessionKey !== sessionKey || baselineRef.current.visit !== visit) {
        baselineRef.current = { sessionKey, visit, viewed: readVisitBaseline(sessionKey) };
    }

    const leftRef = React.useRef(false);
    useSurfaceAttention(sessionKey, (attended) => {
        if (!attended) {
            const { turnIds } = witnessedRef.current;
            for (const turnId of turnIds) if (!isTurnHeld(turnId)) turnIds.delete(turnId);
            endSessionVisit(sessionKey);
            setVisit((current) => current + 1);
            return;
        }
        queueMicrotask(() => setVisit((current) => current + 1));
    }, () => {
        if (!leftRef.current) return;
        leftRef.current = false;
        setVisit((current) => current + 1);
    }, () => {
        leftRef.current = true;
        witnessedRef.current.turnIds.clear();
        endSessionVisit(sessionKey);
    });

    const keepEarlierReplies = useUIStore((state) => state.keepEarlierReplies);
    const previousRef = React.useRef<SupersededTurns | null>(null);
    return React.useMemo(() => {
        const witnessed = witnessedRef.current.turnIds;
        const folded = new Set<string>();
        for (const [turnId, { exchangeId }] of keepEarlierReplies ? [] : plan.superseded) {
            const keepOpen = witnessed.has(turnId) && (exchangeId === plan.latestExchangeId || isTurnHeld(turnId));
            if (!keepOpen) folded.add(turnId);
        }
        if (isSurfaceAttended()) {
            for (const turnId of plan.turnIds) if (!plan.superseded.has(turnId)) witnessed.add(turnId);
        }
        const unreadSince = baselineRef.current?.viewed;
        const previous = previousRef.current;
        if (previous && previous.plan === plan && previous.unreadSince === unreadSince
            && previous.folded.size === folded.size && [...folded].every((turnId) => previous.folded.has(turnId))) return previous;
        const next = { plan, folded, unreadSince };
        previousRef.current = next;
        return next;
    }, [keepEarlierReplies, plan, visit]); // oxlint-disable-line react-hooks/exhaustive-deps -- visit re-evaluates the refs
};
