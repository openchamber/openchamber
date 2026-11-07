import { describe, expect, test } from 'bun:test';

import {
    appendInlineText,
    appendWithLineBreaks,
    buildImagePasteInsertion,
    getMarkdownAutoPairEdit,
    getOrderedListContinuationEdit,
    shouldWrapSelectionAsLink,
    withInlineInsertionBoundaries,
} from '../text';

describe('appendWithLineBreaks', () => {
    test('separates the block with a blank line and ends with one', () => {
        expect(appendWithLineBreaks('intro', 'body')).toBe('intro\n\nbody\n\n');
    });

    test('does not stack separators that are already there', () => {
        expect(appendWithLineBreaks('intro\n\n', 'body')).toBe('intro\n\nbody\n\n');
        expect(appendWithLineBreaks('intro\n', 'body')).toBe('intro\n\nbody\n\n');
    });

    test('an empty base needs no separator', () => {
        expect(appendWithLineBreaks('', 'body')).toBe('body\n\n');
    });

    test('trailing breaks in the inserted block are normalized, not doubled', () => {
        expect(appendWithLineBreaks('a', 'b\n')).toBe('a\n\nb\n\n');
        expect(appendWithLineBreaks('a', 'b\n\n')).toBe('a\n\nb\n\n');
    });
});

describe('appendInlineText', () => {
    test('joins with a single space and leaves the caret room', () => {
        expect(appendInlineText('hello', 'world')).toBe('hello world ');
    });

    test('does not double an existing space', () => {
        expect(appendInlineText('hello ', 'world')).toBe('hello world ');
        expect(appendInlineText('hello\n', 'world')).toBe('hello\nworld ');
    });

    test('an empty base yields just the text', () => {
        expect(appendInlineText('', 'world')).toBe('world ');
    });

    test('blank additions are ignored', () => {
        expect(appendInlineText('hello', '   ')).toBe('hello');
        expect(appendInlineText('hello', '')).toBe('hello');
    });

    test('the addition is trimmed before joining', () => {
        expect(appendInlineText('hello', '  world  ')).toBe('hello world ');
    });
});

describe('withInlineInsertionBoundaries', () => {
    test('pads between two words', () => {
        expect(withInlineInsertionBoundaries('mid', 'left', 'right')).toBe(' mid ');
    });

    test('adds nothing at the very start or end', () => {
        expect(withInlineInsertionBoundaries('mid', '', '')).toBe('mid');
    });

    test('respects whitespace already present', () => {
        expect(withInlineInsertionBoundaries('mid', 'left ', ' right')).toBe('mid');
    });

    test('no space after an opening bracket', () => {
        expect(withInlineInsertionBoundaries('mid', '(', 'x')).toBe('mid ');
        expect(withInlineInsertionBoundaries('mid', '[', 'x')).toBe('mid ');
    });

    test('no space before a closing bracket or sentence punctuation', () => {
        expect(withInlineInsertionBoundaries('mid', 'x', ')')).toBe(' mid');
        expect(withInlineInsertionBoundaries('mid', 'x', '.')).toBe(' mid');
        expect(withInlineInsertionBoundaries('mid', 'x', ', rest')).toBe(' mid');
    });

    test('empty content stays empty', () => {
        expect(withInlineInsertionBoundaries('', 'left', 'right')).toBe('');
    });
});

describe('buildImagePasteInsertion', () => {
    test('a citation pasted alone is the whole insertion', () => {
        expect(buildImagePasteInsertion('', '[shot.png]')).toBe('[shot.png]');
    });

    test('text pasted with the image keeps the citation after it', () => {
        expect(buildImagePasteInsertion('look', '[shot.png]')).toBe('look [shot.png]');
    });

    test('an existing trailing space is not doubled', () => {
        expect(buildImagePasteInsertion('look ', '[shot.png]')).toBe('look [shot.png]');
    });
});

describe('shouldWrapSelectionAsLink', () => {
    test('a URL pasted over selected text becomes a link', () => {
        expect(shouldWrapSelectionAsLink('https://x.dev', 'docs')).toBe(true);
        expect(shouldWrapSelectionAsLink('mailto:a@b.c', 'mail me')).toBe(true);
    });

    test('non-URLs are pasted normally', () => {
        expect(shouldWrapSelectionAsLink('just text', 'docs')).toBe(false);
        expect(shouldWrapSelectionAsLink('ftp://x.dev', 'docs')).toBe(false);
    });

    test('a URL containing whitespace is not one', () => {
        expect(shouldWrapSelectionAsLink('https://x.dev y', 'docs')).toBe(false);
    });

    test('an empty or blank selection has nothing to wrap', () => {
        expect(shouldWrapSelectionAsLink('https://x.dev', '')).toBe(false);
        expect(shouldWrapSelectionAsLink('https://x.dev', '   ')).toBe(false);
    });

    test('a selection that is already a link is not nested', () => {
        expect(shouldWrapSelectionAsLink('https://x.dev', '[docs](https://y.dev)')).toBe(false);
    });
});

describe('getMarkdownAutoPairEdit', () => {
    test('completes a fenced block with the caret on the middle line', () => {
        expect(getMarkdownAutoPairEdit('``', '`', 2, 2)).toEqual({
            from: 2,
            to: 2,
            insert: '`\n\n```',
            selectionStart: 4,
            selectionEnd: 4,
        });
    });

    test('completes a fence at the start of any line', () => {
        expect(getMarkdownAutoPairEdit('intro\n``tail', '`', 8, 8)).toEqual({
            from: 8,
            to: 8,
            insert: '`\n\n```',
            selectionStart: 10,
            selectionEnd: 10,
        });
    });

    test('does not complete two backticks in the middle of a line', () => {
        expect(getMarkdownAutoPairEdit('text ``', '`', 7, 7)).toBeNull();
    });

    test('wraps selected text and keeps the text selected', () => {
        expect(getMarkdownAutoPairEdit('hello', '*', 1, 4)).toEqual({
            from: 1,
            to: 4,
            insert: '*ell*',
            selectionStart: 2,
            selectionEnd: 5,
        });
    });
});

describe('getOrderedListContinuationEdit', () => {
    test('continues a numbered item with the next number at the same indentation', () => {
        expect(getOrderedListContinuationEdit('  1. item', 9, 9)).toEqual({
            from: 9,
            to: 9,
            insert: '\n  2. ',
            selectionStart: 15,
            selectionEnd: 15,
        });
    });

    test('keeps the delimiter the user typed', () => {
        expect(getOrderedListContinuationEdit('1) item', 7, 7)?.insert).toBe('\n2) ');
        expect(getOrderedListContinuationEdit('3. item', 7, 7)?.insert).toBe('\n4. ');
    });

    test('a bare marker continues too', () => {
        expect(getOrderedListContinuationEdit('1.', 2, 2)?.insert).toBe('\n2. ');
        expect(getOrderedListContinuationEdit('1. ', 3, 3)?.insert).toBe('\n2. ');
    });

    test('continues when the item has trailing text after its marker', () => {
        const line = 'open the file, then run 1. tests';
        expect(getOrderedListContinuationEdit(line, line.length, line.length)).toBeNull();
        expect(getOrderedListContinuationEdit('1. open the file', 16, 16)?.insert).toBe('\n2. ');
    });

    test('only the line end counts', () => {
        expect(getOrderedListContinuationEdit('1. item', 4, 4)).toBeNull();
        expect(getOrderedListContinuationEdit('1. item\nplain', 11, 11)).toBeNull();
    });

    test('a selection or a line that is not a list is left alone', () => {
        expect(getOrderedListContinuationEdit('1. item', 0, 7)).toBeNull();
        expect(getOrderedListContinuationEdit('version 2.', 10, 10)).toBeNull();
        expect(getOrderedListContinuationEdit('1.item', 6, 6)).toBeNull();
        expect(getOrderedListContinuationEdit('- item', 6, 6)).toBeNull();
    });

    describe('fenced code', () => {
        const atEnd = (value: string) => getOrderedListContinuationEdit(value, value.length, value.length);

        test('a numbered line inside a closed fence stays a plain newline', () => {
            const value = '```\n1. item\n```';
            const caret = '```\n1. item'.length;
            expect(getOrderedListContinuationEdit(value, caret, caret)).toBeNull();

            const tildes = '~~~\n1) item\n~~~';
            const tildeCaret = '~~~\n1) item'.length;
            expect(getOrderedListContinuationEdit(tildes, tildeCaret, tildeCaret)).toBeNull();
        });

        test('an unclosed fence runs to the end of the prompt', () => {
            expect(atEnd('```ts\n1. item')).toBeNull();
            expect(atEnd('~~~\n1. item')).toBeNull();
        });

        test('only a matching fence closes the block', () => {
            expect(atEnd('```\n~~~\n1. item')).toBeNull();
            expect(atEnd('~~~\n```\n1. item')).toBeNull();
            expect(atEnd('````\n```\n1. item')).toBeNull();
        });

        test('a real list after a closed fence continues', () => {
            expect(atEnd('```\ncode\n```\n1. item')?.insert).toBe('\n2. ');
            expect(atEnd('~~~\ncode\n~~~\n\n1) item')?.insert).toBe('\n2) ');
        });
    });
});
