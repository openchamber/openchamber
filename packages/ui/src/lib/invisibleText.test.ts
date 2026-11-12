import { describe, expect, test } from 'bun:test';

import { isInvisibleText } from './invisibleText';

describe('isInvisibleText', () => {
    test('treats whitespace and zero-width characters alone as invisible', () => {
        for (const text of ['', ' \n\t', '\u200B', '\u200B\u200B', '\u200C\u200D', '\uFEFF', '\u2060', '\u00AD', '\u200E\u200F', '\u200B\n\n\u200B', ' \u200B ']) {
            expect(isInvisibleText(text)).toBe(true);
        }
    });

    test('keeps text that draws something', () => {
        expect(isInvisibleText('Done.')).toBe(false);
        expect(isInvisibleText('\u200Ba')).toBe(false);
        expect(isInvisibleText('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe(false);
        expect(isInvisibleText('\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645')).toBe(false);
        expect(isInvisibleText('\u2800')).toBe(false);
    });
});
