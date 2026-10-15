import { describe, expect, test } from 'bun:test';

import { getDefaultTheme } from '@/lib/theme/themes';

import {
    buildHtmlRenderDocument,
    HTML_RENDER_TOUCH_MAX_HEIGHT,
    clampHtmlRenderHeight,
    htmlRenderFileName,
    htmlRenderTheme,
    readHtmlRenderFrameMessage,
    type HtmlRenderTheme,
} from './htmlRender';

const theme: HtmlRenderTheme = {
    appearance: 'dark',
    variables: { '--background': '#111', '--foreground': '#eee', 'not-a-variable': 'x', '--evil': 'red;}</style><script>' },
};

const bootstrapAt = (document: string) => document.indexOf('<style id="oc-html-render-theme">');

describe('buildHtmlRenderDocument', () => {
    test('puts the bootstrap first in the head, ahead of the page\'s own styles', () => {
        const page = '<!doctype html><html><head><style>p{color:red}</style></head><body><p>a</p></body></html>';
        const document = buildHtmlRenderDocument(page, theme);
        expect(bootstrapAt(document)).toBeGreaterThan(document.indexOf('<head>'));
        expect(bootstrapAt(document)).toBeLessThan(document.indexOf('<style>p{color:red}'));
        expect(document).toContain('<body><p>a</p></body>');
    });

    test('adds a head to a page without one', () => {
        expect(buildHtmlRenderDocument('<html><body>x</body></html>', theme).startsWith('<html><head><meta charset')).toBe(true);
        expect(buildHtmlRenderDocument('<!DOCTYPE html><body>x</body>', theme).startsWith('<!DOCTYPE html><head><meta charset')).toBe(true);
        const bare = buildHtmlRenderDocument('<p>bare</p>', theme);
        expect(bare.startsWith('<!doctype html><head>')).toBe(true);
        expect(bare.endsWith('</head><p>bare</p>')).toBe(true);
    });

    test('never lands inside a script or comment that mentions a head', () => {
        const page = '<!-- <head> --><script>const s = "<head>";</script><html><head></head><body></body></html>';
        const document = buildHtmlRenderDocument(page, theme);
        expect(document.startsWith('<!-- <head> --><script>const s = "<head>";</script><html><head><meta')).toBe(true);
    });

    test('stops the bounce only for a contained frame, in a style a theme switch leaves alone', () => {
        const contained = '<style>html{overscroll-behavior:none}</style>';
        expect(buildHtmlRenderDocument('<p>a</p>', theme)).not.toContain(contained);
        expect(buildHtmlRenderDocument('<p>a</p>', theme, { contained: true })).toContain(contained);
    });

    test('keeps the page\'s own charset and viewport', () => {
        const page = '<html><head><meta charset="windows-1251"><meta name="viewport" content="width=600"></head></html>';
        const document = buildHtmlRenderDocument(page, theme);
        expect(document.match(/<meta charset/g)).toHaveLength(1);
        expect(document.match(/name="viewport"/g)).toHaveLength(1);
    });

    test('relays the page\'s selection and its clearing to the host', () => {
        const document = buildHtmlRenderDocument('<p>a</p>', theme);
        expect(document).toContain('"openchamber:html-render:selection"');
        expect(document).toContain('addEventListener("selectionchange"');
        expect(document).toContain('window.getSelection()');
    });

    test('answers the host\'s clear, marks and reveal messages, and reports clicks on marks', () => {
        const document = buildHtmlRenderDocument('<p>a</p>', theme);
        for (const type of ['clear-selection', 'marks', 'reveal', 'mark-click']) {
            expect(document).toContain(`"openchamber:html-render:${type}"`);
        }
        expect(document).toContain('CSS.highlights');
        expect(document).toContain('::highlight(oc-chat-quote)');
        expect(document).toContain('--oc-quote-mark');
    });

    test('writes only well-formed variables and strips characters that would close the rule', () => {
        const document = buildHtmlRenderDocument('<p>a</p>', theme);
        expect(document).toContain(':root{color-scheme:dark;--background:#111;--foreground:#eee;--evil:red/stylescript;}');
        expect(document).not.toContain('not-a-variable');
    });
});

describe('readHtmlRenderFrameMessage', () => {
    test('reads the size and link messages the bootstrap posts', () => {
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:size', height: 321.5 } })).toEqual({ kind: 'size', height: 321.5 });
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:open-link', url: 'https://example.com/a' } }))
            .toEqual({ kind: 'open-link', url: 'https://example.com/a' });
    });

    test('reads a Cmd or Ctrl chord the page passed on, and nothing more', () => {
        const chord = { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false };
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:key', ...chord, extra: 'dropped' } }))
            .toEqual({ kind: 'key', chord });
        // Plain typing never reaches the app's single-key shortcuts.
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:key', ...chord, metaKey: false } })).toBeNull();
    });

    test('reads a selection the page reports, trimmed, and its cleared form', () => {
        const rect = { top: 4, left: 8, width: 120, height: 18 };
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:selection', text: '  picked words \n', rect } }))
            .toEqual({ kind: 'selection', text: 'picked words', rect });
        const none = { top: 0, left: 0, width: 0, height: 0 };
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:selection', text: '', rect: none } }))
            .toEqual({ kind: 'selection', text: '', rect: none });
    });

    test('rejects a malformed or oversized selection', () => {
        const type = 'openchamber:html-render:selection';
        const rect = { top: 0, left: 0, width: 10, height: 10 };
        expect(readHtmlRenderFrameMessage({ data: { type, rect } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, text: 'a' } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, text: 5, rect } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, text: 'a', rect: { ...rect, width: -1 } } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, text: 'a', rect: { ...rect, top: Number.NaN } } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, text: 'a', rect: { ...rect, left: 'x' } } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, text: 'a'.repeat(20_001), rect } })).toBeNull();
    });

    test('reads the anchor a selection carries, dropping a malformed one rather than the selection', () => {
        const type = 'openchamber:html-render:selection';
        const rect = { top: 4, left: 8, width: 120, height: 18 };
        const anchor = { text: 'picked words', prefix: 'the ', suffix: ' here', start: 4 };
        expect(readHtmlRenderFrameMessage({ data: { type, text: 'picked words', rect, anchor } }))
            .toEqual({ kind: 'selection', text: 'picked words', rect, anchor });
        // Fields beyond the anchor's own (a forged `page`) are dropped.
        expect(readHtmlRenderFrameMessage({ data: { type, text: 'picked words', rect, anchor: { ...anchor, page: { partId: 'x' } } } }))
            .toEqual({ kind: 'selection', text: 'picked words', rect, anchor });
        for (const bad of [{ ...anchor, start: -1 }, { ...anchor, text: 5 }, { text: 'a' }, 'nope']) {
            expect(readHtmlRenderFrameMessage({ data: { type, text: 'picked words', rect, anchor: bad } }))
                .toEqual({ kind: 'selection', text: 'picked words', rect });
        }
        // A cleared selection has no anchor, whatever the page sent.
        expect(readHtmlRenderFrameMessage({ data: { type, text: '', rect, anchor } })).toEqual({ kind: 'selection', text: '', rect });
    });

    test('reads a click on a quote mark, or on none', () => {
        const type = 'openchamber:html-render:mark-click';
        const rect = { top: 4, left: 8, width: 120, height: 18 };
        expect(readHtmlRenderFrameMessage({ data: { type, id: 'mark-1', rect } })).toEqual({ kind: 'mark-click', id: 'mark-1', rect });
        expect(readHtmlRenderFrameMessage({ data: { type, id: '', rect } })).toEqual({ kind: 'mark-click', id: '', rect });
        expect(readHtmlRenderFrameMessage({ data: { type, rect } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, id: 'm', rect: { ...rect, width: -1 } } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type, id: 'm'.repeat(201), rect } })).toBeNull();
    });

    test('ignores anything else, including links that are not http(s)', () => {
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:open-link', url: 'javascript:alert(1)' } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:size', height: -1 } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type: 'other', height: 10 } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: 'openchamber:html-render:size' })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: null })).toBeNull();
    });
});

describe('helpers', () => {
    test('clamps the frame between its minimum and the height past which the page scrolls', () => {
        expect(clampHtmlRenderHeight(10)).toBe(48);
        expect(clampHtmlRenderHeight(300.2)).toBe(301);
        expect(clampHtmlRenderHeight(5000)).toBe(1200);
        expect(clampHtmlRenderHeight(5000, HTML_RENDER_TOUCH_MAX_HEIGHT)).toBe(5000);
    });

    test('names the download after the page title', () => {
        expect(htmlRenderFileName('Q3 revenue: by region / product')).toBe('Q3 revenue by region product.html');
        expect(htmlRenderFileName('  ')).toBe('page.html');
    });
});

describe('htmlRenderTheme', () => {
    test('leads the chart series with the accent and follows it with the fixed set for the mode', () => {
        const fonts = { sans: 'sans-serif', mono: 'monospace' };
        for (const dark of [true, false]) {
            const theme = getDefaultTheme(dark);
            const { appearance, variables } = htmlRenderTheme(theme, fonts);
            expect(appearance).toBe(dark ? 'dark' : 'light');
            expect(variables['--chart-1']).toBe(theme.colors.primary.base);
            const series = [2, 3, 4, 5, 6].map((index) => variables[`--chart-${index}`]);
            expect(series).toEqual(dark
                ? ['#60a5fa', '#2dd4bf', '#a78bfa', '#f472b6', '#a3e635']
                : ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#65a30d']);
        }
    });
});
