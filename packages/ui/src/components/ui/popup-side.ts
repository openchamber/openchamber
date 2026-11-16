import React from 'react';


export type PopupSide = 'top' | 'bottom';

const MIN_ROOM = 240;

export const choosePopupSide = (
    preferred: PopupSide,
    trigger: { top: number; bottom: number },
    bounds: { top: number; bottom: number },
): PopupSide => {
    const room = { top: trigger.top - bounds.top, bottom: bounds.bottom - trigger.bottom };
    const other = preferred === 'top' ? 'bottom' : 'top';
    return room[preferred] < MIN_ROOM && room[other] > room[preferred] ? other : preferred;
};

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

export const commandSearchAtBottomClass =
    'flex-col-reverse [&_[data-slot=command-input-wrapper]]:border-b-0 [&_[data-slot=command-input-wrapper]]:border-t';
