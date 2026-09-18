import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { GUEST_SCROLLBAR_CSS } from '@openchamber/sdk';

import { loadRelayGuestDocument } from './relay-document';

const prefix = '/api/guests/demo/';
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

type Asset = { body: string | Uint8Array<ArrayBuffer>; type: string };
const loader = (assets: Map<string, Asset>, requests: string[]) => async (path: string) => {
  requests.push(path);
  const asset = assets.get(path);
  return asset ? new Response(asset.body, { headers: { 'content-type': asset.type } }) : new Response('', { status: 404 });
};
const decode = (url: string) => atob(url.slice(url.indexOf(',') + 1).split('#')[0]);

describe('relay guest documents', () => {
  test('keeps host scrollbar styles when turning served HTML into a relay document', async () => {
    const requests: string[] = [];
    const assets = new Map<string, Asset>([
      [`${prefix}index.html`, { type: 'text/html', body: `<!doctype html><html><head></head><body><textarea></textarea></body></html><style data-openchamber-guest-styles>${GUEST_SCROLLBAR_CSS}</style>` }],
    ]);
    const html = await loadRelayGuestDocument('demo', 'index.html', loader(assets, requests));
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('[data-openchamber-guest-styles]')?.textContent).toBe(GUEST_SCROLLBAR_CSS);
    expect(requests).toEqual([`${prefix}index.html`]);
  });

  test('embeds scripts, nested CSS, images and fonts without requesting host UI paths', async () => {
    const assets = new Map<string, Asset>([
      [`${prefix}panel/index.html`, { type: 'text/html', body: '<script src="main.js"></script><link rel="stylesheet" href="css/main.css"><img src="../icon.svg"><div style="background:url(../icon.svg)"></div>' }],
      [`${prefix}panel/main.js`, { type: 'text/javascript', body: 'document.body.dataset.ready = "yes";' }],
      [`${prefix}panel/css/main.css`, { type: 'text/css', body: '@import "base.css"; .icon { background:url(../../icon.svg) } /* url(missing.png) */ .text { content:"url(missing.png)" }' }],
      [`${prefix}panel/css/base.css`, { type: 'text/css', body: '@font-face { font-family: test; src:url(font.woff2) }' }],
      [`${prefix}panel/css/font.woff2`, { type: 'font/woff2', body: new Uint8Array([0, 255, 128, 65]) }],
      [`${prefix}icon.svg`, { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>' }],
    ]);
    const requests: string[] = [];
    const html = await loadRelayGuestDocument('demo', 'panel/index.html', loader(assets, requests));
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(decode(document.querySelector('script')?.getAttribute('src') ?? '')).toBe('document.body.dataset.ready = "yes";');
    const css = decode(document.querySelector('link')?.getAttribute('href') ?? '');
    expect(css).toContain('data:text/css');
    expect(css).toContain('data:image/svg+xml;base64,');
    expect(document.querySelector('img')?.getAttribute('src')?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(requests.filter((path) => path === `${prefix}icon.svg`)).toHaveLength(1);
    expect(requests).toHaveLength(6);
    expect(requests.every((path) => path.startsWith(prefix))).toBe(true);
    expect(html).not.toContain('oc_url_token');
  });

  test('preserves external/data URLs and fragments and resolves srcset candidates', async () => {
    const requests: string[] = [];
    const assets = new Map<string, Asset>([
      [`${prefix}index.html`, { type: 'text/html', body: '<img src="https://cdn.example.com/icon.png"><svg><use href="#mark"/></svg><img srcset="icon.svg 1x, icon.svg 2x"><img src="data:image/png;base64,AA==">' }],
      [`${prefix}icon.svg`, { type: 'image/svg+xml', body: '<svg/>' }],
    ]);
    const html = await loadRelayGuestDocument('demo', 'index.html', loader(assets, requests));
    expect(html).toContain('https://cdn.example.com/icon.png');
    expect(html).toContain('href="#mark"');
    expect(html).toContain('data:image/png;base64,AA==');
    expect(html).toContain('base64,PHN2Zy8+ 1x, data:image/svg+xml;base64,PHN2Zy8+ 2x');
    expect(requests).toEqual([`${prefix}index.html`, `${prefix}icon.svg`]);
  });

  test('refuses missing assets, package escapes, and import cycles', async () => {
    for (const css of ['@import "missing.css";', '@import "../../other/main.css";', '@import "main.css";']) {
      const requests: string[] = [];
      const assets = new Map<string, Asset>([
        [`${prefix}index.html`, { type: 'text/html', body: '<link rel="stylesheet" href="main.css">' }],
        [`${prefix}main.css`, { type: 'text/css', body: css }],
      ]);
      await expect(loadRelayGuestDocument('demo', 'index.html', loader(assets, requests))).rejects.toThrow();
      expect(requests.every((path) => path.startsWith(prefix))).toBe(true);
    }
  });

  test('does not accept a non-HTML response as an extension document', async () => {
    await expect(loadRelayGuestDocument('demo', 'index.html', async () => Response.json({ guests: [] }))).rejects.toThrow('not HTML');
  });

  test('cancels an oversized resource stream', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) { controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    await expect(loadRelayGuestDocument('demo', 'index.html', async () => new Response(stream, {
      headers: { 'content-type': 'text/html' },
    }))).rejects.toThrow('size limit');
    expect(cancelled).toBe(true);
  });
});
