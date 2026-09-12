import React, { act } from 'react';
import { afterAll, afterEach, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

class StageResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback([{
      target, contentRect: new DOMRect(0, 0, 500, 250),
      borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
    }], this);
  }
  disconnect(): void {}
  unobserve(): void {}
}

export const dom = new Window({ url: 'http://localhost/' });
const bindings = {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, InputEvent: dom.InputEvent, DOMRect: dom.DOMRect,
  WheelEvent: dom.WheelEvent, PointerEvent: dom.PointerEvent, CompositionEvent: dom.CompositionEvent,
  ClipboardItem: dom.ClipboardItem, Blob: dom.Blob,
  ClipboardEvent: dom.ClipboardEvent, KeyboardEvent: dom.KeyboardEvent, DataTransfer: dom.DataTransfer,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  ResizeObserver: StageResizeObserver,
  createImageBitmap: async (): Promise<ImageBitmap> => ({ width: 2000, height: 1000, close() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousBindings = Object.keys(bindings).map((key) => ({
  key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
Object.assign(globalThis, bindings);

// React's native composition support is detected when react-dom first loads.
const { createRoot } = await import('react-dom/client');
const { RemoteSurfaceClient } = await import('@/lib/browser/remoteSurface');
const { I18nProvider } = await import('@/lib/i18n');
const { RemoteBrowserCanvas } = await import('./RemoteBrowserCanvas');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(() => {
  for (const { key, descriptor } of previousBindings) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

class CanvasSocket implements RelayTunnelWebSocket {
  readyState = 0;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string | ArrayBuffer | ArrayBufferView): void { this.sent.push(String(data)); }
  close(): void { this.readyState = 3; }
}

type MountCanvasOptions = {
  readonly onDisplayScaleChange?: (scale: number | null) => void;
  readonly onOpenDevTools?: () => void;
};

export const mountCanvas = async ({ onDisplayScaleChange, onOpenDevTools }: MountCanvasOptions = {}) => {
  const socket = new CanvasSocket();
  const client = new RemoteSurfaceClient({
    directory: '/project', sessionId: 'session-1',
    refreshAuthToken: async () => undefined,
    resolveSocketUrl: () => 'ws://runtime/api/browser-surface',
    openSocket: () => socket,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    client.stop();
    host.remove();
  });
  const render = async (activeTabId: string | null = 'sc:target', enabled = true) => {
    await act(async () => {
      root.render(<I18nProvider><RemoteBrowserCanvas client={client} activeTabId={activeTabId}
        enabled={enabled} onDisplayScaleChange={onDisplayScaleChange} onOpenDevTools={onOpenDevTools}
        onFrameFailure={() => undefined} /></I18nProvider>);
    });
  };
  await render();
  const canvas = host.querySelector('canvas');
  const input = host.querySelector('textarea');
  const button = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent === 'Type in page');
  if (!canvas || !input || !button) throw new Error('Expected the canvas and keyboard controls');
  const captured = new Set<number>();
  Object.defineProperties(canvas, {
    getContext: { value: () => ({ drawImage() {} }) },
    getBoundingClientRect: { value: () => new dom.DOMRect(20, 30, 500, 250) },
    setPointerCapture: { value: (id: number) => { captured.add(id); } },
    hasPointerCapture: { value: (id: number) => captured.has(id) },
    releasePointerCapture: { value: (id: number) => { captured.delete(id); } },
  });
  await act(async () => {
    await client.start();
    socket.readyState = 1;
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({
      type: 'attached', session: { id: 'session-1', directory: '/project' },
      tabs: [{ id: 'sc:target' }],
    }) });
    const { requestId } = z.object({ type: z.literal('attachTab'), requestId: z.string() })
      .parse(JSON.parse(socket.sent.at(-1) ?? 'null'));
    socket.onmessage?.({ data: JSON.stringify({ type: 'state', tabId: 'sc:target',
      attachmentRequestId: requestId, lease: { actor: 'user' } }) });
    socket.onmessage?.({ data: JSON.stringify({
      type: 'frame', frameSeq: 1, streamGen: 1, tabId: 'sc:target', width: 1000, height: 500, scale: 2,
    }) });
    socket.onmessage?.({ data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer });
  });
  expect(socket.sent).toContain(JSON.stringify({ type: 'frameAck', frameSeq: 1 }));
  expect(canvas.width).toBe(2000);
  socket.sent.length = 0;
  return { socket, canvas, input, button, host, client, root, render };
};
