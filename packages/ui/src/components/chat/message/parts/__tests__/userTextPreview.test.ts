import { describe, test, expect } from 'bun:test';
import { buildUserTextPreview, countAdditionalLines } from '../userTextPreview';

describe('buildUserTextPreview', () => {
    test('returns empty string for empty input', () => {
        expect(buildUserTextPreview('')).toBe('');
    });

    test('returns single short line unchanged', () => {
        expect(buildUserTextPreview('Hello world')).toBe('Hello world');
    });

    test('collapses internal whitespace and newlines to single spaces', () => {
        expect(buildUserTextPreview('foo\n\nbar\n\nbaz')).toBe('foo bar baz');
    });

    test('truncates with ellipsis when over maxChars', () => {
        const long = 'a'.repeat(200);
        const out = buildUserTextPreview(long, 50);
        expect(out.length).toBe(50);
        expect(out.endsWith('…')).toBe(true);
    });

    test('strips ATX headings on the first line', () => {
        expect(buildUserTextPreview('# Hello\nworld')).toBe('Hello world');
    });

    test('strips blockquote and list markers', () => {
        expect(buildUserTextPreview('> quoted\n- item one\n- item two')).toBe('quoted item one item two');
    });

    test('strips inline code backticks but keeps contents', () => {
        expect(buildUserTextPreview('use `foo()` here')).toBe('use foo() here');
    });

    test('flattens fenced code block contents into the preview', () => {
        const input = 'before\n```js\nconst x = 1;\n```\nafter';
        expect(buildUserTextPreview(input)).toBe('before const x = 1; after');
    });

    test('strips bold and italic markers', () => {
        expect(buildUserTextPreview('**bold** and *italic* and __also__ and _italic2_')).toBe('bold and italic and also and italic2');
    });

    test('handles yaml-like fenced block without crashing', () => {
        const input = '```yaml\nkey: value\nother: list\n```\nfinal';
        expect(buildUserTextPreview(input)).toBe('key: value other: list final');
    });
});

describe('countAdditionalLines', () => {
    test('returns 0 for empty input', () => {
        expect(countAdditionalLines('')).toBe(0);
    });

    test('returns 0 for a single non-empty line', () => {
        expect(countAdditionalLines('hello')).toBe(0);
    });

    test('returns 0 when surrounding whitespace makes it a single visible line', () => {
        expect(countAdditionalLines('\n\nhello\n\n')).toBe(0);
    });

    test('counts additional non-empty lines', () => {
        expect(countAdditionalLines('a\nb\nc')).toBe(2);
    });

    test('ignores empty lines between non-empty ones', () => {
        expect(countAdditionalLines('a\n\n\nb\n\nc')).toBe(2);
    });

    test('handles list-like content', () => {
        expect(countAdditionalLines('- one\n- two\n- three\n- four')).toBe(3);
    });
});
