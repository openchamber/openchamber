import { describe, expect, test } from 'bun:test';

import {
    buildHighlightParts,
    isFenceClose,
    matchFenceOpen,
    mentionRangesToHighlightRanges,
    resolveHighlightSegments,
    tokenizeMarkdown,
    type HighlightRange,
} from '../composerHighlight';

/**
 * Characterization tests: they record what the composer highlighter does TODAY,
 * before the CodeMirror migration replaces the textarea + mirror overlay. The
 * token grammar must survive that move unchanged, so these assert token spans
 * and styles rather than rendered classes.
 */

/** Compact view of a range: the exact substring it covers, plus its style. */
const spans = (text: string, ranges: HighlightRange[]) =>
    ranges.map((range) => [text.slice(range.start, range.end), range.style] as const);

const tokenize = (text: string) => spans(text, tokenizeMarkdown(text));

describe('tokenizeMarkdown — block constructs', () => {
    test('headings split into marker and content', () => {
        expect(tokenize('## Title')).toEqual([
            ['##', 'marker'],
            ['Title', 'heading'],
        ]);
    });

    test('heading requires a space after the hashes', () => {
        expect(tokenize('##Title')).toEqual([]);
    });

    test('seven hashes is not a heading', () => {
        expect(tokenize('####### too deep')).toEqual([]);
    });

    test('blockquote marker is dimmed and content styled', () => {
        expect(tokenize('> quoted')).toEqual([
            ['>', 'marker'],
            ['quoted', 'blockquote'],
        ]);
    });

    test('nested blockquote markers collapse into one marker range', () => {
        expect(tokenize('>> deep')).toEqual([
            ['>>', 'marker'],
            ['deep', 'blockquote'],
        ]);
    });

    test('bullet and ordered list markers', () => {
        expect(tokenize('- one')).toEqual([['-', 'listMarker']]);
        expect(tokenize('* one')).toEqual([['*', 'listMarker']]);
        expect(tokenize('+ one')).toEqual([['+', 'listMarker']]);
        expect(tokenize('1. one')).toEqual([['1.', 'listMarker']]);
        expect(tokenize('2) two')).toEqual([['2)', 'listMarker']]);
    });

    test('indented list markers keep their offset', () => {
        expect(tokenize('  - nested')).toEqual([['-', 'listMarker']]);
    });

    test('a list marker needs trailing whitespace', () => {
        expect(tokenize('-nodash')).toEqual([]);
    });
});

describe('tokenizeMarkdown — fenced code', () => {
    test('every line of a fence is codeFence, including the delimiters', () => {
        const text = '```ts\nconst a = 1;\n```';
        expect(tokenize(text)).toEqual([
            ['```ts', 'codeFence'],
            ['const a = 1;', 'codeFence'],
            ['```', 'codeFence'],
        ]);
    });

    test('tilde fences work the same way', () => {
        expect(tokenize('~~~\nbody\n~~~')).toEqual([
            ['~~~', 'codeFence'],
            ['body', 'codeFence'],
            ['~~~', 'codeFence'],
        ]);
    });

    test('markdown inside a fence is not tokenized', () => {
        expect(tokenize('```\n# not a heading\n- not a list\n```')).toEqual([
            ['```', 'codeFence'],
            ['# not a heading', 'codeFence'],
            ['- not a list', 'codeFence'],
            ['```', 'codeFence'],
        ]);
    });

    test('an unterminated fence swallows the rest of the text', () => {
        expect(tokenize('```\nstill open\n# nope')).toEqual([
            ['```', 'codeFence'],
            ['still open', 'codeFence'],
            ['# nope', 'codeFence'],
        ]);
    });

    test('an info-string line does not close its own fence', () => {
        expect(isFenceClose('```js', '```')).toBe(false);
        expect(isFenceClose('```', '```')).toBe(true);
        expect(isFenceClose('  ```  ', '```')).toBe(true);
    });

    test('a closing fence may be longer than the opening run', () => {
        expect(isFenceClose('````', '```')).toBe(true);
        expect(isFenceClose('``', '```')).toBe(false);
    });

    test('matchFenceOpen reports marker and language', () => {
        expect(matchFenceOpen('```ts')).toEqual({ marker: '```', lang: 'ts' });
        expect(matchFenceOpen('~~~~')).toEqual({ marker: '~~~~', lang: '' });
        expect(matchFenceOpen('``')).toBeNull();
    });
});

describe('tokenizeMarkdown — inline spans', () => {
    test('inline code covers the backticks as well as the content', () => {
        expect(tokenize('run `bun test` now')).toEqual([['`bun test`', 'code']]);
    });

    test('a double-backtick run is closed by a matching run', () => {
        expect(tokenize('``a ` b``')).toEqual([['``a ` b``', 'code']]);
    });

    test('an unclosed backtick is left as plain text', () => {
        expect(tokenize('a ` b')).toEqual([]);
    });

    test('links split into markers, text and url', () => {
        expect(tokenize('[docs](https://x.dev)')).toEqual([
            ['[', 'marker'],
            ['docs', 'link'],
            ['](', 'marker'],
            ['https://x.dev', 'linkUrl'],
            [')', 'marker'],
        ]);
    });

    test('an empty link text emits no link range', () => {
        expect(tokenize('[](url)')).toEqual([
            ['[', 'marker'],
            ['](', 'marker'],
            ['url', 'linkUrl'],
            [')', 'marker'],
        ]);
    });

    test('inline spans are scanned inside headings, quotes and list items', () => {
        expect(tokenize('# see `code`')).toEqual([
            ['#', 'marker'],
            ['see `code`', 'heading'],
            ['`code`', 'code'],
        ]);
        expect(tokenize('> see `code`')).toEqual([
            ['>', 'marker'],
            ['see `code`', 'blockquote'],
            ['`code`', 'code'],
        ]);
        expect(tokenize('- see `code`')).toEqual([
            ['-', 'listMarker'],
            ['`code`', 'code'],
        ]);
    });

    test('a bare ~path is not markdown — the language layer owns it', () => {
        expect(tokenize('~/repos/ocb/README.md')).toEqual([]);
    });
});

describe('tokenizeMarkdown — emphasis', () => {
    test('double delimiters are strong, single are emphasis', () => {
        expect(tokenize('**bold**')).toEqual([
            ['**', 'marker'],
            ['bold', 'strong'],
            ['**', 'marker'],
        ]);
        expect(tokenize('*slanted*')).toEqual([
            ['*', 'marker'],
            ['slanted', 'emphasis'],
            ['*', 'marker'],
        ]);
    });

    test('triple delimiters are strong AND emphasis over the same span', () => {
        expect(tokenize('***both***')).toEqual([
            ['***', 'marker'],
            ['both', 'strong'],
            ['both', 'emphasis'],
            ['***', 'marker'],
        ]);
        expect(tokenize('___both___').map(([, style]) => style))
            .toEqual(['marker', 'strong', 'emphasis', 'marker']);
    });

    test('the underscore spellings work too', () => {
        expect(tokenize('_slanted_').map(([, style]) => style))
            .toEqual(['marker', 'emphasis', 'marker']);
        expect(tokenize('__bold__').map(([, style]) => style))
            .toEqual(['marker', 'strong', 'marker']);
    });

    test('arithmetic is not emphasis', () => {
        expect(tokenize('2 * 3 * 4')).toEqual([]);
        expect(tokenize('a * b')).toEqual([]);
    });

    test('an identifier is not emphasis', () => {
        expect(tokenize('foo_bar_baz')).toEqual([]);
        expect(tokenize('SCREAMING_SNAKE_CASE')).toEqual([]);
    });

    test('an underscore span still works between words', () => {
        expect(tokenize('say _this_ loudly').map(([text]) => text))
            .toEqual(['_', 'this', '_']);
    });

    test('a delimiter with nothing after it opens nothing', () => {
        expect(tokenize('trailing * ')).toEqual([]);
        expect(tokenize('ends with *')).toEqual([]);
    });

    test('an unclosed delimiter is left as plain text', () => {
        expect(tokenize('*never closed')).toEqual([]);
    });

    test('emphasis does not span lines', () => {
        expect(tokenize('*open\nclose*')).toEqual([]);
    });

    test('inline spans inside emphasis are still scanned', () => {
        expect(tokenize('**see `code`**').map(([text, style]) => `${text}:${style}`))
            .toContain('`code`:code');
    });

    test('a list marker is not read as emphasis', () => {
        expect(tokenize('* item')).toEqual([['*', 'listMarker']]);
    });

    test('emphasis inside a heading keeps both', () => {
        const text = '# A **strong** title';
        const styles = tokenize(text).map(([, style]) => style);
        expect(styles).toContain('heading');
        expect(styles).toContain('strong');
    });
});

describe('tokenizeMarkdown — attention', () => {
    test('a !!! line marks its content', () => {
        expect(tokenize('!!! important')).toEqual([
            ['!!!', 'marker'],
            ['important', 'attention'],
        ]);
    });

    test('it needs a space after the marks', () => {
        expect(tokenize('!!!important')).toEqual([]);
    });

    test('an emphatic sentence is not an attention line', () => {
        expect(tokenize('that is wild!!!')).toEqual([]);
        expect(tokenize('!! close')).toEqual([]);
    });

    test('inline spans inside an attention line are scanned', () => {
        expect(tokenize('!!! check `this`').map(([, style]) => style))
            .toContain('code');
    });
});

describe('tokenizeMarkdown — offsets across lines', () => {
    test('ranges are absolute offsets into the whole text', () => {
        const text = 'intro\n# Head\n- item';
        const ranges = tokenizeMarkdown(text);
        for (const range of ranges) {
            expect(text.slice(range.start, range.end).length).toBe(range.end - range.start);
        }
        expect(spans(text, ranges)).toEqual([
            ['#', 'marker'],
            ['Head', 'heading'],
            ['-', 'listMarker'],
        ]);
    });

    test('empty input yields no ranges', () => {
        expect(tokenizeMarkdown('')).toEqual([]);
    });
});

describe('mentionRangesToHighlightRanges', () => {
    test('file and agent mentions map to their own styles', () => {
        expect(mentionRangesToHighlightRanges([
            { start: 0, end: 5, kind: 'file' },
            { start: 6, end: 9, kind: 'agent' },
        ])).toEqual([
            { start: 0, end: 5, style: 'mentionFile' },
            { start: 6, end: 9, style: 'mentionAgent' },
        ]);
    });
});

describe('resolveHighlightSegments', () => {
    test('segments tile the whole text without gaps or overlap', () => {
        const text = '# Title\nsee `code` and more';
        const segments = resolveHighlightSegments(text, tokenizeMarkdown(text));
        expect(segments[0].start).toBe(0);
        expect(segments[segments.length - 1].end).toBe(text.length);
        for (let i = 1; i < segments.length; i += 1) {
            expect(segments[i].start).toBe(segments[i - 1].end);
        }
    });

    test('no text and no ranges resolve to nothing', () => {
        expect(resolveHighlightSegments('', [{ start: 0, end: 1, style: 'code' }])).toEqual([]);
        expect(resolveHighlightSegments('abc', [])).toEqual([]);
    });

    test('adjacent same-class stretches are merged into one segment', () => {
        const segments = resolveHighlightSegments('abcdef', [
            { start: 0, end: 3, style: 'code' },
            { start: 3, end: 6, style: 'code' },
        ]);
        expect(segments).toHaveLength(1);
        expect(segments[0].start).toBe(0);
        expect(segments[0].end).toBe(6);
    });

    test('segments agree with the parts the overlay renders', () => {
        const text = 'a `b` c';
        const ranges = tokenizeMarkdown(text);
        const segments = resolveHighlightSegments(text, ranges);
        const parts = buildHighlightParts(text, ranges);
        expect(parts!.map((part) => part.text))
            .toEqual(segments.map((segment) => text.slice(segment.start, segment.end)));
        expect(parts!.map((part) => part.className))
            .toEqual(segments.map((segment) => segment.className));
    });
});

describe('resolveHighlightSegments — additive styles', () => {
    /**
     * A segment carries one class string, so weight and colour cannot be
     * chosen between: emphasis composes onto whatever construct it sits in.
     */
    test('emphasis inside a heading keeps the heading colour and gains weight', () => {
        const text = '# A **strong** title';
        const segment = resolveHighlightSegments(text, tokenizeMarkdown(text))
            .find((candidate) => text.slice(candidate.start, candidate.end) === 'strong');
        expect(segment!.className.includes('font-semibold')).toBe(true);
        expect(segment!.className.includes('--syntax-keyword')).toBe(true);
    });

    test('emphasis on its own still renders over the default text colour', () => {
        const text = '*slanted*';
        const segment = resolveHighlightSegments(text, tokenizeMarkdown(text))
            .find((candidate) => text.slice(candidate.start, candidate.end) === 'slanted');
        expect(segment!.className.includes('italic')).toBe(true);
    });

    test('a style is not repeated when two identical ranges overlap', () => {
        const parts = resolveHighlightSegments('abcd', [
            { start: 0, end: 4, style: 'strong' },
            { start: 0, end: 4, style: 'strong' },
        ]);
        expect(parts[0].className.split('font-semibold').length - 1).toBe(1);
    });
});

describe('buildHighlightParts', () => {
    test('returns null when there is nothing to highlight', () => {
        expect(buildHighlightParts('', [])).toBeNull();
        expect(buildHighlightParts('plain text', [])).toBeNull();
    });

    test('covers the full text and preserves it exactly', () => {
        const text = '# Title\nplain `code` tail';
        const parts = buildHighlightParts(text, tokenizeMarkdown(text));
        expect(parts).not.toBeNull();
        expect(parts!.map((part) => part.text).join('')).toBe(text);
    });

    test('adjacent parts sharing a class are coalesced', () => {
        const parts = buildHighlightParts('abcdef', [
            { start: 0, end: 3, style: 'code' },
            { start: 3, end: 6, style: 'code' },
        ]);
        expect(parts).toHaveLength(1);
        expect(parts![0].text).toBe('abcdef');
    });

    test('higher priority wins on overlap — a mention beats inline code', () => {
        const text = '`@a/b.ts`';
        const parts = buildHighlightParts(text, [
            { start: 0, end: text.length, style: 'code' },
            { start: 1, end: text.length - 1, style: 'mentionFile' },
        ]);
        expect(parts!.map((part) => part.text)).toEqual(['`', '@a/b.ts', '`']);
        expect(parts![1].className).toBe(parts![1].className);
        expect(parts![0].className).not.toBe(parts![1].className);
    });

    test('equal priority resolves to the earliest range in input order', () => {
        const parts = buildHighlightParts('abcd', [
            { start: 0, end: 4, style: 'mentionFile' },
            { start: 0, end: 4, style: 'mentionAgent' },
        ]);
        expect(parts).toHaveLength(1);
        expect(parts![0].className).toBe(
            buildHighlightParts('abcd', [{ start: 0, end: 4, style: 'mentionFile' }])![0].className,
        );
    });

    test('an explicit priority overrides the style table', () => {
        const parts = buildHighlightParts('abcd', [
            { start: 0, end: 4, style: 'mentionFile' },
            { start: 0, end: 4, style: 'marker', priority: 999 },
        ]);
        expect(parts![0].className).toBe(
            buildHighlightParts('abcd', [{ start: 0, end: 4, style: 'marker' }])![0].className,
        );
    });

    test('an explicit className overrides the style class', () => {
        const parts = buildHighlightParts('abcd', [
            { start: 0, end: 4, style: 'code', className: 'custom-class' },
        ]);
        expect(parts).toEqual([{ text: 'abcd', className: 'custom-class' }]);
    });

    test('zero-width ranges are ignored', () => {
        const parts = buildHighlightParts('abcd', [{ start: 2, end: 2, style: 'code' }]);
        expect(parts).toHaveLength(1);
        expect(parts![0].text).toBe('abcd');
    });
});
