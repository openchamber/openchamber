import { describe, expect, test } from 'bun:test';

import {
    LARGE_TEXT_PASTE_CHAR_THRESHOLD,
    LARGE_TEXT_PASTE_LINE_THRESHOLD,
    createPastedContextFile,
    isLargePlainTextPaste,
} from '../largeTextPaste';

describe('large text paste helpers', () => {
    test('treats short text as not large', () => {
        expect(isLargePlainTextPaste('hello world')).toBe(false);
        expect(isLargePlainTextPaste('line1\nline2\nline3')).toBe(false);
    });

    test('treats empty and whitespace-only pastes as not large', () => {
        expect(isLargePlainTextPaste('')).toBe(false);
        expect(isLargePlainTextPaste('   \n\t  ')).toBe(false);
    });

    test('detects pastes at the character threshold', () => {
        const text = 'a'.repeat(LARGE_TEXT_PASTE_CHAR_THRESHOLD);
        expect(isLargePlainTextPaste(text)).toBe(true);
        expect(isLargePlainTextPaste(text.slice(0, -1))).toBe(false);
    });

    test('detects pastes at the line threshold', () => {
        const lines = Array.from({ length: LARGE_TEXT_PASTE_LINE_THRESHOLD }, (_, index) => `line ${index}`);
        expect(isLargePlainTextPaste(lines.join('\n'))).toBe(true);
        expect(isLargePlainTextPaste(lines.slice(0, -1).join('\n'))).toBe(false);
    });

    test('honors custom thresholds', () => {
        expect(isLargePlainTextPaste('abcdef', { charThreshold: 5 })).toBe(true);
        expect(isLargePlainTextPaste('a\nb\nc', { lineThreshold: 3 })).toBe(true);
        expect(isLargePlainTextPaste('a\nb', { lineThreshold: 3, charThreshold: 100 })).toBe(false);
    });

    test('creates a text/plain file with the given name', async () => {
        const file = createPastedContextFile('architecture notes', 'pasted-context-1.txt');
        expect(file.name).toBe('pasted-context-1.txt');
        expect(file.type.startsWith('text/plain')).toBe(true);
        expect(await file.text()).toBe('architecture notes');
    });
});
