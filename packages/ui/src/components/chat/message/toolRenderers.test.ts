import { describe, test, expect } from 'bun:test';
import type { JsonValue } from '@/lib/opencode/model';

import { capToolOutputText, TOOL_OUTPUT_MAX_CHARS, unwrapTextBlocks } from './toolRenderers';

// Regression coverage for issue #2265: the desktop renderer hard-crashes with a
// V8 "Zone Allocation failed" OOM when a tool returns oversized external content
// (e.g. a fetched Google Slides page with full-resolution base64 images inlined),
// because the whole payload previously flowed through JSON.parse / syntax
// highlighting / DOM rendering as a single unbounded JS string. capToolOutputText
// is the bounded size guard that runs before any of that work.
describe('capToolOutputText (issue #2265 renderer OOM guard)', () => {
    test('exposes a sane positive default cap', () => {
        expect(typeof TOOL_OUTPUT_MAX_CHARS).toBe('number');
        expect(TOOL_OUTPUT_MAX_CHARS).toBeGreaterThan(0);
    });

    test('returns short output unchanged', () => {
        const output = 'hello world';
        expect(capToolOutputText(output)).toBe(output);
    });

    test('returns output at exactly the cap unchanged', () => {
        const output = 'a'.repeat(TOOL_OUTPUT_MAX_CHARS);
        expect(capToolOutputText(output)).toBe(output);
        expect(capToolOutputText(output).length).toBe(TOOL_OUTPUT_MAX_CHARS);
    });

    test('caps oversized output and never emits the full string', () => {
        const oversized = 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 10_000);
        const capped = capToolOutputText(oversized);

        // The pathological full-size string must not survive to the renderer.
        expect(capped.length).toBeLessThan(oversized.length);
        // Head of the payload is preserved for the user.
        expect(capped.startsWith('x'.repeat(1000))).toBe(true);
        // A truncation notice is appended so the truncation is visible.
        expect(capped).toContain('output truncated');
        expect(capped).toContain('10000 more characters');
    });

    test('honors a custom cap', () => {
        const output = 'abcdefghij'; // 10 chars
        const capped = capToolOutputText(output, 4);
        expect(capped.startsWith('abcd')).toBe(true);
        expect(capped).toContain('output truncated');
        // Only the first 4 chars of the original body are retained.
        expect(capped).not.toContain('efghij');
    });

    test('simulated large webfetch payload is bounded well below original size', () => {
        // ~6MB single string, matching the 5MB-20MB Zone-allocation trigger range
        // described in the issue (a Slides page with embedded base64 images).
        const base64Blob = 'QUJD'.repeat(1_500_000); // 6,000,000 chars
        const capped = capToolOutputText(base64Blob);

        expect(base64Blob.length).toBeGreaterThan(5_000_000);
        expect(capped.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 256);
        expect(capped).toContain('renderer from running out of memory');
    });

    test('non-string input is returned unchanged (defensive)', () => {
        // @ts-expect-error verifying runtime robustness against non-string inputs
        expect(capToolOutputText(undefined)).toBeUndefined();
        // @ts-expect-error verifying runtime robustness against non-string inputs
        expect(capToolOutputText(null)).toBeNull();
    });
});

// Regression coverage for issue #5067: a finished v2 tool call carries its result
// as text content blocks, and the transport may serialize that array once more,
// so the parsed JSON is a wrapper around the text rather than the text.
describe('unwrapTextBlocks (issue #5067 text-block tool results)', () => {
    const block = (text: string) => ({ type: 'text', text });
    const TEXT = 'skills-root /c/a\nskills-root /c/b';

    test('joins text blocks on a newline, newlines inside kept and nothing trimmed', () => {
        expect(unwrapTextBlocks([block(TEXT)])).toBe(TEXT);
        expect(unwrapTextBlocks([block('a'), block('b')])).toBe('a\nb');
        expect(unwrapTextBlocks([block('  padded \n')])).toBe('  padded \n');
    });

    test('accepts a single text block outside an array', () => {
        expect(unwrapTextBlocks(block('alone'))).toBe('alone');
    });

    test('a leading empty block adds no separator, a trailing one does', () => {
        expect(unwrapTextBlocks([block(''), block('a')])).toBe('a');
        expect(unwrapTextBlocks([block(''), block(''), block('a')])).toBe('a');
        expect(unwrapTextBlocks([block('a'), block('')])).toBe('a\n');
        expect(unwrapTextBlocks([block('')])).toBe('');
    });

    test('unwraps a serialized text-block list inside the text, four passes at most', () => {
        const wrap = (value: JsonValue) => [block(JSON.stringify(value))];
        const once = [block(TEXT)];
        const twice = wrap(once);
        const thrice = wrap(twice);
        const four = wrap(thrice);
        const five = wrap(four);
        expect(unwrapTextBlocks(twice)).toBe(TEXT);
        expect(unwrapTextBlocks(thrice)).toBe(TEXT);
        expect(unwrapTextBlocks(four)).toBe(TEXT);
        // The fourth pass reads the fourth wrapper's text and stops there.
        expect(unwrapTextBlocks(five)).toBe(JSON.stringify(once));
    });

    test('unwraps a serialized single text block inside the text', () => {
        expect(unwrapTextBlocks([block(JSON.stringify(block('inner')))])).toBe('inner');
    });

    test('accepts text blocks with extra fields at every level', () => {
        const inner = { type: 'text', text: 'inner', annotations: { priority: 1 } };
        expect(unwrapTextBlocks(inner)).toBe('inner');
        expect(unwrapTextBlocks([{ ...inner, text: JSON.stringify(inner) }])).toBe('inner');
    });

    test('all-empty blocks produce an empty string', () => {
        expect(unwrapTextBlocks([block(''), block(''), block('')])).toBe('');
    });

    test('keeps text that merely looks like JSON', () => {
        expect(unwrapTextBlocks([block('{"k":1}')])).toBe('{"k":1}');
        expect(unwrapTextBlocks([block('[1,2]')])).toBe('[1,2]');
        expect(unwrapTextBlocks([block('[]')])).toBe('[]');
        expect(unwrapTextBlocks([block('[not json]')])).toBe('[not json]');
        expect(unwrapTextBlocks([block('[{"type":"image","data":"x"}]')])).toBe('[{"type":"image","data":"x"}]');
        const mixed = JSON.stringify([block('text'), { type: 'image', data: 'x' }]);
        expect(unwrapTextBlocks([block(mixed)])).toBe(mixed);
    });

    test('falls back to the joined text when a nested envelope holds non-text entries', () => {
        // Regression: the first non-text entry must stop the nested-envelope
        // parse immediately. Validating the whole array in one schema pass
        // accumulated an error per entry and stalled the renderer on large
        // structured payloads like this 250k-number array.
        const big = JSON.stringify(Array(250_000).fill(0));
        expect(unwrapTextBlocks([block(big)])).toBe(big);
    });

    test('does not truncate the text it unwraps', () => {
        const text = '  first\n' + 'content\n'.repeat(100_000) + 'last  ';
        expect(unwrapTextBlocks([block(text)])).toBe(text);
    });

    test('returns null for anything that is not a non-empty list of text blocks', () => {
        expect(unwrapTextBlocks({ command: 'ls', exit: 0 })).toBeNull();
        expect(unwrapTextBlocks([block('a'), { type: 'image', data: 'x' }])).toBeNull();
        expect(unwrapTextBlocks([{ type: 'text' }])).toBeNull();
        expect(unwrapTextBlocks([{ type: 'text', text: 1 }])).toBeNull();
        expect(unwrapTextBlocks([])).toBeNull();
        expect(unwrapTextBlocks({})).toBeNull();
        expect(unwrapTextBlocks(null)).toBeNull();
        expect(unwrapTextBlocks('text')).toBeNull();
        expect(unwrapTextBlocks([null])).toBeNull();
    });
});
