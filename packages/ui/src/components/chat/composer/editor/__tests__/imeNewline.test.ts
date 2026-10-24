import { describe, expect, test } from 'bun:test';

import { caretFollowsLineBreak } from '../imeNewline';

describe('caretFollowsLineBreak', () => {
    test('reports the padding space as missing after a line break', () => {
        expect(caretFollowsLineBreak(4, '\n')).toBe(true);
    });

    test('leaves the cleanup alone when the padding space is in the document', () => {
        expect(caretFollowsLineBreak(5, ' ')).toBe(false);
    });

    test('does nothing at the start of the document', () => {
        expect(caretFollowsLineBreak(0, '')).toBe(false);
    });

    test('does nothing after any other character', () => {
        expect(caretFollowsLineBreak(3, 'c')).toBe(false);
    });
});
