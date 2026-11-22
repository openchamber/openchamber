import { describe, expect, test } from 'bun:test';
import { excerptMarkdown } from './messageMarkdown';

const marker = '\n\n[Content omitted]\n\n';

// A lone surrogate encodes as U+FFFD on a UTF-8 round-trip, so either check
// catches a cut that landed inside a surrogate pair.
const loneSurrogatePattern = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const utf8RoundTrip = (text: string): string => Buffer.from(text, 'utf8').toString('utf8');

describe('excerptMarkdown', () => {
    test('returns under-limit input unchanged', () => {
        expect(excerptMarkdown('short text', 1500)).toBe('short text');
        expect(excerptMarkdown('a'.repeat(1500), 1500)).toBe('a'.repeat(1500));
    });

    test('keeps the exact limit for over-limit ASCII input', () => {
        const out = excerptMarkdown('a'.repeat(3000), 1500);
        expect(out).toHaveLength(1500);
        expect(out).toContain(marker);
    });

    test('drops a partial pair at the head cut', () => {
        for (const limit of [1500, 4000]) {
            const head = Math.ceil((limit - marker.length) / 2);
            const text = 'a'.repeat(head - 1) + '😀' + 'b'.repeat(limit);
            const out = excerptMarkdown(text, limit);
            expect(out).toContain(marker);
            expect(loneSurrogatePattern.test(out)).toBe(false);
            expect(utf8RoundTrip(out)).not.toContain('�');
            expect(out).toHaveLength(limit - 1);
            expect(out.endsWith('b'.repeat(Math.floor((limit - marker.length) / 2)))).toBe(true);
        }
    });

    test('drops a partial pair at the tail cut', () => {
        for (const limit of [1500, 4000]) {
            const tail = Math.floor((limit - marker.length) / 2);
            const text = 'a'.repeat(limit) + '😀' + 'b'.repeat(tail - 1);
            const out = excerptMarkdown(text, limit);
            expect(out).toContain(marker);
            expect(loneSurrogatePattern.test(out)).toBe(false);
            expect(utf8RoundTrip(out)).not.toContain('�');
            expect(out).toHaveLength(limit - 1);
            expect(out.startsWith('a'.repeat(Math.ceil((limit - marker.length) / 2)))).toBe(true);
        }
    });

    test('keeps a pair that ends exactly on the head boundary', () => {
        const head = Math.ceil((1500 - marker.length) / 2);
        const text = 'a'.repeat(head - 2) + '😀' + 'b'.repeat(1500);
        const out = excerptMarkdown(text, 1500);
        expect(out).toHaveLength(1500);
        expect(loneSurrogatePattern.test(out)).toBe(false);
        expect(out.slice(0, head)).toBe('a'.repeat(head - 2) + '😀');
    });
});
