import React from 'react';
import {
    beginResizeInteraction,
    cancelResizeInteraction,
    getResizeInteractionPhase,
    notifyResizeFrame,
    releaseResizeInteraction,
    subscribeResizeInteraction,
    type ResizeInteractionSource,
    type ResizeOrigin,
} from '@/lib/resizeInteraction';
import {
    recordPerformanceTraceEvent,
    startPerformanceTraceSpan,
    type PerformanceTraceSpan,
} from '@/stores/utils/performanceTrace';

/**
 * Shared panel/column drag-resize lifecycle for the Sidebar, the ContextPanel
 * and its file-tree column.
 *
 * Responsibilities (see the resize plan):
 * - ONE geometry writer: this hook is the ONLY module that writes the panel
 *   width (the CSS variable and/or element width). React re-renders never
 *   write the width; consumers keep the root at a fixed structure (`flex:
 *   none`, width reads `var(--...)`) and let the hook interpolate. At most one
 *   width write happens per animation frame.
 * - Unified target resolution: `programmaticTarget { key, width, cause }`.
 *   `width === 0` is a legal close target and is NOT min-clamped; only
 *   positive widths are clamped to minWidth/maxWidth/available. `visibility`
 *   and `mode` transitions animate once (200ms); `parent-layout` updates
 *   FOLLOW the available area per frame WITHOUT restarting an animation clock
 *   (and with no transaction open they open a short one to apply the change in
 *   the same frame as the anchor capture); `prefers-reduced-motion` resolves
 *   in a single frame through the SAME transaction.
 * - Persistence: `onUserCommitWidth` runs EXACTLY once, on pointerup, and
 *   persists the manual width into user settings. Programmatic open/close,
 *   mode switches and parent-layout follows NEVER persist — they only update
 *   the applied DOM width (manual-resize flags and per-mode widths stay
 *   untouched).
 * - Concurrent operations: a semantic target change mid-drag hands the pointer
 *   ownership over to the programmatic path WITHOUT releasing the global
 *   transaction (the same anchor capture continues) and animates from the
 *   CURRENT applied width; the target is never marked handled before it is
 *   actually executed. A pointerdown mid-animation stops the animation and
 *   hands over seamlessly from the current width (same transaction).
 * - Window-level pointer listeners are installed SYNCHRONOUSLY at pointerdown
 *   (not from an effect keyed on isResizing), so the first pointermove is
 *   never missed; `isResizing` only drives visual state.
 */

export type PanelTargetCause = 'visibility' | 'mode' | 'parent-layout';

/** A requested programmatic width. `width === 0` is a legal close target. */
export interface ProgrammaticPanelTarget {
    /** Identity for re-direction decisions (open/close, mode change). */
    key: string;
    /** Target width; 0 means closed (never min-clamped). */
    width: number;
    /** Why the target changed: visibility/mode animate once; parent-layout
     *  follows the available area per frame. */
    cause: PanelTargetCause;
}

export interface PanelResizeOptions<T extends HTMLElement = HTMLElement> {
    minWidth: number;
    maxWidth: number;
    /** Persist the final width exactly once on pointerup — USER intent only.
     *  Programmatic open/close, mode switches and parent-layout follows never
     *  call this. */
    onUserCommitWidth: (finalWidth: number) => void;
    /** Global resize transaction source; omit to keep the drag local. */
    transactionSource?: ResizeInteractionSource;
    /** CSS custom property that carries the live width (e.g. --oc-left-sidebar-width). */
    widthCssVariable?: string;
    /** Also write element.style.width directly (file-tree column). */
    directWidth?: boolean;
    /** Drag direction: false (default) means the handle is on the right edge
     *  (dragging right widens); true means the handle is on the left edge
     *  (dragging left widens) — used by the right-side ContextPanel and its
     *  file-tree column. */
    reverse?: boolean;
    /** Reject starting a drag (e.g. panel closed or expanded). */
    canResize?: () => boolean;
    /** Current committed width at drag start. */
    getCurrentWidth?: () => number;
    /** Clamp against the available area, measured once at drag start. */
    getAvailableWidth?: (container: T | null) => number | null;
    /** Optional performance trace span name (e.g. "ui.sidebar.resize"). */
    traceSpanName?: string;
    /** Extra span metadata captured at drag start (e.g. context panel mode). */
    traceContext?: () => Record<string, unknown>;
    /**
     * Programmatic width target for quick open/close toggles, mode switches
     * and parent-layout follows.
     * - `cause: 'visibility' | 'mode'` — fixed 200ms animation (single frame
     *   under prefers-reduced-motion) through the SAME per-frame writer as a
     *   pointer drag; a key change re-directs the animation from the current
     *   applied width.
     * - `cause: 'parent-layout'` — per-frame FOLLOW: no animation clock. While
     *   a global transaction is active the panel rides its frames; otherwise a
     *   short transaction opens on the first real width change and closes once
     *   the width stabilizes.
     * A pointerdown mid-animation stops the animation and hands over
     * seamlessly (same transaction). Pass `null` when idle.
     */
    programmaticTarget?: ProgrammaticPanelTarget | null;
    /** Re-resolve the parent-layout follow width every frame; return null when
     *  no follow applies (panel closed / manually resized / no panel). */
    resolveFollowWidth?: () => number | null;
    /** Animation duration for programmatic targets (ms). */
    programmaticDurationMs?: number;
}

export interface PanelResizeController<T extends HTMLElement = HTMLElement> {
    isResizing: boolean;
    containerRef: React.RefObject<T | null>;
    /** Bind to the handle's onPointerDown. */
    handlePointerDown: (event: React.PointerEvent) => void;
    /** Bind to the handle's onPointerUp — the ONLY normal-end path. */
    handlePointerUp: (event: React.PointerEvent) => void;
    /** Bind to the handle's onPointerCancel / onLostPointerCapture — an
     *  abnormal end that must NOT persist the width. */
    handlePointerAbort: (event: React.PointerEvent) => void;
    /** Consumer ResizeObserver callback: the parent/available area width
     *  changed. Re-resolves any follow target in the next frame; an in-flight
     *  animation re-resolves its goal per frame on its own. */
    notifyAvailableWidthChange: () => void;
}

/** Panel-local state machine. `finalizing` mirrors the global transaction's
 *  finalizing phase (the panel released but the shared finalize is pending). */
type PanelResizePhase = 'idle' | 'programmatic' | 'pointer' | 'finalizing';

/**
 * Motion configuration for programmatic width animations. Reduced motion is a
 * SHORT 120ms easeOutQuad animation — NOT a single-frame jump (the plan:
 * "reduce=120ms" keeps a visible, softer animation). The single-frame path is
 * reserved for explicit test configuration (`programmaticDurationMs === 0`).
 */
type PanelMotionMode = 'standard' | 'reduced';

interface PanelMotionProfile {
    mode: PanelMotionMode;
    durationMs: number;
    easing: (progress: number) => number;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeOutQuad = (t: number): number => t * (2 - t);

const getMotionProfile = (reduced: boolean): PanelMotionProfile => (reduced
    ? { mode: 'reduced', durationMs: 120, easing: easeOutQuad }
    : { mode: 'standard', durationMs: 200, easing: easeOutCubic });

export const usePanelResize = <T extends HTMLElement = HTMLElement>(
    options: PanelResizeOptions<T>,
): PanelResizeController<T> => {
    const {
        minWidth,
        maxWidth,
        onUserCommitWidth,
        transactionSource,
        widthCssVariable,
        directWidth,
        reverse = false,
        canResize,
        getCurrentWidth,
        getAvailableWidth,
        traceSpanName,
        traceContext,
        programmaticTarget,
        resolveFollowWidth,
        programmaticDurationMs,
    } = options;

    // Keep latest callbacks/context in refs so window listeners and cleanup
    // closures never go stale without re-registering effects.
    const onUserCommitWidthRef = React.useRef(onUserCommitWidth);
    const canResizeRef = React.useRef(canResize);
    const getCurrentWidthRef = React.useRef(getCurrentWidth);
    const getAvailableWidthRef = React.useRef(getAvailableWidth);
    const traceContextRef = React.useRef(traceContext);
    const resolveFollowWidthRef = React.useRef(resolveFollowWidth);
    React.useEffect(() => {
        onUserCommitWidthRef.current = onUserCommitWidth;
        canResizeRef.current = canResize;
        getCurrentWidthRef.current = getCurrentWidth;
        getAvailableWidthRef.current = getAvailableWidth;
        traceContextRef.current = traceContext;
        resolveFollowWidthRef.current = resolveFollowWidth;
    });

    // Live system motion preference: read at mount, then subscribe. A change
    // mid-animation does NOT alter the running animation (each animation
    // snapshots its profile at start); the new preference applies from the
    // NEXT open/close/mode switch.
    React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
            return;
        }
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
        prefersReducedMotionRef.current = mql.matches;
        const handleChange = (event: MediaQueryListEvent) => {
            prefersReducedMotionRef.current = event.matches;
        };
        mql.addEventListener('change', handleChange);
        return () => {
            mql.removeEventListener('change', handleChange);
        };
    }, []);

    const [isResizing, setIsResizing] = React.useState(false);
    const containerRef = React.useRef<T | null>(null);
    const startXRef = React.useRef(0);
    const startWidthRef = React.useRef(0);
    const resizingWidthRef = React.useRef<number | null>(null);
    const activePointerIdRef = React.useRef<number | null>(null);
    const transactionIdRef = React.useRef<number | null>(null);
    const availableWidthRef = React.useRef<number | null>(null);
    const resizeFrameRef = React.useRef<number | null>(null);
    const traceRef = React.useRef<PerformanceTraceSpan | null>(null);
    const pointerMovesRef = React.useRef(0);
    const appliedFramesRef = React.useRef(0);
    const lastAppliedAtRef = React.useRef<number | null>(null);
    const maxFrameGapRef = React.useRef(0);
    const stallFramesRef = React.useRef(0);
    // Holds the single teardown for the window/document listeners installed
    // synchronously at pointerdown; all exit paths call it exactly once.
    const removeWindowListenersRef = React.useRef<(() => void) | null>(null);
    // Programmatic width control (quick open/close, mode switches, follows).
    // Intermediate frames mutate the CSS variable directly — no React render
    // per frame; only the START and END flip React state.
    const targetRef = React.useRef<ProgrammaticPanelTarget | null>(null);
    const animFrameRef = React.useRef<number | null>(null);
    const animStartedRef = React.useRef(false);
    const followLastWidthRef = React.useRef<number | null>(null);
    const animStartTimeRef = React.useRef(0);
    const animDurationRef = React.useRef(programmaticDurationMs ?? 200);
    // Live system motion preference: read at mount, then subscribed below.
    // Changes are low-frequency and never drive per-frame React state; each
    // semantic animation snapshots its profile at start.
    const prefersReducedMotionRef = React.useRef(false);
    const animProfileRef = React.useRef<PanelMotionProfile | null>(null);
    const animAppliedFramesRef = React.useRef(0);
    const animDistinctWidthsRef = React.useRef<Set<number>>(new Set());
    const phaseRef = React.useRef<PanelResizePhase>('idle');
    // True only for the component's first mounted commit. The layout effect's
    // bootstrap write (initial width, no transaction) is allowed ONLY there; a
    // target arriving later (e.g. mid-drag) must go through the normal
    // animation path so it joins the open transaction instead of silently
    // overwriting the applied width.
    const firstMountRef = React.useRef(true);

    // The global transaction phase: reset the panel state machine once the
    // shared finalize completes (a released session stays 'finalizing').
    const globalPhase = React.useSyncExternalStore(
        subscribeResizeInteraction,
        getResizeInteractionPhase,
        getResizeInteractionPhase,
    );
    React.useEffect(() => {
        if (phaseRef.current === 'finalizing' && globalPhase === 'idle') {
            phaseRef.current = 'idle';
        }
    }, [globalPhase]);

    const nowMs = (): number => (
        typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now()
    );

    const stopProgrammatic = React.useCallback(() => {
        if (animFrameRef.current !== null) {
            window.cancelAnimationFrame(animFrameRef.current);
            animFrameRef.current = null;
        }
        animStartedRef.current = false;
        followLastWidthRef.current = null;
        if (activePointerIdRef.current === null) {
            setIsResizing(false);
        }
    }, []);

    const clampWidth = React.useCallback((value: number) => {
        const clamped = Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
        const available = availableWidthRef.current;
        return available === null ? clamped : Math.min(clamped, Math.max(1, available));
    }, [maxWidth, minWidth]);

    /** Programmatic target resolution: 0 is a legal close target and is NOT
     *  min-clamped; only positive widths are clamped. */
    const resolveTargetWidth = React.useCallback((target: ProgrammaticPanelTarget): number => {
        if (target.cause === 'parent-layout') {
            const follow = resolveFollowWidthRef.current?.() ?? null;
            if (follow !== null) {
                return follow;
            }
        }
        if (target.width <= 0) {
            return 0;
        }
        return clampWidth(target.width);
    }, [clampWidth]);

    const applyLiveWidth = React.useCallback((nextWidth: number) => {
        const el = containerRef.current;
        if (!el) {
            return;
        }
        if (widthCssVariable) {
            el.style.setProperty(widthCssVariable, `${nextWidth}px`);
        }
        if (directWidth) {
            el.style.width = `${nextWidth}px`;
        }
    }, [directWidth, widthCssVariable]);

    /** Shared frame accounting (applied frames, frame gaps, stalls) for every
     *  writer — pointer, animate and follow alike. */
    const recordAppliedFrame = React.useCallback((width: number) => {
        appliedFramesRef.current += 1;
        const appliedAt = nowMs();
        const previousAppliedAt = lastAppliedAtRef.current;
        if (previousAppliedAt !== null) {
            const frameGap = appliedAt - previousAppliedAt;
            maxFrameGapRef.current = Math.max(maxFrameGapRef.current, frameGap);
            if (frameGap > 50 && traceSpanName) {
                stallFramesRef.current += 1;
                recordPerformanceTraceEvent(
                    `${traceSpanName}_stall`,
                    { width, frame: appliedFramesRef.current, gapMs: frameGap },
                    frameGap,
                    traceRef.current?.traceId,
                );
            }
        }
        lastAppliedAtRef.current = appliedAt;
    }, [traceSpanName]);

    /** The single per-frame width write + anchor notification. */
    const writeWidthAndNotify = React.useCallback((
        width: number,
        kind: 'drag' | 'final' | 'cancel',
        origin: ResizeOrigin,
    ) => {
        applyLiveWidth(width);
        recordAppliedFrame(width);
        notifyResizeFrame({
            transactionId: transactionIdRef.current ?? 0,
            width,
            kind,
            origin,
            source: transactionSource ?? 'left-sidebar',
        });
    }, [applyLiveWidth, recordAppliedFrame, transactionSource]);

    /** Join or open the one global layout transaction for this active period.
     *  A joining source SHARES the current id (no re-capture, no finalizer
     *  reset); only idle/finalizing creates a fresh id. */
    const ensureTransaction = React.useCallback((): void => {
        if (!transactionSource) {
            return;
        }
        transactionIdRef.current = beginResizeInteraction(transactionSource, 'programmatic');
    }, [transactionSource]);

    const cleanupResize = React.useCallback((kind: 'released' | 'cancelled') => {
        traceRef.current?.end({
            ...(kind === 'cancelled' ? { cancelled: true } : {}),
            pointerMoves: pointerMovesRef.current,
            appliedFrames: appliedFramesRef.current,
            maxFrameGapMs: maxFrameGapRef.current,
            stallFramesOver50ms: stallFramesRef.current,
        });
        traceRef.current = null;
        activePointerIdRef.current = null;
        resizingWidthRef.current = null;
        availableWidthRef.current = null;
        document.documentElement.style.cursor = '';
        removeWindowListenersRef.current?.();
        removeWindowListenersRef.current = null;
        const transactionId = transactionIdRef.current;
        transactionIdRef.current = null;
        if (transactionSource && transactionId !== null) {
            if (kind === 'released') {
                releaseResizeInteraction(transactionSource, transactionId);
            } else {
                cancelResizeInteraction(transactionSource, transactionId, 'cancelled');
            }
            phaseRef.current = getResizeInteractionPhase() === 'finalizing' ? 'finalizing' : 'idle';
        } else {
            phaseRef.current = 'idle';
        }
        setIsResizing(false);
    }, [transactionSource]);

    /** End the programmatic session in ONE frame: write the final width,
     *  notify the anchor, stop the loop and release the transaction. NEVER
     *  persists (programmatic operations never touch user settings). */
    const finishProgrammatic = React.useCallback((width: number) => {
        resizingWidthRef.current = width;
        writeWidthAndNotify(width, 'final', 'programmatic');
        stopProgrammatic();
        cleanupResize('released');
    }, [cleanupResize, stopProgrammatic, writeWidthAndNotify]);

    /** Animation observability, emitted when a programmatic ANIMATION finishes
     *  (the follow loop and pointer drags do not use it). Size/timing only —
     *  never session text or user data. */
    const recordProgrammaticEnd = React.useCallback((finalWidth: number) => {
        const profile = animProfileRef.current;
        if (!profile) {
            return;
        }
        animProfileRef.current = null;
        recordPerformanceTraceEvent(
            'ui.panel.programmatic_end',
            {
                motionMode: profile.mode,
                configuredDurationMs: animDurationRef.current,
                actualDurationMs: Math.round(nowMs() - animStartTimeRef.current),
                appliedFrameCount: animAppliedFramesRef.current,
                distinctWidthCount: animDistinctWidthsRef.current.size,
                startWidth: startWidthRef.current,
                finalWidth,
                reducedMotionAtStart: profile.mode === 'reduced',
            },
            0,
            undefined,
        );
    }, []);

    /** Terminate an active pointer drag WITHOUT releasing the global
     *  transaction: a semantic target change mid-drag keeps the same anchor
     *  capture and the programmatic animation continues from the CURRENT
     *  applied width. */
    const endPointerOwnership = React.useCallback(() => {
        if (resizeFrameRef.current !== null) {
            window.cancelAnimationFrame(resizeFrameRef.current);
            resizeFrameRef.current = null;
        }
        removeWindowListenersRef.current?.();
        removeWindowListenersRef.current = null;
        traceRef.current?.end({
            cancelled: true,
            pointerMoves: pointerMovesRef.current,
            appliedFrames: appliedFramesRef.current,
            maxFrameGapMs: maxFrameGapRef.current,
            stallFramesOver50ms: stallFramesRef.current,
        });
        traceRef.current = null;
        activePointerIdRef.current = null;
        document.documentElement.style.cursor = '';
        phaseRef.current = 'programmatic';
    }, []);

    const readAppliedWidth = React.useCallback((): number | null => {
        const el = containerRef.current;
        if (!el) {
            return null;
        }
        if (widthCssVariable) {
            const raw = el.style.getPropertyValue(widthCssVariable);
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        if (directWidth) {
            const parsed = Number.parseFloat(el.style.width);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return null;
    }, [directWidth, widthCssVariable]);

    // --- Parent-layout follow loop -----------------------------------------
    // Re-resolves the follow width every frame. While another panel animates
    // (global transaction dragging) it RIDES those frames as a joining source;
    // with no transaction it opens a single-frame one (capture -> apply ->
    // final -> release). It never writes into a finalizing transaction.
    const followFrameRef = React.useRef<() => void>(() => {});
    followFrameRef.current = () => {
        animFrameRef.current = null;
        if (!animStartedRef.current) {
            return;
        }
        if (activePointerIdRef.current !== null) {
            stopProgrammatic();
            return;
        }
        const w = resolveFollowWidthRef.current?.() ?? null;
        if (w === null) {
            // Follow no longer applies: release our source registration so the
            // shared transaction can finalize (others may still be active).
            if (transactionSource && transactionIdRef.current !== null) {
                releaseResizeInteraction(transactionSource, transactionIdRef.current);
                transactionIdRef.current = null;
            }
            stopProgrammatic();
            return;
        }
        const prev = followLastWidthRef.current;
        // First frame of a loop run: compare against the APPLIED width so a
        // no-op wake-up (width unchanged, no transaction) does not open a
        // throwaway transaction. Later frames compare against the last write.
        const appliedNow = prev === null ? readAppliedWidth() : null;
        const changed = prev === null
            ? appliedNow === null || Math.abs(w - appliedNow) > 0.5
            : Math.abs(w - prev) > 0.5;
        const phase = getResizeInteractionPhase();
        if (changed) {
            if (phase === 'idle') {
                // Fresh single-frame transaction: capture now, apply, commit.
                ensureTransaction();
                setIsResizing(true);
                followLastWidthRef.current = w;
                finishProgrammatic(w);
                return;
            }
            if (phase === 'finalizing') {
                // Never interleave writes into a finalizing transaction.
                animFrameRef.current = window.requestAnimationFrame(() => followFrameRef.current());
                return;
            }
            // Riding an existing global transaction: write this frame.
            if (prev === null) {
                setIsResizing(true);
            }
            followLastWidthRef.current = w;
            resizingWidthRef.current = w;
            writeWidthAndNotify(w, 'drag', 'programmatic');
            animFrameRef.current = window.requestAnimationFrame(() => followFrameRef.current());
            return;
        }
        if (phase === 'dragging' && transactionIdRef.current !== null) {
            // Stable and we are a registered source: finalize our part; the
            // transaction stays open while other panels are still active.
            finishProgrammatic(w);
            return;
        }
        if (phase !== 'idle') {
            // Stable while another panel settles: keep watching (no writes).
            animFrameRef.current = window.requestAnimationFrame(() => followFrameRef.current());
            return;
        }
        stopProgrammatic();
    };

    const startFollowLoop = React.useCallback(() => {
        if (animFrameRef.current !== null || animStartedRef.current) {
            return;
        }
        if (activePointerIdRef.current !== null) {
            return;
        }
        if (resolveFollowWidthRef.current?.() === null) {
            return;
        }
        animStartedRef.current = true;
        animFrameRef.current = window.requestAnimationFrame(() => followFrameRef.current());
    }, []);

    const notifyAvailableWidthChange = React.useCallback(() => {
        if (activePointerIdRef.current !== null) {
            return; // a pointer drag owns the width
        }
        if (animFrameRef.current !== null) {
            return; // a loop is already re-resolving per frame
        }
        const target = targetRef.current;
        if (!target || target.cause !== 'parent-layout') {
            return;
        }
        if (resolveFollowWidthRef.current?.() === null) {
            return;
        }
        startFollowLoop();
    }, [startFollowLoop]);

    const scheduleLiveWidth = React.useCallback(() => {
        if (resizeFrameRef.current !== null) {
            return;
        }
        resizeFrameRef.current = window.requestAnimationFrame(() => {
            resizeFrameRef.current = null;
            const nextWidth = resizingWidthRef.current;
            if (nextWidth === null) {
                return;
            }
            writeWidthAndNotify(nextWidth, 'drag', 'pointer');
        });
    }, [writeWidthAndNotify]);

    const finishResize = React.useCallback(() => {
        if (activePointerIdRef.current === null) {
            return;
        }
        if (resizeFrameRef.current !== null) {
            window.cancelAnimationFrame(resizeFrameRef.current);
            resizeFrameRef.current = null;
        }
        const finalWidth = clampWidth(resizingWidthRef.current ?? startWidthRef.current);
        // Write the final width synchronously BEFORE React commits
        // isResizing=false: the render reads resizingWidthRef ?? committed
        // width, and the store update may commit a frame later, so without
        // this write the CSS variable would briefly fall back to the stale
        // pre-drag width ("jump at release").
        resizingWidthRef.current = finalWidth;
        writeWidthAndNotify(finalWidth, 'final', 'pointer');
        // USER intent only: persist the manual width exactly once on pointerup.
        onUserCommitWidthRef.current(finalWidth);
        cleanupResize('released');
    }, [clampWidth, cleanupResize, writeWidthAndNotify]);

    const cancelResize = React.useCallback(() => {
        if (activePointerIdRef.current === null) {
            return;
        }
        if (resizeFrameRef.current !== null) {
            window.cancelAnimationFrame(resizeFrameRef.current);
            resizeFrameRef.current = null;
        }
        // Commit the last legal width synchronously so the visual state
        // matches; do NOT persist (the user did not complete the drag).
        const lastWidth = clampWidth(resizingWidthRef.current ?? startWidthRef.current);
        resizingWidthRef.current = lastWidth;
        writeWidthAndNotify(lastWidth, 'cancel', 'pointer');
        cleanupResize('cancelled');
    }, [clampWidth, cleanupResize, writeWidthAndNotify]);

    // Install the window/document drag listeners synchronously at pointerdown.
    const installWindowListeners = React.useCallback(() => {
        if (removeWindowListenersRef.current) {
            return;
        }
        const handleMove = (event: PointerEvent) => {
            if (activePointerIdRef.current !== event.pointerId) {
                return;
            }
            const delta = reverse
                ? startXRef.current - event.clientX
                : event.clientX - startXRef.current;
            const nextWidth = clampWidth(startWidthRef.current + delta);
            if (resizingWidthRef.current === nextWidth) {
                return;
            }
            resizingWidthRef.current = nextWidth;
            pointerMovesRef.current += 1;
            if (traceSpanName) {
                recordPerformanceTraceEvent(
                    `${traceSpanName}_move`,
                    { width: nextWidth, move: pointerMovesRef.current },
                    0,
                    traceRef.current?.traceId,
                );
            }
            scheduleLiveWidth();
        };
        const handleUp = (event: PointerEvent) => {
            if (activePointerIdRef.current !== event.pointerId) {
                return;
            }
            finishResize();
        };
        const handleAbort = () => {
            cancelResize();
        };
        const handleVisibility = () => {
            if (document.visibilityState === 'hidden') {
                cancelResize();
            }
        };

        window.addEventListener('pointermove', handleMove);
        window.addEventListener('pointerup', handleUp);
        window.addEventListener('pointercancel', handleAbort);
        window.addEventListener('blur', handleAbort);
        document.addEventListener('visibilitychange', handleVisibility);
        removeWindowListenersRef.current = () => {
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleUp);
            window.removeEventListener('pointercancel', handleAbort);
            window.removeEventListener('blur', handleAbort);
            document.removeEventListener('visibilitychange', handleVisibility);
            removeWindowListenersRef.current = null;
        };
    }, [cancelResize, clampWidth, finishResize, reverse, scheduleLiveWidth, traceSpanName]);

    const handlePointerDown = React.useCallback((event: React.PointerEvent) => {
        if (event.button !== 0 || !event.isPrimary || activePointerIdRef.current !== null) {
            return;
        }
        if (canResizeRef.current && !canResizeRef.current()) {
            return;
        }
        setIsResizing(true);
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // capture is only an enhancement; window listeners below take over
        }
        activePointerIdRef.current = event.pointerId;
        phaseRef.current = 'pointer';
        startXRef.current = event.clientX;
        // Pointer takes over from the CURRENT applied width — a programmatic
        // animation may be mid-flight (resizingWidthRef holds its live width).
        startWidthRef.current = resizingWidthRef.current ?? getCurrentWidthRef.current?.() ?? 0;
        resizingWidthRef.current = startWidthRef.current;
        pointerMovesRef.current = 0;
        appliedFramesRef.current = 0;
        lastAppliedAtRef.current = null;
        maxFrameGapRef.current = 0;
        stallFramesRef.current = 0;
        availableWidthRef.current = getAvailableWidthRef.current?.(containerRef.current) ?? null;
        if (traceSpanName) {
            traceRef.current = startPerformanceTraceSpan(traceSpanName, {
                ...(traceContextRef.current ? traceContextRef.current() : {}),
                startWidth: startWidthRef.current,
                layoutStrategy: 'live-flex-during-drag',
            });
        }
        // Pointer takes over any running programmatic animation: stop it and
        // hand over from the CURRENT applied width, reusing the transaction id.
        stopProgrammatic();
        if (transactionSource) {
            transactionIdRef.current = beginResizeInteraction(transactionSource, 'pointer');
        }
        document.documentElement.style.cursor = 'col-resize';
        installWindowListeners();
        event.preventDefault();
    }, [installWindowListeners, stopProgrammatic, traceSpanName, transactionSource]);

    const handlePointerUp = React.useCallback((event: React.PointerEvent) => {
        if (activePointerIdRef.current !== event.pointerId) {
            return;
        }
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // ignore
        }
        finishResize();
    }, [finishResize]);

    const handlePointerAbort = React.useCallback((event: React.PointerEvent) => {
        if (activePointerIdRef.current !== event.pointerId) {
            return;
        }
        cancelResize();
    }, [cancelResize]);

    // Unmount cleanup: never overwrite a user-saved width; only cancel pending
    // work, restore the cursor and release the global transaction.
    React.useEffect(() => () => {
        removeWindowListenersRef.current?.();
        removeWindowListenersRef.current = null;
        if (resizeFrameRef.current !== null) {
            window.cancelAnimationFrame(resizeFrameRef.current);
            resizeFrameRef.current = null;
        }
        if (activePointerIdRef.current !== null) {
            traceRef.current?.end({
                cancelled: true,
                pointerMoves: pointerMovesRef.current,
                appliedFrames: appliedFramesRef.current,
                maxFrameGapMs: maxFrameGapRef.current,
                stallFramesOver50ms: stallFramesRef.current,
            });
            traceRef.current = null;
            activePointerIdRef.current = null;
            resizingWidthRef.current = null;
            document.documentElement.style.cursor = '';
            if (transactionSource && transactionIdRef.current !== null) {
                cancelResizeInteraction(transactionSource, transactionIdRef.current, 'cancelled');
                transactionIdRef.current = null;
            }
        }
    }, [transactionSource]);

    // Unmount cleanup for a running programmatic animation / follow loop. (The
    // animation effect's own cleanup runs first and stops the loop, but the
    // transaction must still be cancelled — key off the open transaction id,
    // not the started flag.)
    React.useEffect(() => () => {
        stopProgrammatic();
        if (transactionSource && transactionIdRef.current !== null && activePointerIdRef.current === null) {
            cancelResizeInteraction(transactionSource, transactionIdRef.current, 'cancelled');
            transactionIdRef.current = null;
        }
    }, [stopProgrammatic, transactionSource]);

    // --- Programmatic targets ----------------------------------------------

    // Layout effect writes the INITIAL width before the first paint and
    // records the target — NO state, NO transaction (safe in commit). This is
    // the ONLY silent bootstrap write and it happens ONLY on the first mounted
    // commit; every later target goes through the animation path below. React
    // never writes the width on re-renders; the hook is the single writer.
    React.useLayoutEffect(() => {
        const firstMount = firstMountRef.current;
        firstMountRef.current = false;
        const target = programmaticTarget ?? null;
        if (!target) {
            return;
        }
        if (!firstMount || targetRef.current !== null) {
            return;
        }
        const w = resolveTargetWidth(target);
        applyLiveWidth(w);
        resizingWidthRef.current = w;
        targetRef.current = { ...target };
    }, [applyLiveWidth, programmaticTarget, resolveTargetWidth]);

    // Programmatic transitions (animate / follow / immediate). Runs AFTER the
    // layout effect and BEFORE the canResize-flip effect, so a target change
    // mid-drag hands over before any cancel logic can fire. `prev` may be
    // null when the FIRST target arrives after mount (mid-drag) — that case
    // must animate through the open transaction, not silently jump.
    React.useEffect(() => {
        const target = programmaticTarget ?? null;
        if (!target) {
            return;
        }
        if (firstMountRef.current) {
            return; // first mounted commit: bootstrap was written by the layout effect
        }
        const prev = targetRef.current;
        const sameKey = prev !== null && prev.key === target.key;
        const sameWidth = prev !== null && Math.abs(prev.width - target.width) <= 0.5;
        if (sameKey && sameWidth && prev !== null && prev.cause === target.cause) {
            targetRef.current = { ...target };
            return; // Same target: no transaction.
        }
        // A semantic target change mid-drag hands the pointer ownership over
        // to the programmatic path WITHOUT releasing the global transaction.
        if (activePointerIdRef.current !== null) {
            endPointerOwnership();
        }
        if (sameKey && target.cause === 'parent-layout') {
            // Same-transition parent-layout update: goal-only, NEVER restart
            // the animation clock. An in-flight animation re-resolves its goal
            // per frame; otherwise ensure a follow loop is watching.
            targetRef.current = { ...target };
            startFollowLoop();
            return;
        }
        // New transition: animate (200ms) or single-frame (reduced motion).
        const fromWidth = resizingWidthRef.current ?? readAppliedWidth() ?? 0;
        const toWidth = resolveTargetWidth(target);
        if (Math.abs(fromWidth - toWidth) <= 0.5) {
            targetRef.current = { ...target };
            return; // Already at the target.
        }
        if (!animStartedRef.current) {
            ensureTransaction();
            setIsResizing(true);
            animStartedRef.current = true;
            phaseRef.current = 'programmatic';
        }
        targetRef.current = { ...target };
        startWidthRef.current = fromWidth;
        // Snapshot the motion profile at animation START: a system preference
        // change mid-animation does not alter the running animation. Reduced
        // motion keeps a SHORT 120ms animation — never a single-frame jump.
        const profile = getMotionProfile(prefersReducedMotionRef.current);
        animProfileRef.current = profile;
        animStartTimeRef.current = nowMs();
        animDurationRef.current = programmaticDurationMs ?? profile.durationMs;
        animAppliedFramesRef.current = 0;
        animDistinctWidthsRef.current = new Set<number>();
        if (programmaticDurationMs === 0) {
            // Explicit test configuration ONLY: a true single-frame jump.
            animDistinctWidthsRef.current.add(toWidth);
            recordProgrammaticEnd(toWidth);
            finishProgrammatic(toWidth);
            return;
        }
        if (animFrameRef.current === null) {
            animFrameRef.current = window.requestAnimationFrame(function animateProgrammaticFrame() {
                animFrameRef.current = null;
                if (!animStartedRef.current) {
                    return;
                }
                const now = nowMs();
                const elapsed = now - animStartTimeRef.current;
                const t = Math.min(1, elapsed / Math.max(1, animDurationRef.current));
                const eased = animProfileRef.current?.easing(t) ?? easeOutCubic(t);
                // Per-frame goal re-resolution: parent-layout-driven opens land
                // on the FINAL parent width even when the parent keeps moving.
                let goal = targetRef.current?.width ?? 0;
                const follow = resolveFollowWidthRef.current?.();
                if (follow !== null && follow !== undefined) {
                    goal = follow;
                }
                const start = startWidthRef.current;
                const current = Math.round(start + (goal - start) * eased);
                animAppliedFramesRef.current += 1;
                animDistinctWidthsRef.current.add(current);
                if (t >= 1 || Math.abs(current - goal) <= 0.5) {
                    recordProgrammaticEnd(goal);
                    finishProgrammatic(goal);
                    return;
                }
                resizingWidthRef.current = current;
                writeWidthAndNotify(current, 'drag', 'programmatic');
                animFrameRef.current = window.requestAnimationFrame(animateProgrammaticFrame);
            });
        }
    }, [applyLiveWidth, endPointerOwnership, ensureTransaction, finishProgrammatic, programmaticDurationMs, programmaticTarget, readAppliedWidth, recordProgrammaticEnd, resolveTargetWidth, startFollowLoop, writeWidthAndNotify]);

    // End a drag when the consumer's canResize guard flips false mid-drag. A
    // semantic target change already handed the session to the programmatic
    // path (activePointerIdRef cleared) before this effect runs, so this only
    // fires for paths without a target change — cancelResize itself bails when
    // no pointer owns the session.
    React.useEffect(() => {
        if (isResizing && canResizeRef.current && !canResizeRef.current()) {
            cancelResize();
        }
    });

    return {
        isResizing,
        containerRef,
        handlePointerDown,
        handlePointerUp,
        handlePointerAbort,
        notifyAvailableWidthChange,
    };
};
