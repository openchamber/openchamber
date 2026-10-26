import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { z } from 'zod';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { MarkdownMediaProvider } from './MarkdownMediaContext';
import { MarkdownMediaLinkContext } from './markdown-media-context';
import { MarkdownImage, MarkdownParagraph, MarkdownPicture, MarkdownSource, MarkdownVideo } from './MarkdownMedia';
import { Streamdown } from 'streamdown';
import { getMarkdownProcessingOptions } from './streamdownPlugins';
import { setRuntimeUrlAuthToken } from '@/lib/runtime-auth';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const originalFetch = globalThis.fetch;
let root: Root;
let host: HTMLDivElement;
let requests: string[];
let batches: string[][];
let revoked: string[];
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
function Chat({ children, settled = true, id = 'message' }: { children: React.ReactNode; settled?: boolean; id?: string }) {
  return <MarkdownMediaProvider content={id} mode="assistant" sessionId="session" messageId={id} directory="/repo" settled={settled}>{children}</MarkdownMediaProvider>;
}
function Document({ children, scheme = 'dark' }: { children: React.ReactNode; scheme?: 'light' | 'dark' }) {
  return <MarkdownMediaProvider content="document" mode="document" directory="/repo" settled documentAssets={{ filePath: '/repo/docs/readme.md', workspaceRoot: '/repo', onOpenFile: () => {}, colorScheme: scheme }}>{children}</MarkdownMediaProvider>;
}
beforeEach(() => {
  const dom = new Window({ url: 'https://app.test' });
  Object.defineProperty(dom, 'IntersectionObserver', { configurable: true, value: undefined });
  Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element, HTMLImageElement: dom.HTMLImageElement, IS_REACT_ACT_ENVIRONMENT: true });
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.test' });
  requests = []; batches = []; revoked = [];
  Object.assign(URL, { createObjectURL: () => 'blob:document-image', revokeObjectURL: (url: string) => revoked.push(url) });
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    if (url.includes('/auth/url-token')) return Response.json({ token: 'short-lived', expiresAt: Date.now() + 60_000 });
    if (url.includes('markdown-image-grants')) {
      const body = z.object({ sources: z.array(z.string()) }).parse(JSON.parse(String(init?.body)));
      batches.push(body.sources);
      return Response.json({ results: body.sources.map((source) => ({ source, status: 'ready', path: `/repo/${source}`, expiresAt: Date.now() + 60_000 })) });
    }
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); globalThis.fetch = originalFetch; });

describe('React-owned Markdown media', () => {
  test('keeps remote chat images as links and badges as labels without issuing image requests', async () => {
    await act(async () => root.render(<Chat><MarkdownImage src="https://remote.test/a.png" alt="A" /><a href="https://target.test"><MarkdownMediaLinkContext.Provider value><MarkdownImage src="https://remote.test/b.png" alt="badge" /></MarkdownMediaLinkContext.Provider></a></Chat>));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelectorAll('a')).toHaveLength(2);
    expect(host.querySelector('a a')).toBeNull();
    expect(requests).toEqual([]);
  });
  test('hides the incomplete-image sentinel', async () => {
    await act(async () => root.render(<Chat><MarkdownImage src="streamdown:incomplete-image" alt="pending" /></Chat>));
    expect(host.textContent).toBe('');
    expect(host.querySelector('img')).toBeNull();
  });
  test('waits for settlement and batches at most 12 unique local sources', async () => {
    const children = Array.from({ length: 13 }, (_, i) => <MarkdownImage key={i} src={`${i}.png`} />);
    await act(async () => root.render(<Chat settled={false} id="batch">{children}</Chat>));
    await flush(); expect(requests).toEqual([]);
    await act(async () => root.render(<Chat id="batch">{children}</Chat>));
    await flush(); await flush();
    expect(batches).toEqual([Array.from({ length: 12 }, (_, i) => `${i}.png`)]);
    expect(host.querySelectorAll('img')).toHaveLength(12);
    expect(host.textContent).toContain('12.png');
    expect(host.querySelector('img')?.getAttribute('data-oc-media-source')).toBe('0.png');
  });
  test('resolves document sources and srcsets against the file directory and revokes owned URLs', async () => {
    await act(async () => root.render(<Document><MarkdownPicture><MarkdownSource media="(prefers-color-scheme: dark)" srcSet="./dark.png 1x, https://cdn.test/dark.png 2x" /><MarkdownImage src="../../outside.png" alt="outside" /></MarkdownPicture></Document>));
    await flush(); await flush();
    expect(requests.some((url) => url.includes('path=%2Frepo%2Fdocs%2Fdark.png'))).toBe(true);
    expect(requests.some((url) => url.includes('path=%2Foutside.png') && url.includes('allowOutsideWorkspace=true'))).toBe(true);
    expect(host.querySelector('source')?.getAttribute('media')).toBe('(min-width: 0px)');
    expect(host.querySelector('source')?.getAttribute('srcset')).toBe('blob:document-image 1x, https://cdn.test/dark.png 2x');
    await act(async () => root.render(<Document scheme="light"><MarkdownPicture><MarkdownSource media="(prefers-color-scheme: dark)" srcSet="./dark.png 1x, https://cdn.test/dark.png 2x" /><MarkdownImage src="../../outside.png" alt="outside" /></MarkdownPicture></Document>));
    expect(host.querySelector('source')?.getAttribute('media')).toBe('(max-width: -1px)');
    const count = requests.length;
    await flush(); expect(requests.length).toBe(count);
    await act(async () => root.render(null));
    expect(revoked).toHaveLength(2);
  });
  test('model output clips read nothing until played; documents draw bare GitHub clip URLs as players', async () => {
    await act(async () => root.render(<Chat><MarkdownImage src="https://remote.test/asset" alt="clip.mp4" /></Chat>));
    expect(host.querySelectorAll('video')).toHaveLength(1);
    expect(host.querySelector('video')?.preload).toBe('none');
    // A bare clip URL on its own line becomes a player in documents only, as before.
    const bare = <MarkdownParagraph node={{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'element', tagName: 'a', properties: { href: 'https://github.com/user-attachments/assets/123-abcd' }, children: [{ type: 'text', value: 'https://github.com/user-attachments/assets/123-abcd' }] }] }}><a href="https://github.com/user-attachments/assets/123-abcd">https://github.com/user-attachments/assets/123-abcd</a></MarkdownParagraph>;
    await act(async () => root.render(<Chat>{bare}</Chat>));
    expect(host.querySelector('video')).toBeNull();
    await act(async () => root.render(<Document><MarkdownImage src="https://remote.test/asset" alt="clip.mp4" /><MarkdownParagraph node={{ type: 'element', tagName: 'p', properties: {}, children: [{ type: 'element', tagName: 'a', properties: { href: 'https://github.com/user-attachments/assets/123-abcd' }, children: [{ type: 'text', value: 'https://github.com/user-attachments/assets/123-abcd' }] }] }}><a href="https://github.com/user-attachments/assets/123-abcd">https://github.com/user-attachments/assets/123-abcd</a></MarkdownParagraph></Document>));
    expect(host.querySelectorAll('video')).toHaveLength(2);
    for (const video of host.querySelectorAll('video')) { expect(video.preload).toBe('metadata'); expect(video.controls).toBe(true); expect(video.autoplay).toBe(false); }
    expect(requests).toEqual([]);
  });
  test('remote video failure preserves the original safe link and never exposes an authenticated URL', async () => {
    await act(async () => root.render(<Chat><MarkdownVideo src="https://remote.test/clip.mp4" title="clip" /></Chat>));
    await act(async () => host.querySelector('video')?.dispatchEvent(new window.Event('error')));
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://remote.test/clip.mp4');
    expect(host.textContent).toBe('clip');
  });
  test('survives React strict-effect replay and retains the same document URL on theme changes', async () => {
    await act(async () => root.render(<React.StrictMode><Document><MarkdownImage src="./strict.png" /></Document></React.StrictMode>));
    await flush(); await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:document-image');
  });
  test('reconnects loaded media and gallery after a real hidden interval', async () => {
    const popups: import('../message/types').ToolPopupContent[] = [];
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('url-token')) return Response.json({ token: 'short', expiresAt: Date.now() + 60_000 });
      const body = z.object({ sources: z.array(z.string()) }).parse(JSON.parse(String(init?.body)));
      batches.push(body.sources);
      return Response.json({ results: body.sources.map((source) => ({ source, status: 'ready', path: `/repo/${source}`, expiresAt: 1 })) });
    };
    const render = (mode: 'visible' | 'hidden') => root.render(
      <React.Activity mode={mode}>
        <MarkdownMediaProvider
          content="replay"
          mode="assistant"
          sessionId="replay"
          messageId="replay"
          directory="/repo"
          settled
          onShowPopup={(popup) => popups.push(popup)}
        >
          <MarkdownImage src="replay.png" />
        </MarkdownMediaProvider>
      </React.Activity>,
    );
    await act(async () => render('visible')); await flush();
    const image = host.querySelector('img');
    if (!image) throw new Error('Missing image');
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
    await act(async () => image.dispatchEvent(new window.Event('load')));
    await act(async () => render('hidden')); await flush();
    const hiddenBatches = batches.length;
    await act(async () => render('visible')); await flush();
    expect(host.querySelector('img')).toBe(image);
    await act(async () => host.querySelector('button')?.click()); await flush();
    expect(batches.length).toBeGreaterThan(hiddenBatches);
    expect(popups).toHaveLength(1);
    expect(popups[0]?.image?.gallery).toHaveLength(1);
  });
  test('replaces revoked document URLs and rejects a pre-hide body completion after reconnect', async () => {
    const reads: Array<{ signal: AbortSignal | null | undefined; complete: (response: Response) => void }> = [];
    let urls = 0;
    URL.createObjectURL = () => `blob:replay-${++urls}`;
    globalThis.fetch = (_input, init) => new Promise<Response>((complete) => reads.push({ signal: init?.signal, complete }));
    const render = (mode: 'visible' | 'hidden') => root.render(
      <React.Activity mode={mode}>
        <Document>
          <MarkdownImage src="./replay.png" />
          <MarkdownSource srcSet="./replay.png 1x" />
        </Document>
      </React.Activity>,
    );
    await act(async () => render('visible'));
    expect(reads).toHaveLength(1);
    await act(async () => render('hidden')); await flush();
    expect(reads[0]?.signal?.aborted).toBe(true);
    await act(async () => render('visible'));
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]?.complete(new Response(png))); await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:replay-1');
    expect(host.querySelector('source')?.getAttribute('srcset')).toBe('blob:replay-1 1x');
    await act(async () => reads[0]?.complete(new Response(png))); await flush();
    expect(urls).toBe(1);
    await act(async () => render('hidden')); await flush();
    expect(revoked).toEqual(['blob:replay-1']);
    await act(async () => render('visible'));
    expect(host.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(host.querySelector('source')?.hasAttribute('srcset')).toBe(false);
    await act(async () => reads[2]?.complete(new Response(png))); await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:replay-2');
  });
  test('reconnects unchanged memoized children after a same-key runtime renewal while hidden', async () => {
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime.test', runtimeKey: 'hidden-device' }));
    const children = <Document><MarkdownImage src="./renew-hidden.png" /></Document>;
    const render = (mode: 'visible' | 'hidden') => root.render(<React.Activity mode={mode}>{children}</React.Activity>);
    await act(async () => render('visible')); await flush();
    const before = requests.filter((url) => url.includes('/api/fs/raw')).length;
    await act(async () => render('hidden')); await flush();
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime.test', runtimeKey: 'hidden-device', clientToken: 'renewed' }));
    await act(async () => render('visible')); await flush();
    expect(requests.filter((url) => url.includes('/api/fs/raw')).length).toBe(before + 1);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:document-image');
  });
  test('loads an assistant image that first nears the viewport after reconnect', async () => {
    let enter: (() => void) | undefined;
    let observers = 0;
    class Observer implements IntersectionObserver {
      root = null; rootMargin = '200px'; readonly scrollMargin = '0px'; thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        enter = () => callback([{ isIntersecting: true, intersectionRatio: 1, target: host, time: 0, boundingClientRect: host.getBoundingClientRect(), intersectionRect: host.getBoundingClientRect(), rootBounds: null }], this);
      }
      observe() { observers += 1; }
      unobserve() {}
      disconnect() { if (this.observing) { observers -= 1; this.observing = false; } }
      takeRecords() { return []; }
      private observing = true;
    }
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Observer });
    const render = (mode: 'visible' | 'hidden') => root.render(
      <React.Activity mode={mode}>
        <Chat id="late-near">
          <MarkdownImage src="late.png" />
        </Chat>
      </React.Activity>,
    );
    await act(async () => render('visible'));
    expect(observers).toBe(1);
    expect(batches).toHaveLength(0);
    await act(async () => render('hidden')); await flush();
    expect(observers).toBe(0);
    await act(async () => render('visible'));
    expect(observers).toBe(1);
    await act(async () => enter?.()); await flush();
    expect(observers).toBe(0);
    expect(batches).toEqual([['late.png']]);
    expect(host.querySelector('img')?.getAttribute('src')).toContain('/api/fs/raw');
  });
  test('aborts runtime-owned reads synchronously and rejects their late completion', async () => {
    const reads: Array<{ signal: AbortSignal | null | undefined; complete: (response: Response) => void }> = [];
    let urls = 0;
    URL.createObjectURL = () => `blob:runtime-${++urls}`;
    globalThis.fetch = (input, init) => {
      if (String(input).includes('url-token')) return Promise.resolve(Response.json({ token: 'short', expiresAt: Date.now() + 60_000 }));
      return new Promise<Response>((complete) => reads.push({ signal: init?.signal, complete }));
    };
    await act(async () => root.render(<Document><MarkdownImage src="./runtime.png" /></Document>));
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://replacement.test', runtimeKey: 'replacement' });
      expect(reads[0]?.signal?.aborted).toBe(true);
    });
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]?.complete(new Response(png))); await flush();
    await act(async () => reads[0]?.complete(new Response(png))); await flush();
    expect(urls).toBe(1);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:runtime-1');
  });
  test('does not open an obsolete gallery when its grant finishes after reconnect', async () => {
    const popups: import('../message/types').ToolPopupContent[] = [];
    let complete: (() => void) | undefined;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('url-token')) return Response.json({ token: 'short', expiresAt: Date.now() + 60_000 });
      const body = z.object({ sources: z.array(z.string()) }).parse(JSON.parse(String(init?.body)));
      batches.push(body.sources);
      if (batches.length === 2) await new Promise<void>((resolve) => { complete = resolve; });
      return Response.json({ results: body.sources.map((source) => ({ source, status: 'ready', path: `/repo/${source}`, expiresAt: 1 })) });
    };
    const render = (mode: 'visible' | 'hidden') => root.render(
      <React.Activity mode={mode}>
        <MarkdownMediaProvider
          content="pending-gallery"
          mode="assistant"
          sessionId="pending-gallery"
          messageId="pending-gallery"
          directory="/repo"
          settled
          onShowPopup={(popup) => popups.push(popup)}
        >
          <MarkdownImage src="gallery.png" />
        </MarkdownMediaProvider>
      </React.Activity>,
    );
    await act(async () => render('visible')); await flush();
    const image = host.querySelector('img');
    if (!image) throw new Error('Missing image');
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
    await act(async () => image.dispatchEvent(new window.Event('load')));
    await act(async () => host.querySelector('button')?.click());
    expect(complete).toBeDefined();
    await act(async () => render('hidden')); await flush();
    await act(async () => render('visible')); await flush();
    await act(async () => complete?.()); await flush();
    expect(popups).toHaveLength(0);
    await act(async () => host.querySelector('button')?.click()); await flush();
    expect(popups).toHaveLength(1);
  });
  test('does not copy credential-bearing video sources into metadata or fallback links', async () => {
    await act(async () => root.render(<Chat><MarkdownVideo src="https://runtime.test/api/fs/raw?path=clip.mp4&oc_url_token=secret" title="clip.mp4" /></Chat>));
    await act(async () => host.querySelector('video')?.dispatchEvent(new window.Event('error')));
    await act(async () => host.querySelector('video')?.dispatchEvent(new window.Event('error')));
    expect(host.innerHTML).not.toContain('secret');
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toBe('clip.mp4');
  });
  test('cancels pending document body reads and ignores completion after owner replacement', async () => {
    let complete: ((value: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (input, init) => {
      if (String(input).includes('url-token')) return Promise.resolve(Response.json({ token: 'short', expiresAt: Date.now() + 60_000 }));
      signal = input instanceof Request ? input.signal : init?.signal;
      return new Promise((resolve) => { complete = resolve; });
    };
    await act(async () => root.render(<Document><MarkdownImage src="./old.png" /></Document>));
    await act(async () => root.render(<Document><MarkdownImage src="https://cdn.test/new.png" /></Document>));
    complete?.(new Response(png)); await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/new.png');
    expect(host.innerHTML).not.toContain('blob:');
    // Source replacement cancels publication; runtime disposal also aborts transport.
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://another.test', runtimeKey: 'media-test-switch' }));
    expect(signal?.aborted).toBe(true);
  });
  test('observes only its owned node and waits until it is near the viewport', async () => {
    let enter: (() => void) | undefined;
    const previous = window.IntersectionObserver;
    class Observer implements IntersectionObserver {
      root = null;
      rootMargin = '200px';
      readonly scrollMargin = '0px';
      thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        enter = () => callback([{ isIntersecting: true, intersectionRatio: 1, target: host, time: 0, boundingClientRect: host.getBoundingClientRect(), intersectionRect: host.getBoundingClientRect(), rootBounds: null }], this);
      }
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    }
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Observer });
    try {
      await act(async () => root.render(<Chat id="viewport"><MarkdownImage src="near.png" /></Chat>));
      await flush(); expect(requests).toEqual([]);
      await act(async () => enter?.()); await flush();
      expect(batches).toEqual([['near.png']]);
    } finally { Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: previous }); }
  });
  test('a document reads an image or a picture only once it comes near the visible part of its scroller', async () => {
    const observers: Array<{ options?: IntersectionObserverInit; targets: Element[]; enter: () => void }> = [];
    const previous = window.IntersectionObserver;
    class Observer implements IntersectionObserver {
      root = null;
      rootMargin = '';
      readonly scrollMargin = '0px';
      thresholds = [0];
      private readonly record: { options?: IntersectionObserverInit; targets: Element[]; enter: () => void };
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { options, targets: [], enter: () => callback(this.record.targets.map((target) => ({ isIntersecting: true, intersectionRatio: 1, target, time: 0, boundingClientRect: host.getBoundingClientRect(), intersectionRect: host.getBoundingClientRect(), rootBounds: null })), this) };
        observers.push(this.record);
      }
      observe(target: Element) { this.record.targets.push(target); }
      unobserve() {} disconnect() {} takeRecords() { return []; }
    }
    Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: Observer });
    host.style.overflowY = 'auto';
    Object.defineProperties(host, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 800 } });
    try {
      // A table scrolls sideways and computes `overflow-y: auto` too, but it is not the root.
      await act(async () => root.render(<Document scheme="light"><div style={{ overflowX: 'auto', overflowY: 'auto' }}><MarkdownImage src="./far.png" /></div><MarkdownPicture><MarkdownSource srcSet="./wide.png" /><MarkdownImage src="./fallback.png" /></MarkdownPicture></Document>));
      await flush();
      expect(requests).toEqual([]);
      expect(observers.map((observer) => [observer.options?.root, observer.options?.rootMargin])).toEqual([[host, '100% 0px'], [host, '100% 0px']]);
      expect(observers.map((observer) => observer.targets[0]?.tagName)).toEqual(['IMG', 'PICTURE']);

      await act(async () => observers[1]?.enter()); await flush(); await flush();
      const reads = () => requests.filter((url) => url.includes('/api/fs/raw')).map((url) => new URL(url).searchParams.get('path'));
      expect(reads()).toEqual(['/repo/docs/wide.png', '/repo/docs/fallback.png']);

      await act(async () => observers[0]?.enter()); await flush(); await flush();
      expect(reads()).toEqual(['/repo/docs/wide.png', '/repo/docs/fallback.png', '/repo/docs/far.png']);
    } finally { Object.defineProperty(window, 'IntersectionObserver', { configurable: true, value: previous }); }
  });
  test('a picture source of the other theme is read only once the theme switches to it', async () => {
    const picture = (scheme: 'light' | 'dark') => <Document scheme={scheme}><MarkdownPicture><MarkdownSource media="(prefers-color-scheme: dark)" srcSet="./dark.png" /><MarkdownImage src="./light.png" /></MarkdownPicture></Document>;
    const reads = () => requests.filter((url) => url.includes('/api/fs/raw')).map((url) => new URL(url).searchParams.get('path'));
    await act(async () => root.render(picture('light'))); await flush(); await flush();
    expect(reads()).toEqual(['/repo/docs/light.png']);
    expect(host.querySelector('source')?.hasAttribute('srcset')).toBe(false);
    await act(async () => root.render(picture('dark'))); await flush(); await flush();
    expect(reads()).toEqual(['/repo/docs/light.png', '/repo/docs/dark.png']);
    expect(host.querySelector('source')?.getAttribute('srcset')).toBe('blob:document-image');
  });
  test('local mode keeps relative sources and document images remain valid children of picture', async () => {
    await act(async () => root.render(<MarkdownMediaProvider content="local" mode="local" directory="/repo" settled><MarkdownImage src="./local.png" /></MarkdownMediaProvider>));
    await flush(); expect(host.querySelector('img')?.getAttribute('src')).toBe('./local.png'); expect(requests).toEqual([]);
    await act(async () => root.render(<Document><MarkdownPicture><MarkdownSource srcSet="https://cdn.test/theme.svg" /><MarkdownImage src="https://cdn.test/fallback.svg" /></MarkdownPicture></Document>));
    await flush();
    expect(host.querySelector('picture > img')?.getAttribute('src')).toBe('https://cdn.test/fallback.svg');
    expect(host.querySelector('picture button')).toBeNull();
  });
  test('opens a gallery across mounted message parts with original copy sources', async () => {
    const popups: import('../message/types').ToolPopupContent[] = [];
    const part = (source: string) => <MarkdownMediaProvider content={source} mode="assistant" sessionId="gallery" messageId="message" directory="/repo" settled onShowPopup={(popup) => popups.push(popup)}><MarkdownImage src={source} /></MarkdownMediaProvider>;
    await act(async () => root.render(<>{part('a.png')}{part('b.png')}</>)); await flush(); await flush();
    for (const image of host.querySelectorAll('img')) {
      Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
      await act(async () => image.dispatchEvent(new window.Event('load')));
    }
    await act(async () => host.querySelector('button')?.click()); await flush();
    expect(popups[0]?.image?.gallery).toHaveLength(2);
    expect(popups[0]?.image?.index).toBe(0);
    expect(host.querySelector('img')?.getAttribute('data-oc-media-source')).toBe('a.png');
    expect(host.querySelector('img')?.getAttribute('src')).toContain('/api/fs/raw');
  });
  test('local video keeps its label until metadata loads and never bridges a whole video in VS Code', async () => {
    await act(async () => root.render(<Chat id="local-video"><MarkdownVideo src="clip.mp4" /></Chat>)); await flush();
    expect(host.textContent).toContain('clip.mp4');
    const video = host.querySelector('video');
    expect(video?.hidden).toBe(true);
    await act(async () => video?.dispatchEvent(new window.Event('loadedmetadata')));
    expect(host.querySelector('video')?.hidden).toBe(false);
    Object.defineProperty(window, '__VSCODE_CONFIG__', { configurable: true, value: { workspaceFolder: '/repo' } });
    requests.length = 0;
    await act(async () => root.render(<Chat id="bridge-video"><MarkdownVideo src="clip.mp4" /></Chat>)); await flush();
    expect(host.querySelector('video')).toBeNull(); expect(requests).toEqual([]);
  });
  test('uses original safe source metadata when sanitation removed src and isolates failed media', async () => {
    globalThis.fetch = async (input, init) => {
      requests.push(String(input));
      if (String(input).includes('url-token')) return Response.json({ token: 'short', expiresAt: Date.now() + 60_000 });
      const body = JSON.parse(String(init?.body)) as { sources: string[] };
      batches.push(body.sources);
      return Response.json({ results: body.sources.map((source) => source === 'bad.png' ? { source, status: 'missing' } : { source, status: 'ready', path: `/repo/${source}` }) });
    };
    await act(async () => root.render(<Chat id="metadata"><MarkdownImage data-oc-media-source="original.png" /><MarkdownImage src="bad.png" /><MarkdownImage src="data:image/png;base64,YmFk" /></Chat>)); await flush();
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(host.querySelector('img')?.getAttribute('data-oc-media-source')).toBe('original.png');
    expect(host.textContent).toContain('bad.png');
    expect(batches).toEqual([['original.png', 'bad.png']]);
  });
  test('groups a paragraph only once every image has known dimensions', async () => {
    const node = { type: 'element' as const, tagName: 'p', properties: {}, children: ['one.png', 'two.png'].map((src) => ({ type: 'element' as const, tagName: 'img', properties: { src }, children: [] })) };
    await act(async () => root.render(<Chat id="row"><MarkdownParagraph node={node}><MarkdownImage src="one.png" /><MarkdownImage src="two.png" /></MarkdownParagraph></Chat>)); await flush();
    const images = host.querySelectorAll('img');
    expect(host.querySelector('p')?.getAttribute('data-oc-media-row')).toBeNull();
    for (const [index, image] of Array.from(images).entries()) {
      Object.defineProperties(image, { naturalWidth: { value: index ? 200 : 100 }, naturalHeight: { value: 100 } });
      await act(async () => image.dispatchEvent(new window.Event('load')));
    }
    expect(host.querySelector('p')?.getAttribute('data-oc-media-row')).toBe('true');
    expect(images[0]?.style.width).toBe('100%');
    expect(host.querySelector('p')?.style.maxWidth).toContain('100px');
  });
  test('VS Code rejects outside and oversized workspace images without grant requests or raw-file reads', async () => {
    Object.defineProperty(window, '__VSCODE_CONFIG__', { configurable: true, value: { workspaceFolder: '/repo' } });
    globalThis.fetch = async (input) => { requests.push(String(input)); return Response.json({ isFile: true, size: 11 * 1024 * 1024 }); };
    await act(async () => root.render(<Chat id="bridge-images"><MarkdownImage src="/outside/secret.png" /><MarkdownImage src="large.png" /></Chat>)); await flush();
    expect(host.querySelector('img')).toBeNull();
    expect(requests).toHaveLength(1); expect(requests[0]).toContain('/api/fs/stat');
    expect(host.textContent).toContain('secret.png'); expect(host.textContent).toContain('large.png');
  });
  test('picture keeps a valid fallback image while a document source is still loading', async () => {
    globalThis.fetch = () => new Promise(() => {});
    await act(async () => root.render(<Document><MarkdownPicture><MarkdownSource srcSet="./theme.png" /><MarkdownImage src="./fallback.png" alt="fallback" /></MarkdownPicture></Document>));
    expect(host.querySelector('picture > img')?.getAttribute('alt')).toBe('fallback');
    expect(host.querySelector('picture > span')).toBeNull();
    expect(host.querySelector('picture > img')?.hasAttribute('src')).toBe(false);
  });
  test('refreshes expired grants once per part when opening a multi-image gallery', async () => {
    const part = <MarkdownMediaProvider content="expiry" mode="assistant" sessionId="expiry" messageId="expiry" directory="/repo" settled onShowPopup={() => {}}><MarkdownImage src="first.png" /><MarkdownImage src="second.png" /></MarkdownMediaProvider>;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('url-token')) return Response.json({ token: 'short', expiresAt: Date.now() + 60_000 });
      const body = JSON.parse(String(init?.body)) as { sources: string[] }; batches.push(body.sources);
      return Response.json({ results: body.sources.map((source) => ({ source, status: 'ready', path: `/repo/${source}`, expiresAt: 1 })) });
    };
    await act(async () => root.render(part)); await flush();
    for (const image of host.querySelectorAll('img')) {
      Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
      await act(async () => image.dispatchEvent(new window.Event('load')));
    }
    expect(batches).toHaveLength(1);
    await act(async () => host.querySelector('button')?.click()); await flush();
    expect(batches).toHaveLength(2);
  });
  test('reference documents without a file owner preserve their inline local source', async () => {
    await act(async () => root.render(<MarkdownMediaProvider content="reference" mode="document" directory="/repo" settled><MarkdownImage src="reference.png" /></MarkdownMediaProvider>)); await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('reference.png');
    expect(requests).toEqual([]);
  });
  test('replaces document transport and object URLs after same-runtime credential renewal', async () => {
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime.test', runtimeKey: 'same-device' }));
    await act(async () => root.render(<Document><MarkdownImage src="./renew.png" /></Document>)); await flush();
    const firstReads = requests.filter((url) => url.includes('/api/fs/raw')).length;
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime.test', runtimeKey: 'same-device', clientToken: 'renewed' })); await flush();
    expect(requests.filter((url) => url.includes('/api/fs/raw')).length).toBe(firstReads + 1);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:document-image');
    expect(revoked).toHaveLength(1);
  });
  test('real document processing retains an alt-only picture fallback and resolves selected sources', async () => {
    await act(async () => root.render(<Document><Streamdown mode="static" {...getMarkdownProcessingOptions(true, false)} components={{ img: MarkdownImage, picture: MarkdownPicture, source: MarkdownSource, p: MarkdownParagraph }} controls={{ image: false }}>{'<picture><source srcset="./hero.png" media="(prefers-color-scheme: dark)"><img alt="Hero"></picture>'}</Streamdown></Document>)); await flush();
    expect(host.querySelector('picture > img')?.getAttribute('alt')).toBe('Hero');
    expect(host.querySelector('source')?.getAttribute('srcset')).toBe('blob:document-image');
    expect(host.querySelector('source')?.getAttribute('media')).toBe('(min-width: 0px)');
  });
  test('real assistant processing preserves and validates an embedded PNG source', async () => {
    const source = 'data:image/png;base64,iVBORw0KGgoAAAAA';
    await act(async () => root.render(<Chat id="parsed-data"><Streamdown mode="static" {...getMarkdownProcessingOptions(false, false)} components={{ img: MarkdownImage, p: MarkdownParagraph }}>{`![embedded](${source})`}</Streamdown></Chat>)); await flush();
    expect(host.querySelector('img')?.getAttribute('src')).toBe(source);
    expect(host.querySelector('img')?.getAttribute('data-oc-media-source')).toBe(source);
  });
  test('signed active-runtime video errors refresh URL auth and retain the bounded player', async () => {
    setRuntimeUrlAuthToken('expired', 1);
    await act(async () => root.render(<Chat><MarkdownVideo src="https://runtime.test/api/fs/raw?path=%2Frepo%2Fclip.mp4&directory=%2Frepo&oc_url_token=expired" title="clip.mp4" /></Chat>));
    const video = host.querySelector('video');
    if (!video) throw new Error('Missing player');
    video.currentTime = 12;
    await act(async () => video.dispatchEvent(new window.Event('error'))); await flush();
    expect(host.querySelector('video')).toBe(video);
    expect(requests.some((url) => url.includes('url-token'))).toBe(true);
    expect(video.getAttribute('src')).toContain('oc_url_token=short-lived');
    await act(async () => video.dispatchEvent(new window.Event('loadedmetadata')));
    expect(video.currentTime).toBe(12);
    expect(video.getAttribute('data-oc-media-source')).toBe('');
    await act(async () => video.dispatchEvent(new window.Event('error')));
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
  });
  test('a foreign signed-looking raw video URL never triggers runtime auth refresh', async () => {
    await act(async () => root.render(<Chat><MarkdownVideo src="https://foreign.test/api/fs/raw?path=clip.mp4&oc_url_token=foreign" title="clip.mp4" /></Chat>));
    await act(async () => host.querySelector('video')?.dispatchEvent(new window.Event('error')));
    expect(requests).toEqual([]);
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(host.innerHTML).not.toContain('foreign');
  });
  test('same-device renewal discards recovered video credentials and resets its first-error retry', async () => {
    const source = 'https://runtime.test/api/fs/raw?path=clip.mp4&oc_url_token=original';
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime.test', runtimeKey: 'video-device' }));
    setRuntimeUrlAuthToken('before-renewal', Date.now() + 60_000);
    await act(async () => root.render(<Chat><MarkdownVideo src={source} title="clip.mp4" /></Chat>));
    await act(async () => host.querySelector('video')?.dispatchEvent(new window.Event('error'))); await flush();
    expect(host.querySelector('video')?.getAttribute('src')).toContain('before-renewal');
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://runtime.test', runtimeKey: 'video-device', clientToken: 'new-credential' }));
    expect(host.querySelector('video')?.getAttribute('src')).toBe(source);
    setRuntimeUrlAuthToken('after-renewal', Date.now() + 60_000);
    await act(async () => host.querySelector('video')?.dispatchEvent(new window.Event('error'))); await flush();
    expect(host.querySelector('video')?.getAttribute('src')).toContain('after-renewal');
    expect(host.innerHTML).not.toContain('before-renewal');
  });
  test('Plan-equivalent actual renderer resolves document assets without enabling raw HTML', async () => {
    const mediaFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.includes('/api/fs/raw') || url.includes('/auth/')) return mediaFetch(input, init);
      if (url.includes('/api/fs/home')) return Promise.resolve(Response.json({ home: '/home/user' }));
      return Promise.resolve(Response.json([]));
    };
    const { MarkdownContent } = await import('../MarkdownRendererImpl');
    const { I18nProvider } = await import('@/lib/i18n');
    await act(async () => root.render(<I18nProvider><MarkdownContent content="![flow](../assets/flow.png)" directory="/repo" enableFileReferences={false} documentAssets={{ filePath: '/home/user/plans/plan.md', workspaceRoot: '/repo', onOpenFile: () => {}, colorScheme: 'dark' }} /></I18nProvider>)); await flush();
    expect(requests.some((url) => url.includes('path=%2Fhome%2Fuser%2Fassets%2Fflow.png'))).toBe(true);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:document-image');
    await act(async () => root.render(<I18nProvider><MarkdownContent content={'<picture><source srcset="./hero.png"><img alt="Hero"></picture>'} directory="/repo" allowRawHtml enableFileReferences={false} documentAssets={{ filePath: '/repo/docs/readme.md', workspaceRoot: '/repo', onOpenFile: () => {}, colorScheme: 'dark' }} /></I18nProvider>)); await flush();
    expect(host.querySelector('picture > img')?.getAttribute('alt')).toBe('Hero');
    expect(host.querySelector('picture > source')?.getAttribute('srcset')).toBe('blob:document-image');
  });
});
