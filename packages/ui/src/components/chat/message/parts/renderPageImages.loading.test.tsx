import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { useOpenUIHtml } from './renderPageImages';
import { prepareLocalMarkdownImages } from '../../markdown/markdownImageAssets';

const originalFetch = globalThis.fetch;
const previous = new Map<string, PropertyDescriptor | undefined>();
const MiB = 1024 * 1024;
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
let encodedSizes: number[] = [];
class ImageReader {
  result = '';
  onload = () => {};
  readAsDataURL(blob: Blob) {
    encodedSizes.push(blob.size);
    void blob.arrayBuffer().then((bytes) => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload();
    });
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  previous.clear();
});

type ImageFixture = {
  size?: number;
  status?: 'missing';
  rawSize?: number;
  invalid?: boolean;
  httpStatus?: number;
};
const cases: Array<{ name: string; images: ImageFixture[]; loaded: number[]; primeCache?: boolean; responseHeader?: boolean; read?: number[] }> = [
  { name: 'shared references', images: [{ size: 9 * MiB }, { size: 9 * MiB }, { size: 9 * MiB }, { size: 1 }], loaded: [0, 1], read: [0, 1, 2] },
  { name: 'exact budget and missing files', images: [{ size: 10 * MiB }, { size: 9 * MiB, status: 'missing' }, { size: 10 * MiB }, { size: 5 * MiB }, { size: 1 }], loaded: [0, 2, 3], read: [0, 2, 3, 4] },
  { name: 'unknown weight', images: [{}, { size: 1 }], loaded: [1] },
  { name: 'invalid weight', images: [{ size: -1 }, { size: 1 }], loaded: [1] },
  { name: 'invalid image beyond remaining budget', images: [{ size: 9 * MiB }, { size: 9 * MiB }, { size: 9 * MiB, invalid: true }, { size: 1 }], loaded: [0, 1, 3], read: [0, 1, 2, 3] },
  ...[true, false].flatMap((responseHeader) => [
    {
      name: `cached sizes after file growth, content length ${responseHeader}`,
      images: [0, 1, 2, 3].map(() => ({ size: MiB, rawSize: 9 * MiB })),
      loaded: [0, 1], read: [0, 1, 2], primeCache: true, responseHeader,
    },
    {
      name: `invalid grown file, content length ${responseHeader}`,
      images: [{ size: MiB, rawSize: 9 * MiB }, { size: MiB, rawSize: 9 * MiB }, { size: MiB, rawSize: 9 * MiB, invalid: true }, { size: MiB }],
      loaded: [0, 1, 3], read: [0, 1, 2, 3], primeCache: true, responseHeader,
    },
  ]),
  { name: 'invalid raw file does not consume selected budget', images: [{ size: 9 * MiB }, { size: 9 * MiB, invalid: true }, { size: 9 * MiB }, { size: 1 }], loaded: [0, 2, 3], read: [0, 1, 2, 3] },
  { name: 'failed raw request does not consume selected budget', images: [{ size: 9 * MiB }, { size: 9 * MiB, httpStatus: 404 }, { size: 9 * MiB }, { size: 1 }], loaded: [0, 2, 3], read: [0, 1, 2, 3] },
  {
    name: 'exact actual budget with padded data URLs',
    images: [{ size: MiB, rawSize: 10 * MiB }, { size: MiB, rawSize: 10 * MiB }, { size: MiB, rawSize: 5 * MiB }, { size: MiB }],
    loaded: [0, 1, 2], read: [0, 1, 2, 3],
  },
];
for (const { name, images, loaded, primeCache, responseHeader, read = loaded } of cases) test(`loads each HtmlView within its own budget: ${name}`, async () => {
  encodedSizes = [];
  const win = new Window({ url: 'https://app.test' });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, FileReader: ImageReader, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://images.test' });
  const sources = images.map((_, index) => `/repo/${index}.png`);
  const html = sources.map((source) => `<img src="${source}">`).join('');
  const reads: string[] = [];
  let inspections = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/api/fs/stat') {
      inspections++;
      const source = url.searchParams.get('path')!;
      const image = images[sources.indexOf(source)];
      return Response.json(image.status === 'missing' ? { exists: false } : { isFile: true, path: source, size: image.size });
    }
    if (url.pathname === '/api/fs/raw') {
      const source = url.searchParams.get('path')!;
      const image = images[sources.indexOf(source)];
      reads.push(source);
      if (image.httpStatus) return new Response(null, { status: image.httpStatus });
      const bytes = new Uint8Array(image.rawSize ?? Math.max(png.length, image.size ?? 0));
      if (!image.invalid) bytes.set(png.subarray(0, bytes.length));
      return new Response(bytes, { headers: { 'content-type': 'image/png', ...(responseHeader ? { 'content-length': String(bytes.length) } : {}) } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  let finish = () => {};
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  let inlinedHtml = '';
  function Page() {
    const result = useOpenUIHtml({ html, sessionId: 's', messageId: name, directory: '/repo', pageId: name, renderKey: name, permittedSources: sources });
    React.useEffect(() => {
      if (result !== null) { inlinedHtml = result; finish(); }
    }, [result]);
    return <output>{result === null ? 'loading' : (result.match(/data:image\/png;base64/g) ?? []).length}</output>;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    if (primeCache) await prepareLocalMarkdownImages({ sources, directory: '/repo', sessionId: 's', messageId: name, signal: new AbortController().signal });
    await act(async () => root.render(<Page />));
    await act(async () => { await ready; });
    expect(reads).toEqual(read.map((index) => sources[index]));
    expect(host.textContent).toBe(String(loaded.length));
    const expectedSizes = loaded.map((index) => images[index].rawSize ?? Math.max(png.length, images[index].size ?? 0));
    expect(encodedSizes).toEqual(expectedSizes);
    const inlinedSizes = Array.from(inlinedHtml.matchAll(/data:image\/png;base64,([^"']+)/g), (match) => Buffer.from(match[1], 'base64').length);
    expect(inlinedSizes).toEqual(expectedSizes);
    expect(inlinedSizes.reduce((sum, size) => sum + size, 0) <= 25 * MiB).toBe(true);
    await act(async () => root.render(null));
    await act(async () => root.render(<Page />));
    expect(host.textContent).toBe(String(loaded.length));
    expect(inspections).toBe(sources.length);
    expect(reads).toHaveLength(read.length);
    expect(encodedSizes).toEqual(expectedSizes);
    if (name === 'shared references') {
      const source = sources[2];
      function OtherPage() {
        const result = useOpenUIHtml({ html: `<img src="${source}">`, sessionId: 's', messageId: name,
          directory: '/repo', pageId: 'other-page', renderKey: name, permittedSources: sources });
        return <output>{result?.includes('data:image/png;base64') ? 'loaded' : 'loading'}</output>;
      }
      await act(async () => root.render(<OtherPage />));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(host.textContent).toBe('loaded');
      expect(reads).toEqual([...read.map((index) => sources[index]), source]);
    }
  } finally {
    await act(async () => root.unmount());
    await win.happyDOM.abort();
  }
});
