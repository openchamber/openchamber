import { describe, expect, test } from 'bun:test';

import {
    collectKnownTokenNames,
    filterKnownTokens,
    scanPrefixTokens,
} from '../prefixTokens';

const slashNames = (text: string) => scanPrefixTokens(text, '/').map((token) => token.name);
const hashNames = (text: string) => scanPrefixTokens(text, '#').map((token) => token.name);

describe('scanPrefixTokens — boundaries', () => {
    test('a token at the start of the text', () => {
        expect(slashNames('/review this')).toEqual(['review']);
        expect(hashNames('#note here')).toEqual(['note']);
    });

    test('a token after whitespace, mid-sentence', () => {
        expect(slashNames('please run /explore now')).toEqual(['explore']);
        expect(hashNames('use #sig at the end')).toEqual(['sig']);
    });

    test('a token after a newline', () => {
        expect(slashNames('line one\n/review')).toEqual(['review']);
    });

    test('a path segment is not a slash token', () => {
        expect(slashNames('src/components/App.tsx')).toEqual([]);
        expect(slashNames('see a/b')).toEqual([]);
    });

    test('a fragment or issue reference is not a snippet token', () => {
        expect(hashNames('issue#42')).toEqual([]);
        expect(hashNames('page.html#anchor')).toEqual([]);
    });

    test('multiple tokens on one line', () => {
        expect(slashNames('/plan then /review')).toEqual(['plan', 'review']);
    });

    test('a name must start with an alphanumeric', () => {
        expect(slashNames('/-dash')).toEqual([]);
        expect(slashNames('/_under')).toEqual([]);
        expect(hashNames('#-x')).toEqual([]);
    });

    test('names may contain dashes, underscores and digits', () => {
        expect(slashNames('/workspace-review /My_Skill /a1')).toEqual([
            'workspace-review',
            'My_Skill',
            'a1',
        ]);
    });

    test('a bare sigil is not a token', () => {
        expect(slashNames('a / b')).toEqual([]);
        expect(hashNames('a # b')).toEqual([]);
    });

    test('text without the sigil scans to nothing', () => {
        expect(scanPrefixTokens('nothing here', '/')).toEqual([]);
        expect(scanPrefixTokens('', '#')).toEqual([]);
    });

    test('the two sigils do not see each other', () => {
        expect(slashNames('#snippet')).toEqual([]);
        expect(hashNames('/skill')).toEqual([]);
    });
});

describe('scanPrefixTokens — offsets', () => {
    test('start and end delimit the sigil plus the name', () => {
        const text = 'run /review now';
        const [token] = scanPrefixTokens(text, '/');
        expect(text.slice(token.start, token.end)).toBe('/review');
        expect(token.prefix).toBe('/');
    });

    test('the boundary whitespace is not part of the token', () => {
        const [token] = scanPrefixTokens('  /plan', '/');
        expect(token.start).toBe(2);
    });

    test('adjacent tokens keep independent offsets', () => {
        const text = '/a /b';
        const tokens = scanPrefixTokens(text, '/');
        expect(tokens.map((token) => text.slice(token.start, token.end))).toEqual(['/a', '/b']);
    });
});

describe('filterKnownTokens', () => {
    const tokens = scanPrefixTokens('/Review /unknown /plan', '/');

    test('keeps only tokens present in the known set', () => {
        expect(filterKnownTokens(tokens, new Set(['review', 'plan'])).map((t) => t.name))
            .toEqual(['Review', 'plan']);
    });

    test('case-insensitive is the default comparison', () => {
        expect(filterKnownTokens(tokens, new Set(['review'])).map((t) => t.name))
            .toEqual(['Review']);
    });

    test('exact comparison respects the registered casing', () => {
        expect(filterKnownTokens(tokens, new Set(['review']), 'exact')).toEqual([]);
        expect(filterKnownTokens(tokens, new Set(['Review']), 'exact').map((t) => t.name))
            .toEqual(['Review']);
    });

    test('an empty known set matches nothing', () => {
        expect(filterKnownTokens(tokens, new Set())).toEqual([]);
    });
});

describe('collectKnownTokenNames', () => {
    test('returns distinct names in first-occurrence order', () => {
        expect(collectKnownTokenNames(
            '/plan and /review and /plan again',
            '/',
            new Set(['plan', 'review']),
        )).toEqual(['plan', 'review']);
    });

    test('unknown tokens are dropped', () => {
        expect(collectKnownTokenNames('/plan /nope', '/', new Set(['plan'])))
            .toEqual(['plan']);
    });

    test('exact comparison is available for registry-cased names', () => {
        expect(collectKnownTokenNames('/Deploy', '/', new Set(['Deploy']), 'exact'))
            .toEqual(['Deploy']);
        expect(collectKnownTokenNames('/deploy', '/', new Set(['Deploy']), 'exact'))
            .toEqual([]);
    });

    test('no tokens yields an empty list', () => {
        expect(collectKnownTokenNames('plain text', '/', new Set(['plan']))).toEqual([]);
    });
});
