import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composerAutoCorrect } from '../autocorrect';

// The installed bundle of @codemirror/view, resolved through the package's
// own node_modules (the same copy the editor imports) rather than through
// the Bun cache, which may hold other versions.
const codeMirrorViewDist = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..', '..', '..',
    'node_modules', '@codemirror', 'view', 'dist', 'index.js',
);

type Signals = Pick<Navigator, 'userAgent' | 'vendor' | 'platform' | 'maxTouchPoints'>;

const signals = (overrides: Partial<Signals>): Signals => ({
    userAgent: '',
    vendor: '',
    platform: '',
    maxTouchPoints: 0,
    ...overrides,
});

// The platforms where @codemirror/view's insert-period-on-double-space
// revert path is live (`browser.mac || browser.android`).
const revertedPlatforms: Array<[string, Signals]> = [
    ['macOS', signals({ platform: 'MacIntel' })],
    ['iPhone', signals({
        platform: 'iPhone',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        vendor: 'Apple Computer, Inc.',
    })],
    ['iPadOS (touch detection)', signals({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15',
        vendor: 'Apple Computer, Inc.',
        maxTouchPoints: 5,
    })],
    ['Android', signals({
        platform: 'Linux armv8l',
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
    })],
];

// The platforms where CodeMirror never reverts, so the literal keyword stays.
const untouchedPlatforms: Array<[string, Signals]> = [
    ['Windows', signals({ platform: 'Win32' })],
    ['Linux', signals({ platform: 'Linux x86_64' })],
];

describe('composerAutoCorrect', () => {
    for (const [name, nav] of revertedPlatforms) {
        test(`keeps desktop correction off on ${name} without tripping CodeMirror's revert`, () => {
            const keyword = composerAutoCorrect({ isMobile: false, navigator: nav });

            // Off to the browser (ASCII case-insensitive), so desktop word
            // correction stays disabled...
            expect(keyword.toLowerCase()).toBe('off');
            // ...but not the exact string CodeMirror matches against, so the
            // platform's insert-period-on-double-space is not rewritten.
            expect(keyword).not.toBe('off');
            expect(keyword).toBe('Off');
        });
    }

    for (const [name, nav] of untouchedPlatforms) {
        test(`emits the literal off keyword on ${name}`, () => {
            expect(composerAutoCorrect({ isMobile: false, navigator: nav })).toBe('off');
        });
    }

    test('detects the platform like CodeMirror does, not by user agent alone', () => {
        // A spoofed macOS UA on Linux must not enable the workaround: the
        // browser still matches `autocorrect` case-insensitively, so `Off`
        // would be harmless — but CodeMirror's revert path is what the
        // spelling must track, and it keys off `nav.platform`.
        expect(composerAutoCorrect({
            isMobile: false,
            navigator: signals({
                platform: 'Linux x86_64',
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            }),
        })).toBe('off');
    });

    test('preserves the mobile policy', () => {
        expect(composerAutoCorrect({
            isMobile: true,
            navigator: signals({ platform: 'Win32' }),
        })).toBe('on');
    });

    test('matches the pinned @codemirror/view revert guard', () => {
        // The `Off` workaround only works while CodeMirror compares the
        // attribute with an exact `== "off"` on the mac/android flags. Read
        // the installed bundle (resolved through the package's own
        // node_modules, not the Bun cache) and match whitespace-tolerantly so
        // non-semantic minifier reformatting does not false-fail; a semantic
        // change (case-insensitive match, different platform flags) is what
        // this test is here to catch.
        const dist = readFileSync(codeMirrorViewDist, 'utf8');

        // The exact-match attribute read that gates the revert path.
        expect(
            /getAttribute\(\s*["']autocorrect["']\s*\)\s*==\s*["']off["']\s*\)/.test(dist),
        ).toBe(true);
        // The period-on-double-space detection both revert paths share.
        expect(/\/\^\\\.\s*\?\$\/?/.test(dist)).toBe(true);
        // The platform flags the guard is gated on.
        expect(/\/Mac\/\.test\(\s*nav\.platform\s*\)/.test(dist)).toBe(true);
        expect(/\/Android\\b\/\.test\(\s*nav\.userAgent\s*\)/.test(dist)).toBe(true);
    });
});
