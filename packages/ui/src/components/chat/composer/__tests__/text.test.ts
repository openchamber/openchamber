import { describe, expect, test } from 'bun:test';

import {
    appendInlineText,
    appendWithLineBreaks,
    buildImagePasteInsertion,
    getMarkdownAutoPairEdit,
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
