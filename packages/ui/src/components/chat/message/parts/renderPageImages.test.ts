import { describe, expect, test } from 'bun:test';

import { ImageGrantRequestError, type PreparedMarkdownImage } from '../../markdown/markdownImageAssets';
import { inlineRenderPageImages, prepareRenderPageImages, renderPageImageSources } from './renderPageImages';

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

    test('lists every image a page names, past twelve: the server decides what fits by weight', () => {
        const page = Array.from({ length: 19 }, (_, index) => `<img src="/tmp/${index}.png">`).join('');
        expect(renderPageImageSources(page)).toHaveLength(19);
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

describe('prepareRenderPageImages', () => {
    const sources = Array.from({ length: 19 }, (_, index) => `/tmp/${index}.png`);
    const request = { sources, directory: '/repo', sessionId: 'ses_1', messageId: 'msg_1', callId: 'call_1', signal: new AbortController().signal };
    const serverAnswering = (firstStatus: number) => {
        const calls: Array<{ sources: readonly string[]; callId?: string }> = [];
        const prepare = async (input: { sources: readonly string[]; callId?: string }) => {
            calls.push({ sources: input.sources, callId: input.callId });
            if (calls.length === 1) throw new ImageGrantRequestError(firstStatus);
            return new Map<string, PreparedMarkdownImage>(input.sources.map((source) => [source, { status: 'ready', path: source }]));
        };
        return { calls, prepare };
    };

    test('asks an older server, which refuses more than 12 with a 400, for the first 12 without the page', async () => {
        const server = serverAnswering(400);
        const prepared = await prepareRenderPageImages(request, server.prepare);
        expect(server.calls).toEqual([{ sources, callId: 'call_1' }, { sources: sources.slice(0, 12), callId: undefined }]);
        expect(prepared.size).toBe(12);
    });

    test('keeps any other refusal a failure, since a request without the page gets no weight budget', async () => {
        for (const status of [404, 503]) {
            const server = serverAnswering(status);
            await expect(prepareRenderPageImages(request, server.prepare)).rejects.toBeInstanceOf(ImageGrantRequestError);
            expect(server.calls).toHaveLength(1);
        }
    });
});
