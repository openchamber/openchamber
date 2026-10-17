import { describe, expect, test } from 'bun:test';

import { getDefaultTheme } from '@/lib/theme/themes';

import {
    buildHtmlRenderDocument,
    clampHtmlRenderHeight,
    htmlRenderFileName,
    htmlRenderSubmitReply,
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

    test('writes only well-formed variables and strips characters that would close the rule', () => {
        const document = buildHtmlRenderDocument('<p>a</p>', theme);
        expect(document).toContain(':root{color-scheme:dark;--background:#111;--foreground:#eee;--evil:red/stylescript;}');
        expect(document).not.toContain('not-a-variable');
    });
});

describe('answer state', () => {
    test('gives a page that asks ready option and button classes, kept across a theme switch', () => {
        const document = buildHtmlRenderDocument('<p>a</p>', theme);
        for (const rule of ['.oc-options{', '.oc-option{', '.oc-option[aria-pressed=true]{', '.oc-button{']) {
            // Once in the theme style, once in the copy the bootstrap rewrites it with.
            expect(document.split(rule).length - 1).toBe(2);
        }
    });

    test('carries the page\'s answer as JSON that no data can break out of', () => {
        const document = buildHtmlRenderDocument('<p>a</p>', theme, { answerState: { waiting: false, answer: { note: '</script><script>alert(1)</script>' } } });
        const start = document.indexOf('<script type="application/json" id="oc-html-render-answer">');
        const json = document.slice(document.indexOf('>', start) + 1, document.indexOf('</script>', start));
        expect(JSON.parse(json)).toEqual({ waiting: false, answer: { note: '</script><script>alert(1)</script>' } });
        // The bootstrap, the answer state and the answer script, nothing more.
        expect(document.match(/<\/script>/g)?.length).toBe(3);
    });

    test('starts a page as not waiting unless told', () => {
        expect(buildHtmlRenderDocument('<p>a</p>', theme)).toContain('{"waiting":false,"answer":null}');
    });
});

describe('readHtmlRenderFrameMessage', () => {
    test('reads openchamber.submit as an MCP Apps ui/message', () => {
        const data = {
            jsonrpc: '2.0',
            id: 1,
            method: 'ui/message',
            params: { role: 'user', content: [{ type: 'text', text: ' Layout B ' }], _meta: { 'openchamber/data': { layout: 'b' } } },
        };
        expect(readHtmlRenderFrameMessage({ data })).toEqual({ kind: 'submit', id: 1, submission: { summary: 'Layout B', data: { layout: 'b' } } });
        expect(readHtmlRenderFrameMessage({ data: { ...data, params: { ...data.params, _meta: undefined } } }))
            .toEqual({ kind: 'submit', id: 1, submission: { summary: 'Layout B', data: null } });
        expect(readHtmlRenderFrameMessage({ data: { ...data, method: 'tools/call' } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { ...data, params: { ...data.params, role: 'assistant' } } })).toBeNull();
    });

    test('answers a submit with an empty result or an error', () => {
        expect(htmlRenderSubmitReply(3)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
        expect(htmlRenderSubmitReply(3, 'nope')).toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'nope' } });
    });

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

    test('ignores anything else, including links that are not http(s)', () => {
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:open-link', url: 'javascript:alert(1)' } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type: 'openchamber:html-render:size', height: -1 } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: { type: 'other', height: 10 } })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: 'openchamber:html-render:size' })).toBeNull();
        expect(readHtmlRenderFrameMessage({ data: null })).toBeNull();
    });
});

describe('helpers', () => {
    test('gives the frame the full page height, between its minimum and the runaway ceiling', () => {
        expect(clampHtmlRenderHeight(10)).toBe(48);
        expect(clampHtmlRenderHeight(300.2)).toBe(301);
        // A long page takes its full height; only a runaway one is stopped.
        expect(clampHtmlRenderHeight(5000)).toBe(5000);
        expect(clampHtmlRenderHeight(1_000_000)).toBe(20_000);
    });

    test('names the download after the page title', () => {
        expect(htmlRenderFileName('Q3 revenue: by region / product')).toBe('Q3 revenue by region product.html');
        expect(htmlRenderFileName('  ')).toBe('page.html');
    });
});

describe('htmlRenderTheme', () => {
    test('leads the chart series with the accent and follows it with the fixed set for the mode', () => {
        const fonts = { rem: 16, sans: 'sans-serif', mono: 'monospace' };
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
