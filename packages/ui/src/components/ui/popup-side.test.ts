import { describe, expect, test } from 'bun:test';
import { choosePopupSide } from './popup-side';

describe('choosePopupSide', () => {
    test('opens upward from a trigger near the bottom of the window, as in Mini Chat', () => {
        // Mini Chat: a 760px window with the picker 122px above its bottom.
        expect(choosePopupSide('bottom', { top: 610, bottom: 638 }, { top: 0, bottom: 760 })).toBe('top');
    });

    test('keeps the preferred side when it has room', () => {
        // The main window's centered draft.
        expect(choosePopupSide('bottom', { top: 277, bottom: 305 }, { top: 0, bottom: 740 })).toBe('bottom');
    });

    test('opens downward from a trigger near the top when upward is preferred', () => {
        // The composer's model menu with the composer near the top of a short window.
        expect(choosePopupSide('top', { top: 120, bottom: 148 }, { top: 40, bottom: 700 })).toBe('bottom');
    });

    test('keeps the preferred side when the other side is smaller still', () => {
        expect(choosePopupSide('bottom', { top: 100, bottom: 128 }, { top: 0, bottom: 300 })).toBe('bottom');
    });
});
