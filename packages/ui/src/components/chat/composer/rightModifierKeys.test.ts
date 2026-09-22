import { describe, expect, test } from 'bun:test';

import {
    EMPTY_RIGHT_MODIFIER_STATE,
    applyRightModifierKey,
    isRightModifierHeld,
    reconcileRightModifierState,
} from './rightModifierKeys';

describe('right modifier key tracking', () => {
    test('tracks right Shift and right Control independently', () => {
        const shift = applyRightModifierKey(EMPTY_RIGHT_MODIFIER_STATE, 'ShiftRight', true);
        expect(shift).toEqual({ shiftRight: true, controlRight: false });
        expect(isRightModifierHeld(shift)).toBe(true);

        const control = applyRightModifierKey(shift, 'ControlRight', true);
        expect(control).toEqual({ shiftRight: true, controlRight: true });

        const releasedShift = applyRightModifierKey(control, 'ShiftRight', false);
        expect(releasedShift).toEqual({ shiftRight: false, controlRight: true });
        expect(isRightModifierHeld(releasedShift)).toBe(true);

        const releasedControl = applyRightModifierKey(releasedShift, 'ControlRight', false);
        expect(releasedControl).toEqual(EMPTY_RIGHT_MODIFIER_STATE);
        expect(isRightModifierHeld(releasedControl)).toBe(false);
    });

    test('ignores left-hand modifiers, right Meta and unrelated keys', () => {
        for (const code of ['ShiftLeft', 'ControlLeft', 'MetaRight', 'Enter', 'KeyA']) {
            expect(applyRightModifierKey(EMPTY_RIGHT_MODIFIER_STATE, code, true)).toBe(EMPTY_RIGHT_MODIFIER_STATE);
        }
    });

    test('keeps the state identity when a key repeats or is already released', () => {
        const held = applyRightModifierKey(EMPTY_RIGHT_MODIFIER_STATE, 'ShiftRight', true);
        expect(applyRightModifierKey(held, 'ShiftRight', true)).toBe(held);
        expect(applyRightModifierKey(held, 'ControlRight', false)).toBe(held);
    });
});

describe('right modifier reconciliation', () => {
    test('clears a stale right flag the Enter event says is not held', () => {
        const held = applyRightModifierKey(
            applyRightModifierKey(EMPTY_RIGHT_MODIFIER_STATE, 'ShiftRight', true),
            'ControlRight',
            true,
        );
        expect(reconcileRightModifierState(held, { shiftKey: false, ctrlKey: false }))
            .toEqual(EMPTY_RIGHT_MODIFIER_STATE);
        expect(reconcileRightModifierState(held, { shiftKey: true, ctrlKey: false }))
            .toEqual({ shiftRight: true, controlRight: false });
    });

    test('never turns a held left modifier into a right one', () => {
        expect(reconcileRightModifierState(EMPTY_RIGHT_MODIFIER_STATE, { shiftKey: true, ctrlKey: true }))
            .toBe(EMPTY_RIGHT_MODIFIER_STATE);
        const control = applyRightModifierKey(EMPTY_RIGHT_MODIFIER_STATE, 'ControlRight', true);
        expect(reconcileRightModifierState(control, { shiftKey: true, ctrlKey: true })).toBe(control);
    });
});
