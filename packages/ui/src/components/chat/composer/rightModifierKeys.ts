import * as React from 'react';

interface RightModifierHeldState {
    shiftRight: boolean;
    controlRight: boolean;
}

export const EMPTY_RIGHT_MODIFIER_STATE: RightModifierHeldState = {
    shiftRight: false,
    controlRight: false,
};

const rightModifierKeyOf = (code: string): keyof RightModifierHeldState | null => {
    if (code === 'ShiftRight') return 'shiftRight';
    if (code === 'ControlRight') return 'controlRight';
    return null;
};

export const applyRightModifierKey = (
    state: RightModifierHeldState,
    code: string,
    down: boolean,
): RightModifierHeldState => {
    const key = rightModifierKeyOf(code);
    if (!key || state[key] === down) return state;
    return { ...state, [key]: down };
};

const clearRightModifierKey = (
    state: RightModifierHeldState,
    key: keyof RightModifierHeldState,
): RightModifierHeldState => (state[key] ? { ...state, [key]: false } : state);

export const isRightModifierHeld = (state: RightModifierHeldState): boolean => (
    state.shiftRight || state.controlRight
);

/** The modifier flags an Enter keydown carries, on native and React events alike. */
export interface EnterModifierFlags {
    shiftKey: boolean;
    ctrlKey: boolean;
}

/**
 * Clears a right-hand flag the Enter event says is not held. Only ever clears:
 * a left-hand modifier must not turn into a right-hand one.
 */
export const reconcileRightModifierState = (
    state: RightModifierHeldState,
    event: EnterModifierFlags,
): RightModifierHeldState => {
    let next = state;
    if (!event.shiftKey) next = clearRightModifierKey(next, 'shiftRight');
    if (!event.ctrlKey) next = clearRightModifierKey(next, 'controlRight');
    return next;
};

let trackedState = EMPTY_RIGHT_MODIFIER_STATE;
let listenersAttached = false;

const handleKeyDown = (event: KeyboardEvent) => {
    trackedState = applyRightModifierKey(trackedState, event.code, true);
};

const handleKeyUp = (event: KeyboardEvent) => {
    trackedState = applyRightModifierKey(trackedState, event.code, false);
};

// One pair of listeners for the whole page: a composer that unmounts must not
// detach tracking from the composer still on screen.
const attachRightModifierListeners = () => {
    if (listenersAttached) return;
    listenersAttached = true;
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
};

const getRightModifierHeld = (event?: EnterModifierFlags): boolean => {
    if (event) trackedState = reconcileRightModifierState(trackedState, event);
    return isRightModifierHeld(trackedState);
};

export const useRightModifierHeld = (): ((event?: EnterModifierFlags) => boolean) => {
    React.useEffect(() => {
        attachRightModifierListeners();
    }, []);
    return getRightModifierHeld;
};
