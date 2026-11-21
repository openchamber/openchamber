import { describe, expect, test } from 'bun:test';

import { quoteDisplayText } from './quoteDisplayText';

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
