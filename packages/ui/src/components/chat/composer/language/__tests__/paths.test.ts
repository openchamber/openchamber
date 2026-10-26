import { describe, expect, test } from 'bun:test';

import { pathHighlightRanges, scanPaths } from '../paths';

const paths = (text: string) => scanPaths(text).map((token) => token.path);

describe('scanPaths — what counts as a path', () => {
    test('a home-relative path', () => {
        expect(paths('see ~/repos/ocb/README.md')).toEqual(['/repos/ocb/README.md']);
    });

    test('a project-relative path', () => {
        expect(paths('open ~src/components/App.tsx')).toEqual(['src/components/App.tsx']);
    });

    test('a bare filename with an extension', () => {
        expect(paths('edit ~README.md')).toEqual(['README.md']);
    });

    test('a windows path', () => {
        expect(paths('at ~C:\\repo\\a.ts')).toEqual(['C:\\repo\\a.ts']);
    });

    test('a word without a separator or extension is prose', () => {
        expect(paths('it took ~approximately an hour')).toEqual([]);
        expect(paths('~ish')).toEqual([]);
    });

    test('an approximate number is prose', () => {
        expect(paths('about ~500 items')).toEqual([]);
    });

    test('an approximate decimal is prose, not a file', () => {
        // `~` also reads as "about"; an extension must start with a letter.
        expect(paths('roughly ~1.2 seconds')).toEqual([]);
        expect(paths('~0.5x slower')).toEqual([]);
    });
});

describe('scanPaths — boundaries', () => {
    test('a path at the start of the text', () => {
        expect(paths('~src/a.ts is the file')).toEqual(['src/a.ts']);
    });

    test('a tilde inside a word is not a path', () => {
        expect(paths('foo~bar/baz.ts')).toEqual([]);
    });

    test('brackets and quotes still open a path', () => {
        expect(paths('(~src/a.ts) "~b/c.ts"')).toEqual(['src/a.ts', 'b/c.ts']);
    });

    test('several paths on one line', () => {
        expect(paths('~a/b.ts and ~c/d.ts')).toEqual(['a/b.ts', 'c/d.ts']);
    });

    test('trailing sentence punctuation is not part of the path', () => {
        expect(paths('see ~src/a.ts, then stop.')).toEqual(['src/a.ts']);
    });
});

describe('scanPaths — not confused with other tilde syntax', () => {
    test('a tilde code fence is left alone', () => {
        expect(paths('~~~\nbody\n~~~')).toEqual([]);
    });

    test('strikethrough is left alone', () => {
        expect(paths('~~struck out~~')).toEqual([]);
    });

    test('text without a tilde scans to nothing', () => {
        expect(scanPaths('plain text')).toEqual([]);
        expect(scanPaths('')).toEqual([]);
    });
});

describe('pathHighlightRanges', () => {
    test('the range covers the tilde and the path', () => {
        const text = 'see ~src/a.ts here';
        const [range] = pathHighlightRanges(text);
        expect(text.slice(range.start, range.end)).toBe('~src/a.ts');
        expect(range.style).toBe('path');
    });

    test('prose produces no ranges', () => {
        expect(pathHighlightRanges('nothing here')).toEqual([]);
    });
});
