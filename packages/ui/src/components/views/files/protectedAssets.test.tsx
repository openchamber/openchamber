import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { serveTestHttp } from '@/lib/test-http-server';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { readAssetBlob } from '@/lib/runtime-asset';
import { MarkdownMediaOwner } from '@/components/chat/markdown/markdown-media-context';
import { useRawAssetUrl } from './useRawAssetUrl';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

test('protected Files media and prepared chat images load through header-aware HTTP and retire object URLs', async () => {
  const dom = new Window({ url: 'http://localhost' });
  Object.assign(dom, { Capacitor: { isNativePlatform: () => true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  class Reader {
    result: string | null = null;
    onload: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((bytes) => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
        this.onload?.();
      });
    }
  }
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, CustomEvent: dom.CustomEvent, FileReader: Reader, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const requests: { path: string; header: string }[] = [];
  let pendingStarted = () => {};
  const pendingRequest = new Promise<void>((resolve) => { pendingStarted = resolve; });
  let pendingClosed = () => {};
  const pendingCancelled = new Promise<void>((resolve) => { pendingClosed = resolve; });
  const server = await serveTestHttp((request, response) => {
    requests.push({ path: request.url || '', header: String(request.headers['x-proxy'] || '') });
    if (request.headers['x-proxy'] !== 'synthetic-secret') { response.writeHead(403).end(); return; }
    const url = new URL(request.url || '/', 'http://fixture');
    if (url.pathname.endsWith('/markdown-image-grants')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ results: [{ source: 'picture.png', status: 'ready', path: '/repo/picture.png' }] }));
      return;
    }
    const path = url.searchParams.get('path') || '';
    if (path === '/repo/pending.pdf') {
      response.setHeader('Content-Type', 'application/pdf');
      response.flushHeaders();
      response.on('close', pendingClosed);
      pendingStarted();
      return;
    }
    if (path === '/repo/denied.pdf') { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type', path.endsWith('.png') ? 'image/png' : path.endsWith('.pdf') ? 'application/pdf' : path.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
    response.end(path.endsWith('.png') ? png : Buffer.from(`fixture:${path}`));
  });
  let latest: ReturnType<typeof useRawAssetUrl> | undefined;
  const errors: Array<string | null> = [];
  const reportError = (error: string | null) => { errors.push(error); };
  const root = createRoot(document.createElement('div'));
  const Probe = ({ path, runtime = 'first' }: { path: string; runtime?: string }) => {
    latest = useRawAssetUrl({ path, runtime, directory: '/repo', revision: '0', outsideWorkspace: false }, reportError, 'read failed');
    return null;
  };
  const settle = async () => {
    for (let i = 0; i < 100 && latest?.loading; i += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(latest?.loading).toBe(false);
  };
  const revoke = spyOn(URL, 'revokeObjectURL');
  try {
    expect((await fetch(new URL('/api/fs/raw', server.url))).status).toBe(403);
    requests.length = 0;
    switchRuntimeEndpoint({ apiBaseUrl: server.url.toString().replace(/\/$/, ''), clientToken: null, requestHeaders: { 'X-Proxy': 'synthetic-secret' } });
    let previous = '';
    for (const path of ['/repo/picture.png', '/repo/book.pdf', '/repo/sound.mp3', '/repo/movie.mp4']) {
      await act(async () => root.render(<Probe path={path} />));
      await settle();
      expect(latest?.src.startsWith('blob:')).toBe(true);
      expect(latest?.src).not.toContain('synthetic-secret');
      if (previous) expect(revoke.mock.calls.flat()).toContain(previous);
      previous = latest!.src;
      const bytes = Buffer.from(await (await fetch(previous)).arrayBuffer());
      expect(bytes).toEqual(path.endsWith('.png') ? png : Buffer.from(`fixture:${path}`));
    }
    await act(async () => {
      root.render(<Probe path="/repo/pending.pdf" />);
    });
    await pendingRequest;
    expect(latest?.loading).toBe(true);
    expect(revoke.mock.calls.flat()).toContain(previous);
    await act(async () => root.render(<Probe path="/repo/movie.mp4" runtime="second" />));
    await settle();
    await pendingCancelled;
    expect(latest?.src.startsWith('blob:')).toBe(true);
    const chat = new MarkdownMediaOwner({ mode: 'assistant', directory: '/repo', sessionId: 'ses_media', messageId: 'msg_media' });
    chat.register('picture.png');
    try {
      expect(await chat.resolve('picture.png')).toBe(`data:image/png;base64,${png.toString('base64')}`);
    } finally { chat.dispose(); }
    const documentOwner = new MarkdownMediaOwner({ mode: 'document', directory: '/repo' });
    const count = requests.length;
    expect(await documentOwner.resolve('https://outside.example/image.png')).toBe('https://outside.example/image.png');
    expect(requests).toHaveLength(count);
    documentOwner.dispose();
    expect(requests.every((request) => request.header === 'synthetic-secret')).toBe(true);
    expect(errors.every((error) => error === null)).toBe(true);
    const finalUrl = latest!.src;
    await act(async () => root.render(<Probe path="/repo/denied.pdf" />));
    await settle();
    expect(latest?.src).toBe('');
    expect(errors.at(-1)).toBe('read failed');
    expect(revoke.mock.calls.flat()).toContain(finalUrl);
    await act(async () => root.unmount());
    expect(revoke.mock.calls.flat()).toContain(finalUrl);
  } finally {
    await act(async () => root.unmount());
    revoke.mockRestore();
    switchRuntimeEndpoint({ apiBaseUrl: '', clientToken: null });
    server.close();
    await dom.happyDOM.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('bounded asset reads cancel inaccurate-length streams and aborted reads', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; },
  });
  await expect(readAssetBlob(new Response(stream, { headers: { 'Content-Length': '1' } }), 5, new AbortController().signal)).rejects.toThrow('preview limit');
  expect(cancelled).toBe(true);
  const controller = new AbortController();
  const pending = readAssetBlob(new Response(new ReadableStream()), 5, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});
