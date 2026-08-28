import { describe, test, expect } from 'bun:test';

import { capToolOutputText, TOOL_OUTPUT_MAX_CHARS } from './toolRenderers';

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
