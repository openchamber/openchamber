import { describe, expect, test } from 'bun:test';

import { inlineRenderPageImages, renderPageImageSources } from './renderPageImages';

const PAGE = [
    '<img src="/Users/me/Screen Shot 1.png">',
    '<div style="background:url(/tmp/bg.webp)"></div>',
    '<div style="background:url( \'/tmp/quoted.jpg\' )"></div>',
    '<img src="//cdn.test/remote.png"><img src="https://cdn.test/remote.png"><img src="data:image/png;base64,AAAA">',
    '<script>const shot = `C:\\\\shots\\\\after.JPG`; const other = "file:///tmp/other.gif";</script>',
    '<img src="/a/b.png"><img src="/x/a/b.png"><img src="/a/b.png">',
].join('');

describe('renderPageImageSources', () => {
    test('finds the absolute local image paths a page names, once each, and no remote or inline ones', () => {
        expect(renderPageImageSources(PAGE)).toEqual([
            '/Users/me/Screen Shot 1.png',
            '/tmp/bg.webp',
            '/tmp/quoted.jpg',
            'C:\\\\shots\\\\after.JPG',
            'file:///tmp/other.gif',
            '/a/b.png',
            '/x/a/b.png',
        ]);
    });

    test('stops at twelve images, the most one grant request prepares', () => {
        const page = Array.from({ length: 15 }, (_, index) => `<img src="/tmp/${index}.png">`).join('');
        expect(renderPageImageSources(page)).toHaveLength(12);
    });
});

describe('inlineRenderPageImages', () => {
    test('swaps each loaded path for its data URL and leaves the rest as written', () => {
        const images = new Map([
            ['/tmp/bg.webp', 'data:image/webp;base64,BG'],
            ['/a/b.png', 'data:image/png;base64,AB'],
        ]);
        const inlined = inlineRenderPageImages('<div style="background:url(/tmp/bg.webp)"></div><img src="/a/b.png"><img src="/x/a/b.png"><img src="/a/b.png">', images);
        expect(inlined).toBe('<div style="background:url(data:image/webp;base64,BG)"></div><img src="data:image/png;base64,AB"><img src="/x/a/b.png"><img src="data:image/png;base64,AB">');
    });
});
