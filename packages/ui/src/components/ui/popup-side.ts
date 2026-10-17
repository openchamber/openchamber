import React from 'react';

/**
 * Picking a popup's side once per open.
 *
 * Base UI flips a popup to the other side by itself when its side is short of
 * room, and most popups rely on that. A popup that must not move while open,
 * such as one with a search field that stays put while results filter,
 * disables flipping and takes its side from here instead: measured when it
 * opens, kept until it closes.
 */

export type PopupSide = 'top' | 'bottom';

/** Room on the preferred side, in px, below which the popup opens on the other side. */
const MIN_ROOM = 240;

/**
 * The preferred side, unless it has less than `MIN_ROOM` and the other side
 * has more. `bounds` is the area the popup is kept inside, already clipped to
 * the window.
 */
export const choosePopupSide = (
    preferred: PopupSide,
    trigger: { top: number; bottom: number },
    bounds: { top: number; bottom: number },
): PopupSide => {
    const room = { top: trigger.top - bounds.top, bottom: bounds.bottom - trigger.bottom };
    const other = preferred === 'top' ? 'bottom' : 'top';
    return room[preferred] < MIN_ROOM && room[other] > room[preferred] ? other : preferred;
};

/**
 * The side for a popup anchored to `triggerRef`, chosen before paint each time
 * `open` turns true, however it was opened. Measured against the trigger's
 * `main`, which `constrainToMain` popups stay inside, or the window.
 */
export function usePopupSideOnOpen(
    open: boolean,
    triggerRef: React.RefObject<HTMLElement | null>,
    preferred: PopupSide = 'bottom',
): PopupSide {
    const [side, setSide] = React.useState<PopupSide>(preferred);
    React.useLayoutEffect(() => {
        const trigger = triggerRef.current;
        if (!open || !trigger) return;
        const main = trigger.closest('main')?.getBoundingClientRect();
        setSide(choosePopupSide(preferred, trigger.getBoundingClientRect(), {
            top: Math.max(main?.top ?? 0, 0),
            bottom: Math.min(main?.bottom ?? window.innerHeight, window.innerHeight),
        }));
    }, [open, preferred, triggerRef]);
    return side;
}

/**
 * For a searchable `Command` popup that opened upward: moves its search field
 * to the bottom, next to the trigger, with the divider above it, so the field
 * stays put while the results above it filter.
 */
export const commandSearchAtBottomClass =
    'flex-col-reverse [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:border-t';
