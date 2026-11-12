import { describe, test, expect } from 'bun:test';
import { coerceToText } from '../../toolRenderers';

describe('coerceToText (issue #2011)', () => {
    test('returns strings unchanged', () => {
        expect(coerceToText('hello')).toBe('hello');
    });

    test('coerces plain objects to JSON strings', () => {
        // The exact shape that produced React error #31: object with {TODO} key
        const result = coerceToText({ TODO: 'Review the diff' });
        expect(typeof result).toBe('string');
        expect(result).toContain('TODO');
        expect(result).toContain('Review the diff');
    });

    test('coerces nested objects to JSON strings', () => {
        const result = coerceToText({ todos: [{ TODO: 'a' }, { content: 'b' }] });
        expect(typeof result).toBe('string');
        const parsed = JSON.parse(result);
        expect(parsed).toBeTruthy();
    });

    test('coerces numbers and booleans', () => {
        expect(coerceToText(42)).toBe('42');
        expect(coerceToText(true)).toBe('true');
        expect(coerceToText(false)).toBe('false');
    });

    test('returns fallback for null/undefined', () => {
        expect(coerceToText(null)).toBe('');
        expect(coerceToText(undefined)).toBe('');
        expect(coerceToText(null, 'oops')).toBe('oops');
    });

    test('handles circular structures without throwing', () => {
        const obj: Record<string, unknown> = {};
        obj.self = obj;
        // Must not throw, must not recurse forever
        const result = coerceToText(obj);
        expect(typeof result).toBe('string');
    });
});
