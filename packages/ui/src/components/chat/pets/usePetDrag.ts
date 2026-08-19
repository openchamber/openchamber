/**
 * Long-press drag helper shared by the in-app pet (web/mobile) and the
 * desktop pet overlay window.
 *
 * A press that stays within `moveTolerancePx` for `longPressMs` enters drag
 * mode; subsequent pointer movement reports per-move deltas through
 * `onDragMove`, and release calls `onDragEnd`. A press that moves beyond the
 * tolerance before the timer fires is treated as a non-drag gesture (e.g.
 * scrolling), and the pending drag is cancelled.
 */

import React from 'react';

export interface UsePetDragOptions {
    onDragStart?: () => void;
    /** Relative pointer deltas (used by the in-app pet). */
    onDragMove?: (dx: number, dy: number) => void;
    /** Absolute screen coordinates for the window top-left (used by the desktop overlay). */
    onDragMoveTo?: (x: number, y: number) => void;
    onDragEnd?: () => void;
    longPressMs?: number;
    moveTolerancePx?: number;
}

export interface UsePetDragResult {
    isDragging: boolean;
    pointerProps: {
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
        onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
    };
}

interface DragState {
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    timer: ReturnType<typeof setTimeout> | null;
    dragging: boolean;
}

export function usePetDrag({
    onDragStart,
    onDragMove,
    onDragMoveTo,
    onDragEnd,
    longPressMs = 400,
    moveTolerancePx = 8,
}: UsePetDragOptions): UsePetDragResult {
    const stateRef = React.useRef<DragState | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);
    const callbacksRef = React.useRef({ onDragStart, onDragMove, onDragMoveTo, onDragEnd });
    callbacksRef.current = { onDragStart, onDragMove, onDragMoveTo, onDragEnd };

    const clearTimer = (state: DragState) => {
        if (state.timer !== null) {
            clearTimeout(state.timer);
            state.timer = null;
        }
    };

    const endDrag = React.useCallback((state: DragState, completed: boolean) => {
        clearTimer(state);
        if (state.dragging && completed) {
            callbacksRef.current.onDragEnd?.();
        }
        stateRef.current = null;
        setIsDragging(false);
    }, []);

    const handlePointerDown = React.useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            if (stateRef.current) return;
            if (event.button !== 0 && event.pointerType === 'mouse') return;
            const startX = event.clientX;
            const startY = event.clientY;
            const state: DragState = {
                pointerId: event.pointerId,
                startX,
                startY,
                lastX: startX,
                lastY: startY,
                timer: null,
                dragging: false,
            };
            stateRef.current = state;
            event.currentTarget.setPointerCapture(event.pointerId);
            if (longPressMs === 0) {
                state.dragging = true;
                setIsDragging(true);
                callbacksRef.current.onDragStart?.();
            } else {
                state.timer = setTimeout(() => {
                    state.timer = null;
                    state.dragging = true;
                    setIsDragging(true);
                    callbacksRef.current.onDragStart?.();
                }, longPressMs);
            }
        },
        [longPressMs],
    );

    const handlePointerMove = React.useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            const state = stateRef.current;
            if (!state || event.pointerId !== state.pointerId) return;

            const deltaX = event.clientX - state.lastX;
            const deltaY = event.clientY - state.lastY;
            state.lastX = event.clientX;
            state.lastY = event.clientY;

            if (!state.dragging) {
                const moved = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
                if (moved > moveTolerancePx) {
                    clearTimer(state);
                    stateRef.current = null;
                }
                return;
            }

            if (deltaX !== 0 || deltaY !== 0) {
                callbacksRef.current.onDragMove?.(deltaX, deltaY);
            }
            if (callbacksRef.current.onDragMoveTo) {
                callbacksRef.current.onDragMoveTo(
                    event.screenX - state.startX,
                    event.screenY - state.startY,
                );
            }
        },
        [moveTolerancePx],
    );

    const handlePointerUp = React.useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            const state = stateRef.current;
            if (!state || event.pointerId !== state.pointerId) return;
            endDrag(state, true);
        },
        [endDrag],
    );

    const handlePointerCancel = React.useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            const state = stateRef.current;
            if (!state || event.pointerId !== state.pointerId) return;
            endDrag(state, false);
        },
        [endDrag],
    );

    React.useEffect(() => {
        const state = stateRef.current;
        if (!state) return undefined;
        return () => {
            clearTimer(state);
        };
    }, []);

    return {
        isDragging,
        pointerProps: {
            onPointerDown: handlePointerDown,
            onPointerMove: handlePointerMove,
            onPointerUp: handlePointerUp,
            onPointerCancel: handlePointerCancel,
        },
    };
}
