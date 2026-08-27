// DOM controller for the conversation-seam resize anchor (frame-delta model).
//
// The controller runs INSIDE the same rAF that applies the panel width
// (usePanelResize -> notifyResizeFrame -> registerResizeFrameParticipant), so
// the width write, the real-height read, the one flushSync commit and the one
// scrollTop write all happen before the browser paints.
//
// The anchor model is a PER-FRAME delta against the last COMMITTED frame:
//   anchorDelta = next.anchorDocumentTop - previous.anchorDocumentTop
//   target      = currentScrollTop + anchorDelta
// The first frame's baseline is built from the REAL DOM (flow-start document
// top + mounted-row real heights) — never from the virtualizer cache or a
// fixed estimate. Because the delta is relative to the previous committed
// frame, a +10 growth writes +10 once and the next unchanged frame writes 0;
// there is NO capture-time accumulated baseline to drift.
//
// Release is ONLY user intent (wheel/touch/key), a session switch, the anchor
// key leaving the authoritative entry list, or the composer covering the
// CAPTURED question top. Reaching the scroll bounds CLAMPS the target and
// keeps the transaction active ('clamped') — a reverse drag resumes the same
// anchor automatically.
import React from 'react';
import { flushSync } from 'react-dom';
import {
    getCurrentResizeTransactionId,
    getResizeInteractionPhase,
    registerResizeFrameParticipant,
    registerResizeTransactionStartParticipant,
    subscribeResizeInteraction,
    type ResizeFrameParticipant,
} from '@/lib/resizeInteraction';
import { recordPerformanceTraceEvent } from '@/stores/utils/performanceTrace';
import {
    clampScrollTarget,
    computeAnchorDelta,
    computeTargetScrollTop,
    diffMountedRows,
    initHeldRange,
    type MountedRowInfo,
    type ResizeFrameLayout,
    type ResizeLayoutTransaction,
} from '../lib/conversationResizeLayout';
import {
    isAtBottom,
    selectTurnSeam,
    shouldReleaseByComposer,
    type ConversationSeamAnchor,
    type EffectiveViewport,
    type SeamCandidate,
} from '../lib/conversationResizeAnchor';

type AnchorMode = 'none' | 'bottom' | 'seam';

interface SeamElements {
    flowStart: HTMLElement | null;
    userBubble: HTMLElement | null;
    previousAssistant: HTMLElement | null;
}

interface CandidateWithRefs extends SeamCandidate {
    flowStartEl: HTMLElement;
    userBubbleEl: HTMLElement | null;
    previousAssistantEl: HTMLElement | null;
}

/** Structural slice of the virtualizer the seam controller needs. */
interface SeamVirtualizer {
    itemSizeCache: Map<unknown, number>;
    resizeItem: (index: number, height: number) => void;
}

export interface UseConversationResizeAnchorOptions {
    /** The chat scroll container element. */
    scrollerRef: React.RefObject<HTMLDivElement | null>;
    /** The MessageList root element used to query turn markers + rows. */
    containerRef: React.RefObject<HTMLDivElement | null>;
    /** True while auto-follow is pinned (real bottom-following). */
    isPinned: boolean;
    /** Session key — a change releases any active anchor. */
    sessionKey: string | null;
    /** The TanStack virtualizer (may be null for short lists). */
    virtualizerRef: React.RefObject<SeamVirtualizer | null>;
    /** Held contiguous virtual range for the transaction (unconditionally
     *  seeded on capture, cleared at idle) — the list's rangeExtractor merges
     *  it monotonically. */
    heldRangeRef: React.RefObject<{ start: number; end: number } | null>;
    /** The AUTHORITATIVE full entry key sequence (render entries, including
     *  any streaming tail) — refreshed every render. */
    entryKeysRef: React.RefObject<readonly string[]>;
}

const RESIZE_BOTTOM_THRESHOLD_PX = 24;
const HEIGHT_CHANGE_TOLERANCE_PX = 0.5;
const SCROLL_WRITE_TOLERANCE_PX = 0.25;

export const useConversationResizeAnchor = ({
    scrollerRef,
    containerRef,
    isPinned,
    sessionKey,
    virtualizerRef,
    heldRangeRef,
    entryKeysRef,
}: UseConversationResizeAnchorOptions): void => {
    const modeRef = React.useRef<AnchorMode>('none');
    const txRef = React.useRef<ResizeLayoutTransaction | null>(null);
    const seamRef = React.useRef<ConversationSeamAnchor | null>(null);
    const seamElementsRef = React.useRef<SeamElements>({ flowStart: null, userBubble: null, previousAssistant: null });
    const bottomDistanceRef = React.useRef(0);
    const scrollWriteCountRef = React.useRef(0);
    const isPinnedRef = React.useRef(isPinned);
    isPinnedRef.current = isPinned;
    const sessionKeyRef = React.useRef(sessionKey);
    sessionKeyRef.current = sessionKey;
    const containerRefRef = React.useRef(containerRef);
    containerRefRef.current = containerRef;
    const virtualizerRefRef = React.useRef(virtualizerRef);
    virtualizerRefRef.current = virtualizerRef;
    const heldRangeRefRef = React.useRef(heldRangeRef);
    heldRangeRefRef.current = heldRangeRef;
    const entryKeysRefRef = React.useRef(entryKeysRef);
    entryKeysRefRef.current = entryKeysRef;

    const resizePhase = React.useSyncExternalStore(
        subscribeResizeInteraction,
        getResizeInteractionPhase,
        getResizeInteractionPhase,
    );

    const readEffectiveViewport = React.useCallback((scroller: HTMLElement): EffectiveViewport => {
        const scrollerRect = scroller.getBoundingClientRect();
        const composer = document.querySelector<HTMLElement>('[data-chat-composer-occlusion]');
        const composerTop = composer ? composer.getBoundingClientRect().top : null;
        const bottom = composerTop !== null && composerTop < scrollerRect.bottom
            ? composerTop
            : scrollerRect.bottom;
        return { top: scrollerRect.top, bottom };
    }, []);

    /** Document top of an element: flowStartRect.top - scrollerRect.top + scrollTop. */
    const documentTopOf = React.useCallback((element: HTMLElement, scroller: HTMLElement): number => {
        const rect = element.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        return rect.top - scrollerRect.top + scroller.scrollTop;
    }, []);

    const readCandidates = React.useCallback((): CandidateWithRefs[] => {
        const container = containerRefRef.current?.current;
        if (!container) {
            return [];
        }
        const flowStarts = container.querySelectorAll<HTMLElement>('[data-chat-turn-flow-start]');
        const candidates: CandidateWithRefs[] = [];
        let previousAssistantEl: HTMLElement | null = null;
        for (const flowStart of Array.from(flowStarts)) {
            const turnRoot = flowStart.parentElement;
            if (!turnRoot) {
                continue;
            }
            const key = turnRoot.closest<HTMLElement>('[data-turn-entry]')?.getAttribute('data-turn-entry')
                ?? turnRoot.getAttribute('data-turn-id')
                ?? '';
            if (!key) {
                continue;
            }
            const rowEl = turnRoot.closest<HTMLElement>('[data-chat-resize-row]');
            const rowIndex = rowEl ? Number(rowEl.getAttribute('data-index') ?? -1) : 0;
            const flowTop = flowStart.getBoundingClientRect().top;
            const bubble = turnRoot.querySelector<HTMLElement>('[data-chat-user-bubble]');
            const bubbleRect = bubble ? {
                top: bubble.getBoundingClientRect().top,
                bottom: bubble.getBoundingClientRect().bottom,
            } : undefined;
            const previousRect = previousAssistantEl ? {
                top: previousAssistantEl.getBoundingClientRect().top,
                bottom: previousAssistantEl.getBoundingClientRect().bottom,
            } : undefined;
            candidates.push({
                key,
                rowIndex,
                flowTop,
                userBubble: bubbleRect,
                previousAssistant: previousRect,
                flowStartEl: flowStart,
                userBubbleEl: bubble ?? null,
                previousAssistantEl,
            });
            const assistant = turnRoot.querySelector<HTMLElement>('[data-chat-assistant-block]');
            previousAssistantEl = assistant ?? previousAssistantEl;
        }
        return candidates;
    }, []);

    /** Build the first frame layout from the REAL DOM (never cache/estimate). */
    const readFrameLayout = React.useCallback((
        scroller: HTMLElement,
        anchorKey: string,
        flowStartEl: HTMLElement | null,
    ): ResizeFrameLayout => {
        const container = containerRefRef.current?.current;
        const mountedRows = new Map<string, MountedRowInfo>();
        let mountedStart: number | null = null;
        let mountedEnd: number | null = null;
        if (container) {
            for (const rowEl of Array.from(container.querySelectorAll<HTMLElement>('[data-chat-resize-row]'))) {
                const key = rowEl.getAttribute('data-turn-entry');
                if (!key) {
                    continue;
                }
                const rawIndex = rowEl.getAttribute('data-index');
                const virtualIndex = rawIndex !== null && rawIndex !== '' && Number.isFinite(Number(rawIndex))
                    ? Number(rawIndex)
                    : null;
                const height = Math.round(rowEl.offsetHeight);
                if (height > 0) {
                    mountedRows.set(key, { key, virtualIndex, height });
                    if (virtualIndex !== null) {
                        mountedStart = mountedStart === null ? virtualIndex : Math.min(mountedStart, virtualIndex);
                        mountedEnd = mountedEnd === null ? virtualIndex : Math.max(mountedEnd, virtualIndex);
                    }
                }
            }
        }
        const anchorDocumentTop = flowStartEl
            ? documentTopOf(flowStartEl, scroller)
            : 0;
        return { anchorKey, anchorDocumentTop, mountedRows, mountedStart, mountedEnd };
    }, [documentTopOf]);

    const capture = React.useCallback(() => {
        const scroller = scrollerRef.current;
        if (!scroller) {
            modeRef.current = 'none';
            return;
        }
        const viewport = readEffectiveViewport(scroller);
        const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (isPinnedRef.current && isAtBottom(distanceFromBottom, RESIZE_BOTTOM_THRESHOLD_PX)) {
            modeRef.current = 'bottom';
            bottomDistanceRef.current = Math.max(0, distanceFromBottom);
            txRef.current = null;
            seamRef.current = null;
            recordPerformanceTraceEvent('ui.message_list.anchor_capture', { mode: 'bottom', distanceFromBottom }, 0, undefined);
            return;
        }
        const candidates = readCandidates();
        const selected = selectTurnSeam(candidates, viewport);
        if (!selected) {
            modeRef.current = 'none';
            txRef.current = null;
            seamRef.current = null;
            recordPerformanceTraceEvent('ui.message_list.anchor_capture', { mode: 'none', distanceFromBottom }, 0, undefined);
            return;
        }
        const matched = candidates.find((c) => c.key === selected.key) ?? null;
        seamElementsRef.current = {
            flowStart: matched?.flowStartEl ?? null,
            userBubble: matched?.userBubbleEl ?? null,
            previousAssistant: matched?.previousAssistantEl ?? null,
        };
        seamRef.current = selected;
        const anchorIndex = matched?.rowIndex ?? null;
        // First frame layout from the REAL DOM (the baseline).
        const firstLayout = readFrameLayout(scroller, selected.key, matched?.flowStartEl ?? null);
        txRef.current = {
            transactionId: getCurrentResizeTransactionId() ?? 0,
            anchorKey: selected.key,
            anchorVirtualIndex: anchorIndex,
            capturedViewportTop: selected.capturedFlowViewportTop,
            previousLayout: firstLayout,
            state: 'active',
        };
        // Held range: UNCONDITIONALLY seed = mounted indexes ∪ anchor window.
        const mountedIndexes = Array.from(firstLayout.mountedRows.values())
            .map((r) => r.virtualIndex)
            .filter((i): i is number => i !== null);
        if (heldRangeRefRef.current) {
            heldRangeRefRef.current.current = initHeldRange(mountedIndexes, anchorIndex);
        }
        modeRef.current = 'seam';
        recordPerformanceTraceEvent(
            'ui.message_list.anchor_capture',
            {
                mode: 'seam',
                key: selected.key,
                index: anchorIndex ?? undefined,
                flowTop: selected.capturedFlowViewportTop,
                bubbleOffsetFromFlow: selected.bubbleOffsetFromFlow,
                previousAssistantGap: selected.previousAssistantGap ?? undefined,
                heldStart: heldRangeRefRef.current?.current?.start,
                heldEnd: heldRangeRefRef.current?.current?.end,
            },
            0,
            undefined,
        );
    }, [readCandidates, readEffectiveViewport, readFrameLayout, scrollerRef]);

    const releaseToNone = React.useCallback((reason: string) => {
        modeRef.current = 'none';
        txRef.current = null;
        seamRef.current = null;
        seamElementsRef.current = { flowStart: null, userBubble: null, previousAssistant: null };
        if (heldRangeRefRef.current) {
            heldRangeRefRef.current.current = null;
        }
        recordPerformanceTraceEvent('ui.message_list.anchor_release', { reason }, 0, undefined);
    }, []);

    const writeScrollTop = React.useCallback((target: number) => {
        const scroller = scrollerRef.current;
        if (!scroller) {
            return;
        }
        if (Math.abs(scroller.scrollTop - target) <= SCROLL_WRITE_TOLERANCE_PX) {
            return;
        }
        scroller.scrollTop = target;
        scrollWriteCountRef.current += 1;
    }, [scrollerRef]);

    // The SAME-FRAME entry point: invoked from usePanelResize's rAF right
    // after the width write, before paint. Delta is relative to the last
    // COMMITTED frame; frames from stale transactions are ignored.
    const onResizeWidthFrame: ResizeFrameParticipant = React.useCallback((frame) => {
        const scroller = scrollerRef.current;
        const container = containerRefRef.current?.current;
        if (!scroller || !container) {
            return;
        }
        if (modeRef.current === 'none') {
            return; // Zero-write invariant.
        }
        if (modeRef.current === 'bottom') {
            const target = scroller.scrollHeight - scroller.clientHeight - bottomDistanceRef.current;
            writeScrollTop(target);
            return;
        }
        const tx = txRef.current;
        if (!tx || tx.transactionId !== frame.transactionId) {
            return; // Stale transaction frame.
        }
        // Dedupe by frameSequence (never by width — two panels can share a
        // width value and would otherwise lose frames).
        if (tx.lastFrameSequence !== undefined && frame.frameSequence <= tx.lastFrameSequence) {
            return; // Already processed this frame.
        }
        tx.lastFrameSequence = frame.frameSequence;

        // Release checks INDEPENDENT of the uncorrected geometry.
        const composer = document.querySelector<HTMLElement>('[data-chat-composer-occlusion]');
        const composerTop = composer ? composer.getBoundingClientRect().top : null;
        const seam = seamRef.current;
        if (seam) {
            const capturedBubbleTop = seam.capturedFlowViewportTop + seam.bubbleOffsetFromFlow;
            if (shouldReleaseByComposer(capturedBubbleTop, composerTop)) {
                releaseToNone('composer-occlusion');
                return;
            }
        }
        const authoritativeKeys = entryKeysRefRef.current?.current ?? [];
        if (!authoritativeKeys.includes(tx.anchorKey)) {
            releaseToNone('anchor-key-removed');
            return;
        }

        // 1. Real mounted-row heights of THIS frame.
        const nextLayout = readFrameLayout(scroller, tx.anchorKey, seamElementsRef.current.flowStart);
        // 2. Compare with the previous committed frame; no real change -> zero
        //    commit, zero flushSync, zero scrollTop write.
        const changed = diffMountedRows(tx.previousLayout, nextLayout, HEIGHT_CHANGE_TOLERANCE_PX);
        const changedRealRowCount = changed.length;
        let cacheCommitRowCount = 0;
        let flushSyncDelta = 0;
        let anchorDelta = 0;
        if (changedRealRowCount > 0) {
            // 3. Commit only rows that changed AND belong to the virtual history.
            const virtualizer = virtualizerRefRef.current?.current;
            if (virtualizer) {
                const changedSet = new Set(changed);
                const changedRows: Array<{ index: number; height: number }> = [];
                for (const info of nextLayout.mountedRows.values()) {
                    if (info.virtualIndex !== null && changedSet.has(info.key)) {
                        changedRows.push({ index: info.virtualIndex, height: info.height });
                    }
                }
                if (changedRows.length > 0) {
                    flushSyncDelta = 1;
                    cacheCommitRowCount = changedRows.length;
                    flushSync(() => {
                        for (const row of changedRows) {
                            virtualizer.resizeItem(row.index, row.height);
                        }
                    });
                }
            }
            // 4. After the commit, re-resolve the same stable key's flow start
            //    and read the FINAL anchor document top.
            const flowStart = seamElementsRef.current.flowStart;
            const nextDocumentTop = flowStart
                ? documentTopOf(flowStart, scroller)
                : nextLayout.anchorDocumentTop;
            // 5. Delta vs the previous committed frame; clamp at the scroll
            //    bounds (state 'clamped', NOT a release).
            anchorDelta = computeAnchorDelta({ ...nextLayout, anchorDocumentTop: nextDocumentTop }, tx.previousLayout);
            if (Math.abs(anchorDelta) > SCROLL_WRITE_TOLERANCE_PX) {
                const { target, clamped } = clampScrollTarget(
                    computeTargetScrollTop(scroller.scrollTop, anchorDelta),
                    scroller.scrollHeight,
                    scroller.clientHeight,
                );
                if (clamped) {
                    tx.state = 'clamped';
                } else if (tx.state === 'clamped') {
                    tx.state = 'active'; // Reverse drag resumed into the feasible area.
                }
                writeScrollTop(target);
            }
            // 6. Commit this frame as the new baseline.
            tx.previousLayout = { ...nextLayout, anchorDocumentTop: nextDocumentTop };
        }
        // Per-frame diagnostics (acceptance hard invariants).
        recordPerformanceTraceEvent(
            'ui.message_list.anchor_frame',
            {
                anchorMode: 'seam',
                anchorKey: tx.anchorKey,
                changedRealRowCount,
                cacheCommitRowCount,
                anchorDelta: Math.round(anchorDelta * 10) / 10,
                flushSyncDelta,
                clamped: tx.state === 'clamped',
                heldStart: heldRangeRefRef.current?.current?.start,
                heldEnd: heldRangeRefRef.current?.current?.end,
                mountedRowCount: nextLayout.mountedRows.size,
            },
            0,
            undefined,
        );
    }, [documentTopOf, entryKeysRefRef, readFrameLayout, releaseToNone, scrollerRef, writeScrollTop]);

    // Same-frame participant registration (the ONLY scroll-adjustment entry).
    React.useEffect(() => {
        const unsubscribe = registerResizeFrameParticipant(onResizeWidthFrame);
        return unsubscribe;
    }, [onResizeWidthFrame]);

    // Synchronous transaction-start participant: capture runs at BEGIN (before
    // the first width frame of a pointer drag OR a programmatic animation),
    // so a quick open/close toggle's first animated width lands on an
    // already-anchored baseline. Joining sources do not re-fire.
    React.useEffect(() => {
        const unsubscribe = registerResizeTransactionStartParticipant(() => {
            scrollWriteCountRef.current = 0;
            capture();
        });
        return unsubscribe;
    }, [capture]);

    // Transaction lifecycle driven by the PHASE: only the IDLE edge resets
    // state (capture itself is handled by the synchronous start participant).
    const lastPhaseRef = React.useRef(resizePhase);
    React.useLayoutEffect(() => {
        lastPhaseRef.current = resizePhase;
        if (resizePhase === 'idle') {
            modeRef.current = 'none';
            txRef.current = null;
            seamRef.current = null;
            seamElementsRef.current = { flowStart: null, userBubble: null, previousAssistant: null };
            if (heldRangeRefRef.current) {
                heldRangeRefRef.current.current = null;
            }
        }
    }, [resizePhase]);

    // Session switch releases any active anchor.
    const lastSessionKeyRef = React.useRef(sessionKey);
    React.useEffect(() => {
        if (lastSessionKeyRef.current !== sessionKey) {
            lastSessionKeyRef.current = sessionKey;
            if (resizePhase !== 'idle' && modeRef.current !== 'none') {
                releaseToNone('session-switch');
            }
        }
    }, [releaseToNone, resizePhase, sessionKey]);

    // User intent (wheel/touch/key) releases the anchor; plain scroll events
    // never infer user intent (they only confirm programmatic writes).
    React.useEffect(() => {
        const scroller = scrollerRef.current;
        if (!scroller) {
            return;
        }
        const handleUserIntent = () => {
            if (resizePhase !== 'idle' && modeRef.current !== 'none') {
                releaseToNone('user-intent');
            }
        };
        scroller.addEventListener('wheel', handleUserIntent, { passive: true });
        scroller.addEventListener('touchstart', handleUserIntent, { passive: true });
        scroller.addEventListener('keydown', handleUserIntent);
        return () => {
            scroller.removeEventListener('wheel', handleUserIntent);
            scroller.removeEventListener('touchstart', handleUserIntent);
            scroller.removeEventListener('keydown', handleUserIntent);
        };
    }, [releaseToNone, resizePhase, scrollerRef]);

    // Post-commit diagnostics: anchor DOM presence (re-resolve by key; a
    // missing DOM while the key still exists is a hard error that must NOT
    // switch turns or degrade the anchor).
    React.useEffect(() => {
        if (resizePhase === 'idle' || modeRef.current !== 'seam') {
            return;
        }
        const flowStart = seamElementsRef.current.flowStart;
        if (flowStart && !flowStart.isConnected) {
            const container = containerRefRef.current?.current;
            const tx = txRef.current;
            if (container && tx) {
                const re = container.querySelector<HTMLElement>(`[data-chat-resize-row][data-turn-entry="${CSS.escape(tx.anchorKey)}"]`)
                    ?? container.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(tx.anchorKey)}"]`);
                if (re) {
                    seamElementsRef.current.flowStart = re.querySelector('[data-chat-turn-flow-start]') ?? null;
                    seamElementsRef.current.userBubble = re.querySelector('[data-chat-user-bubble]') ?? null;
                    seamElementsRef.current.previousAssistant = re.querySelector('[data-chat-assistant-block]') ?? null;
                    recordPerformanceTraceEvent('ui.message_list.anchor_dom_missing', { key: tx.anchorKey, recovered: true }, 0, undefined);
                } else {
                    recordPerformanceTraceEvent('ui.message_list.anchor_dom_missing', { key: tx.anchorKey, recovered: false }, 0, undefined);
                }
            }
        }
    }, [resizePhase]);
};
