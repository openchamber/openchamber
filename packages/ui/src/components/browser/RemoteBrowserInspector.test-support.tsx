import React, { act } from 'react';
import { afterAll, afterEach } from 'bun:test';
import { Window } from 'happy-dom';
import { RemoteSurfaceInspector } from '@/lib/browser/remoteSurfaceInspector';
import type { SurfaceInspectorCommand } from '@/lib/browser/remoteSurfaceInspectorProtocol';

const dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
const bindings = {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element, Node: dom.Node, Event: dom.Event, InputEvent: dom.InputEvent, MessageEvent: dom.MessageEvent,
  KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.PointerEvent, ResizeObserver: dom.ResizeObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const original = Object.keys(bindings).map((name) => ({ name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }));
Object.assign(globalThis, bindings);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(() => {
  for (const { name, descriptor } of original) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.happyDOM.abort();
});

export const mountInspectorView = async (element: React.ReactNode) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (view: React.ReactNode) => { await act(async () => root.render(<I18nProvider>{view}</I18nProvider>)); };
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(element);
  return { host, render };
};

export const inspectorFixture = () => {
  const commands: SurfaceInspectorCommand[] = [];
  const inspector = new RemoteSurfaceInspector((command) => { commands.push(command); return true; });
  inspector.setAttachment('sc:inspected');
  cleanups.push(async () => { await act(async () => inspector.setOpen(false)); });
  const start = async () => {
    await act(async () => inspector.setOpen(true));
    const request = commands.filter((command) => command.type === 'inspectorStart').at(-1);
    if (!request) throw new Error('Expected inspector start');
    await act(async () => inspector.receive(JSON.stringify({ ...request, type: 'inspectorStarted', captureId: 'capture-1' })));
  };
  return { commands, inspector, start };
};

export const fillTextarea = async (textarea: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  });
};
