import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import type { runtimeFetch } from '@/lib/runtime-fetch';
import { htmlPreviewUrl, loadHtmlPreviewDocument, mintHtmlPreviewGrant } from './useHtmlPreviewUrl';

type FetchInit = Parameters<typeof runtimeFetch>[1];
type Asset = { body: string | Uint8Array<ArrayBuffer>; type: string };

const decodeDataUrl = (url: string) => atob(url.slice(url.indexOf(',') + 1).split('#')[0]);

describe('html preview url', () => {
  test('puts the grant in the path and no URL token in the query', () => {
    const previous = getRuntimeUrlResolver();
    setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:3001' }));
    const url = htmlPreviewUrl('grant-1', '/Users/me/my site/index.html');
    setRuntimeUrlResolver(previous);
    expect(url).toBe('http://127.0.0.1:3001/api/fs/preview/grant-1/Users/me/my%20site/index.html');
    expect(url).not.toContain('oc_url_token');
  });

  test('mints a grant for the page with the project directory', async () => {
    const calls: Array<{ input: string; init: FetchInit }> = [];
    const fetcher: typeof runtimeFetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ grant: 'grant-7', expiresAt: 1 }), { status: 200 });
    };
    const grant = await mintHtmlPreviewGrant(
      { path: '/repo/site/index.html', directory: '/repo', revision: '0', outsideWorkspace: false },
      new AbortController().signal,
      fetcher,
    );
    expect(grant).toBe('grant-7');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/api/fs/preview');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.query).toEqual({ directory: '/repo', allowOutsideWorkspace: undefined });
    expect(calls[0].init?.body).toBe(JSON.stringify({ path: '/repo/site/index.html' }));
  });

  test('asks for a page outside the project the way the editor reads it', async () => {
    const queries: Array<NonNullable<FetchInit>['query']> = [];
    const fetcher: typeof runtimeFetch = async (_input, init) => {
      queries.push(init?.query);
      return new Response(JSON.stringify({ grant: 'grant-8' }), { status: 200 });
    };
    await mintHtmlPreviewGrant(
      { path: '/tmp/mockup/index.html', directory: '/repo', revision: '0', outsideWorkspace: true },
      new AbortController().signal,
      fetcher,
    );
    expect(queries).toEqual([{ directory: '/repo', allowOutsideWorkspace: 'true' }]);
  });

  test('fails instead of producing a URL when the server refuses', async () => {
    const fetcher: typeof runtimeFetch = async () => new Response('{}', { status: 403 });
    await expect(mintHtmlPreviewGrant(
      { path: '/repo/index.html', directory: '/repo', revision: '0', outsideWorkspace: false },
      new AbortController().signal,
      fetcher,
    )).rejects.toThrow('403');
  });
});

describe('loadHtmlPreviewDocument', () => {
  let dom: Window;
  let previousParser: PropertyDescriptor | undefined;

  beforeEach(() => {
    dom = new Window();
    previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
    Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.DOMParser });
  });

  afterEach(async () => {
    if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
    await dom.happyDOM.close();
  });

  const makeFetcher = (
    assets: Map<string, Asset>,
    requests: Array<{ path: string; query: unknown }>,
  ): typeof runtimeFetch => async (input, init) => {
    const path = String(input);
    requests.push({ path, query: init?.query });
    const asset = assets.get(path);
    return asset ? new Response(asset.body, { headers: { 'content-type': asset.type } }) : new Response('', { status: 404 });
  };

  test('inlines relative styles, scripts and images with inline=1, base isolation and fragment nav handler', async () => {
    const prefix = '/api/fs/preview/grant-9/';
    const requests: Array<{ path: string; query: unknown }> = [];
    const assets = new Map<string, Asset>([
      [`${prefix}repo/my%20site/report.html`, {
        type: 'text/html',
        body: '<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="app.js"></script><script src="https://cdn.example.com/chart.js"></script></head><body><a href="#summary">Summary</a><img src="img/plot.svg"></body></html>',
      }],
      [`${prefix}repo/my%20site/style.css`, { type: 'text/css', body: 'body { background: url(img/plot.svg); }' }],
      [`${prefix}repo/my%20site/app.js`, { type: 'text/javascript', body: 'window.ready = true;' }],
      [`${prefix}repo/my%20site/img/plot.svg`, { type: 'image/svg+xml', body: '<svg/>' }],
    ]);

    const html = await loadHtmlPreviewDocument('grant-9', '/repo/my site/report.html', new AbortController().signal, undefined, makeFetcher(assets, requests));
    const doc = new DOMParser().parseFromString(html, 'text/html');

    expect(doc.querySelector('base')?.getAttribute('href')).toBe('https://preview.invalid/api/fs/preview/grant-9/repo/my%20site/report.html');
    expect(doc.querySelector('script[data-openchamber-inline-nav]')?.textContent).toContain('scrollIntoView');
    expect(decodeDataUrl(doc.querySelector('link')?.getAttribute('href') ?? '')).toContain('data:image/svg+xml;base64,');
    expect(decodeDataUrl(doc.querySelector('script[src^="data:"]')?.getAttribute('src') ?? '')).toBe('window.ready = true;');
    expect(doc.querySelector('script[src^="https://"]')?.getAttribute('src')).toBe('https://cdn.example.com/chart.js');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    expect(requests.every((r) => JSON.stringify(r.query) === JSON.stringify({ inline: '1' }))).toBe(true);
    expect(requests.filter((r) => r.path === `${prefix}repo/my%20site/img/plot.svg`)).toHaveLength(1);
  });

  test('keeps rendering when subresources are missing or outside the preview prefix', async () => {
    const prefix = '/api/fs/preview/grant-10/';
    const requests: Array<{ path: string; query: unknown }> = [];
    const assets = new Map<string, Asset>([
      [`${prefix}repo/index.html`, {
        type: 'text/html',
        body: '<!doctype html><html><head><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="missing.css"></head><body><img src="missing.png"><p>Hello</p></body></html>',
      }],
    ]);

    const html = await loadHtmlPreviewDocument('grant-10', '/repo/index.html', new AbortController().signal, undefined, makeFetcher(assets, requests));
    const doc = new DOMParser().parseFromString(html, 'text/html');

    expect(doc.querySelector('p')?.textContent).toBe('Hello');
    expect(doc.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('https://preview.invalid/favicon.ico');
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://preview.invalid/api/fs/preview/grant-10/repo/missing.png');
    expect(requests.map((r) => r.path)).not.toContain('/favicon.ico');
  });

  test('rejects an aborted body stream instead of returning partial HTML', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('<p>partial</p>'));
      },
      pull() {
        controller.abort();
        return new Promise(() => {});
      },
    });
    const fetcher: typeof runtimeFetch = async () => new Response(stream, { headers: { 'content-type': 'text/html' } });

    await expect(
      loadHtmlPreviewDocument('grant-12', '/repo/index.html', controller.signal, undefined, fetcher),
    ).rejects.toThrow();
  });

  test('fails when the root HTML page cannot be read or is not HTML', async () => {
    const missing = makeFetcher(new Map(), []);
    await expect(loadHtmlPreviewDocument('grant-11', '/repo/missing.html', new AbortController().signal, undefined, missing)).rejects.toThrow('404');

    const nonHtml: typeof runtimeFetch = async () => new Response('plain', { headers: { 'content-type': 'text/plain' } });
    await expect(loadHtmlPreviewDocument('grant-11', '/repo/index.html', new AbortController().signal, undefined, nonHtml)).rejects.toThrow('not HTML');
  });
});
