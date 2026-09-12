import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { z } from 'zod';
import type { Root } from 'react-dom/client';

const dom = new Window({ url: 'https://cdp-ui.example/' });
const bindings = {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Element: dom.Element,
  Node: dom.Node, Event: dom.Event, InputEvent: dom.InputEvent, CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
};
const previousBindings = Object.keys(bindings).map((key) => ({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }));
Object.assign(globalThis, bindings);
const originalFetch = globalThis.fetch;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { invalidateSettingsCache, getSettingsSaveState } = await import('@/lib/persistence');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { BrowserDebugPortSettings } = await import('./BrowserDebugPortSettings');
const portChangeSchema = z.object({ serverBrowserDebugPort: z.number().int().min(0).max(65535) });

let root: Root | null = null;
let host: HTMLDivElement;
let configuredPort = 0;
let activePort: number | null = 43000;
let statusFails = false;
let saveFails = false;
let revision = 0;
let statusReads = 0;
const writes: number[] = [];

const render = async () => {
  await act(async () => root?.render(<I18nProvider><BrowserDebugPortSettings statusRevision={revision} /></I18nProvider>));
};
const buttonNamed = (name: string) => {
  const button = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent === name);
  if (!button) throw new Error(`Expected ${name} button`);
  return button;
};
const editPort = async (value: string) => {
  if (!host.querySelector('input')) await act(async () => buttonNamed('Fixed port').click());
  const input = host.querySelector('input');
  if (!input) throw new Error('Expected fixed port input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  });
};
const savePort = async () => {
  await act(async () => {
    buttonNamed('Save port').click();
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
};

beforeEach(() => {
  configuredPort = 0;
  activePort = 43000;
  statusFails = false;
  saveFails = false;
  statusReads = 0;
  revision = 0;
  writes.length = 0;
  registerRuntimeAPIs(null);
  invalidateSettingsCache();
  useUIStore.setState({ serverBrowserDebugPort: 0 });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/browser/runtime-status') {
      statusReads += 1;
      return statusFails ? new Response(null, { status: 401 }) : Response.json({
        configuredPort, running: activePort !== null, activePort, restartRequired: configuredPort !== 0,
      });
    }
    if (url.pathname === '/api/config/settings' && init?.method === 'PUT') {
      expect(url.searchParams.get('surface')).toBe('web');
      const change = portChangeSchema.parse(JSON.parse(String(init.body)));
      writes.push(change.serverBrowserDebugPort);
      if (saveFails) return new Response(null, { status: 500 });
      configuredPort = change.serverBrowserDebugPort;
      return Response.json({ serverBrowserDebugPort: configuredPort });
    }
    return new Response(null, { status: 404 });
  };
  switchRuntimeEndpoint({ apiBaseUrl: 'https://cdp-ui.example', runtimeKey: 'cdp-ui' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const { key, descriptor } of previousBindings) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

describe('browser CDP port settings', () => {
  test('saves only on explicit click and keeps configured and active ports separate', async () => {
    await render();
    await editPort('9222');
    expect(writes).toEqual([]);
    expect(host.textContent).toContain('Configured port: automatic');
    await savePort();
    expect(writes).toEqual([9222]);
    expect(host.textContent).toContain('Configured port: 9222');
    expect(host.textContent).toContain('Active port: 43000');
    expect(host.textContent).toContain('The saved port will apply when Chrome next starts.');
    expect(buttonNamed('Save port').disabled).toBe(true);
  });

  test('prevents invalid fixed ports and persists automatic as zero', async () => {
    configuredPort = 9222;
    await render();
    await editPort('65536');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('1 to 65535');
    expect(buttonNamed('Save port').disabled).toBe(true);
    await act(async () => buttonNamed('Automatic').click());
    await savePort();
    expect(writes).toEqual([0]);
    expect(host.textContent).toContain('Configured port: automatic');
  });

  test('retains the draft and last saved port after a failed write', async () => {
    await render();
    await editPort('9222');
    saveFails = true;
    await savePort();
    expect(writes).toEqual([9222]);
    expect(getSettingsSaveState()).toBe('error');
    expect(host.querySelector('input')?.value).toBe('9222');
    expect(host.textContent).toContain('Configured port: automatic');
    expect(host.textContent).not.toContain('The saved port will apply');
    expect(buttonNamed('Save port').disabled).toBe(false);
  });

  test('copies the active loopback URL only on an explicit click', async () => {
    const copies: string[] = [];
    Object.defineProperty(dom.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copies.push(text); } } });
    configuredPort = 9222;
    await render();
    expect(copies).toEqual([]);
    await act(async () => buttonNamed('Copy browser URL').click());
    expect(copies).toEqual(['http://127.0.0.1:43000']);
  });

  test('refreshes after a browser toggle settles and represents failure as unavailable', async () => {
    await render();
    activePort = null;
    revision += 1;
    await render();
    expect(statusReads).toBe(2);
    expect(host.textContent).toContain('Chrome is not running.');
    statusFails = true;
    await act(async () => buttonNamed('Refresh status').click());
    expect(host.textContent).toContain('Browser status is unavailable.');
    expect(host.textContent).not.toContain('Chrome is not running.');
    expect(host.textContent).not.toContain('Copy browser URL');
  });

  test('cancels clipboard fallback when permission resolves after a runtime switch', async () => {
    let rejectCopy: (error: Error) => void = () => undefined;
    const permission = new Promise<void>((_resolve, reject) => { rejectCopy = reject; });
    Object.defineProperty(dom.navigator, 'clipboard', { configurable: true, value: { writeText: () => permission } });
    let fallbacks = 0;
    const originalExecCommand = document.execCommand;
    document.execCommand = () => { fallbacks += 1; return true; };
    try {
      await render();
      await act(async () => buttonNamed('Copy browser URL').click());
      await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://cdp-next.example', runtimeKey: 'cdp-next' }));
      await act(async () => rejectCopy(new Error('Clipboard permission denied')));
      expect(fallbacks).toBe(0);
      expect(host.textContent).not.toContain('Could not copy the browser URL.');
    } finally {
      document.execCommand = originalExecCommand;
    }
  });

  test('discards a delayed status response after switching runtimes', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    globalThis.fetch = async (input) => String(input).includes('cdp-next.example')
      ? Response.json({ configuredPort: 9223, running: true, activePort: 9223, restartRequired: false })
      : pending;
    await render();
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://cdp-next.example', runtimeKey: 'cdp-next' }));
    expect(host.textContent).toContain('Active port: 9223');
    await act(async () => release(Response.json({ configuredPort: 9222, running: true, activePort: 9222, restartRequired: false })));
    expect(host.textContent).toContain('Active port: 9223');
    expect(host.textContent).not.toContain('9222');
  });
});
