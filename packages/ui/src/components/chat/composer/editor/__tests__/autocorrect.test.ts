import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { composerAutoCorrect, type ComposerAutoCorrect } from '../autocorrect';

const platform = (overrides: Partial<Navigator>): Navigator => ({
    maxTouchPoints: 0,
    platform: '',
    userAgent: '',
    vendor: '',
    ...overrides,
} as Navigator);

const codeMirrorKeepsDoubleSpacePeriod = (
    autoCorrect: ComposerAutoCorrect,
): boolean => autoCorrect !== 'off';

const affectedPlatforms: Array<[string, Navigator]> = [
    ['macOS', platform({ platform: 'MacIntel' })],
    ['iPhone', platform({
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 Mobile/15E148 Safari/604.1',
        vendor: 'Apple Computer, Inc.',
    })],
    ['iPadOS touch detection', platform({
        maxTouchPoints: 5,
        userAgent: 'Mozilla/5.0 Version/17.4 Safari/605.1.15',
        vendor: 'Apple Computer, Inc.',
    })],
    ['Android', platform({
        platform: 'Linux armv8l',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
    })],
];

const unaffectedPlatforms: Array<[string, Navigator]> = [
    ['Windows', platform({ platform: 'Win32' })],
    ['Linux', platform({ platform: 'Linux x86_64' })],
];

describe('composerAutoCorrect', () => {
    test('matches the pinned CodeMirror period-revert guard', () => {
        const source = readFileSync(
            fileURLToPath(import.meta.resolve('@codemirror/view')),
            'utf8',
        );
        const semantics = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\s+/g, '');

        expect(/getAttribute\(["']autocorrect["']\)==["']off["']/.test(semantics)).toBe(true);
        expect(semantics).toContain(
            'constios=safari&&(/Mobile\\/\\w+/.test(nav.userAgent)||nav.maxTouchPoints>2)',
        );
        expect(semantics).toContain('mac:ios||/Mac/.test(nav.platform)');
        expect(semantics).toContain('android:/Android\\b/.test(nav.userAgent)');
    });

    for (const [name, navigator] of affectedPlatforms) {
        test(`preserves the ${name} platform period without enabling autocorrect`, () => {
            const autoCorrect = composerAutoCorrect({ isMobile: false, navigator });

            expect(autoCorrect.toLowerCase()).toBe('off');
            // @codemirror/view 6.39.13 reverts the native period only for exact "off".
            expect(codeMirrorKeepsDoubleSpacePeriod(autoCorrect)).toBe(true);
        });
    }

    for (const [name, navigator] of unaffectedPlatforms) {
        test(`leaves desktop correction off on ${name}`, () => {
            expect(composerAutoCorrect({ isMobile: false, navigator })).toBe('off');
        });
    }

    test('uses CodeMirror platform detection rather than a macOS user agent', () => {
        expect(composerAutoCorrect({
            isMobile: false,
            navigator: platform({
                platform: 'Linux x86_64',
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
            }),
        })).toBe('off');
    });

    test('preserves the existing mobile autocorrect policy', () => {
        expect(composerAutoCorrect({
            isMobile: true,
            navigator: platform({ platform: 'Win32' }),
        })).toBe('on');
    });
});
