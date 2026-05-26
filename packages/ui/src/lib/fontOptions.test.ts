import { describe, expect, test } from 'bun:test';

import {
    DEFAULT_MONO_FONT,
    DEFAULT_UI_FONT,
    getMonoFontStack,
    getUiFontStack,
    normalizeCustomFontFamily,
    sanitizeCustomFontInput,
    UI_FONT_OPTION_MAP,
} from './fontOptions';

describe('font options', () => {
    test('builds custom UI font stack with selected preset fallback', () => {
        expect(getUiFontStack(DEFAULT_UI_FONT, 'Berkeley Mono')).toBe(
            `"Berkeley Mono", ${UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack}`,
        );
    });

    test('treats generic font families as CSS keywords', () => {
        expect(getMonoFontStack(DEFAULT_MONO_FONT, 'ui-monospace').startsWith('ui-monospace, ')).toBe(true);
    });

    test('escapes custom font family names before placing them in CSS', () => {
        expect(getUiFontStack(DEFAULT_UI_FONT, 'A "Quoted" Font').startsWith('"A \\"Quoted\\" Font", ')).toBe(true);
    });

    test('normalizes pasted custom font names without making typing spaces impossible', () => {
        expect(sanitizeCustomFontInput('SF ')).toBe('SF ');
        expect(normalizeCustomFontFamily('  "SF   Pro Text"  ')).toBe('SF Pro Text');
    });

    test('replaces C0 and C1 control characters', () => {
        expect(sanitizeCustomFontInput('Mono\u0000Lisa\u0085Font')).toBe('Mono Lisa Font');
    });

    test('falls back to preset stack for blank custom font names', () => {
        expect(getUiFontStack(DEFAULT_UI_FONT, '   ')).toBe(UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack);
    });
});
