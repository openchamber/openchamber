import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

import { replaceWithCaret } from '../documentEdits';

const apply = (doc: string, from: number, to: number, insert: string, caret?: { anchor: number; head: number }) => {
    const state = EditorState.create({ doc });
    const next = state.update(replaceWithCaret(state, from, to, insert, caret)).state;
    return { text: next.doc.toString(), selection: next.selection.main };
};

describe('replaceWithCaret', () => {
    test('puts the caret at the end of a wholesale replacement', () => {
        const { text, selection } = apply('old', 0, 3, 'a new draft');

        expect(text).toBe('a new draft');
        expect(selection.anchor).toBe(11);
        expect(selection.head).toBe(11);
    });

    // Issue #3013: CodeMirror collapses `\r\n` into one line break, so a caret
    // taken from the JS string length falls outside the document and dispatch
    // throws `RangeError: Selection points outside of document`.
    test('keeps the caret inside the document when CRLF is normalized away', () => {
        const { text, selection } = apply('a', 0, 1, 'x\r\ny');

        expect(text).toBe('x\ny');
        expect(selection.anchor).toBe(3);
    });

    test('survives a draft made only of CRLF breaks', () => {
        const { text, selection } = apply('a', 0, 1, '\r\n\r\n\r\n');

        expect(text).toBe('\n\n\n');
        expect(selection.anchor).toBe(3);
    });

    test('places the caret after text inserted at the selection', () => {
        const { text, selection } = apply('hello world', 5, 5, ',\r\n there');

        expect(text).toBe('hello,\n there world');
        expect(selection.anchor).toBe(13);
    });

    test('honours an explicit caret', () => {
        const { selection } = apply('hello', 0, 5, 'goodbye', { anchor: 2, head: 4 });

        expect(selection.anchor).toBe(2);
        expect(selection.head).toBe(4);
    });

    test('clamps an explicit caret that the normalized document cannot hold', () => {
        const { text, selection } = apply('a', 0, 1, 'x\r\ny', { anchor: 4, head: 4 });

        expect(text).toBe('x\ny');
        expect(selection.anchor).toBe(3);
    });
});
