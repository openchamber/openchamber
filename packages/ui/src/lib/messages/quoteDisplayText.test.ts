import { describe, expect, test } from 'bun:test';

import { chatQuoteExcerpt, quoteDisplayText } from './quoteDisplayText';

describe('quoteDisplayText', () => {
    test('drops emphasis, code ticks and list markers, keeps line breaks', () => {
        expect(quoteDisplayText('- **App running:** the file is there, `transform` adds tools.\n- **Closed:** gone'))
            .toBe('App running: the file is there, transform adds tools.\nClosed: gone');
    });

    test('keeps a link text and drops its target', () => {
        expect(quoteDisplayText('see [the issue](https://example.com/1) and > not this')).toBe('see the issue and > not this');
    });

    test('drops quote and heading markers at a line start only', () => {
        expect(quoteDisplayText('> quoted\n## Title\n1. first')).toBe('quoted\nTitle\nfirst');
    });

    test('leaves single asterisks and underscores in the text', () => {
        expect(quoteDisplayText('snake_case and a * b')).toBe('snake_case and a * b');
    });
});

describe('chatQuoteExcerpt', () => {
    test('returns plain quote without context when anchor is absent or empty', () => {
        expect(chatQuoteExcerpt('line one\nline two')).toEqual({
            prefix: '',
            quote: 'line one\nline two',
            suffix: '',
            hasContext: false,
            dir: 'ltr',
        });
        expect(chatQuoteExcerpt('whole reply', { prefix: '   ', suffix: '\n' })).toEqual({
            prefix: '',
            quote: 'whole reply',
            suffix: '',
            hasContext: false,
            dir: 'ltr',
        });
    });

    test('adds ellipses only on clipped sides and preserves newlines inside the selection', () => {
        const prefix = 'прав, якщо реліз не найближчий. ';
        const suffix = ' Якщо ні, порівняння навіть скро';
        expect(prefix.length).toBe(32);
        expect(suffix.length).toBe(32);

        expect(chatQuoteExcerpt('**1.1 ГБ**\n  взято зі скріна.', { prefix, suffix, start: 80 })).toEqual({
            prefix: '…прав, якщо реліз не найближчий. ',
            quote: '1.1 ГБ\n  взято зі скріна.',
            suffix: ' Якщо ні, порівняння навіть скро…',
            hasContext: true,
            dir: 'ltr',
        });
    });

    test('omits leading ellipsis when a 32-char prefix starts at offset 0', () => {
        const prefix = 'a'.repeat(32);
        expect(chatQuoteExcerpt('next', { prefix, suffix: '', start: 32 })).toEqual({
            prefix,
            quote: 'next',
            suffix: '',
            hasContext: true,
            dir: 'ltr',
        });
    });

    test('moves leading or trailing whitespace from the selection onto the gap so words stay separated', () => {
        expect(chatQuoteExcerpt(' Chamber ', { prefix: 'Open', suffix: 'works' })).toEqual({
            prefix: 'Open ',
            quote: 'Chamber',
            suffix: ' works',
            hasContext: true,
            dir: 'ltr',
        });
    });

    test('keeps mid-word selections attached without inserting spaces', () => {
        expect(chatQuoteExcerpt('Chamber', { prefix: 'Open', suffix: '!' })).toEqual({
            prefix: 'Open',
            quote: 'Chamber',
            suffix: '!',
            hasContext: true,
            dir: 'ltr',
        });
    });

    test('strips split surrogate code units at clipped context edges', () => {
        const rocket = '🚀';
        const prefix = `${rocket[1]}after `;
        const suffix = ` before${rocket[0]}`;
        expect(chatQuoteExcerpt('mid', { prefix, suffix })).toEqual({
            prefix: 'after ',
            quote: 'mid',
            suffix: ' before',
            hasContext: true,
            dir: 'ltr',
        });
    });

    test('resolves RTL direction for Arabic text that starts with a Latin word', () => {
        expect(chatQuoteExcerpt('هذا النص العربي', { prefix: 'React يشرح ', suffix: ' بالتفصيل' }).dir).toBe('rtl');
    });
});
