import React, { act } from 'react';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { RemoteSurfaceViewport, type RemoteSurfaceViewportCommand } from '@/lib/browser/remoteSurfaceViewport';

const dom = new Window({ url: 'http://localhost/' });
const bindings = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  InputEvent: dom.InputEvent,
  KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousBindings = Object.keys(bindings).map((key) => ({
  key,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
}));
Object.assign(globalThis, bindings);

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RemoteBrowserViewportControls } = await import('./RemoteBrowserViewportControls');

const setInputValue = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Expected the native input value setter');
  setter.call(input, value);
};

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

const mountControls = async (displayScale: number | null = null) => {
  const commands: RemoteSurfaceViewportCommand[] = [];
  const viewport = new RemoteSurfaceViewport({
    send: (command) => {
      commands.push(command);
      return true;
    },
    schedule: () => ({ cancel: () => undefined }),
  });
  viewport.setAttachment({ tabId: 'sc:tab-1', attachmentRequestId: 'attachment-1' });
  viewport.receive(JSON.stringify({
    type: 'viewportState',
    tabId: 'sc:tab-1',
    attachmentRequestId: 'attachment-1',
    viewport: {
      revision: 1,
      width: 390,
      height: 844,
      mode: 'fixed',
      source: 'viewer',
      mobile: true,
      deviceScaleFactor: 1,
      observed: { layoutWidth: 390, layoutHeight: 844, visualWidth: 390, visualHeight: 844, visualScale: 0.5 },
      autoAllowed: true,
    },
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    viewport.dispose();
    host.remove();
  });
  await act(async () => {
    root.render(
      <I18nProvider>
        <RemoteBrowserViewportControls viewport={viewport} enabled stage={{ width: 900, height: 600 }} displayScale={displayScale} />
      </I18nProvider>,
    );
  });
  return { commands, host, viewport };
};

describe('RemoteBrowserViewportControls', () => {
  test('commits a custom dimension only on blur and preserves mobile emulation', async () => {
    const { commands, host } = await mountControls(0.5);
    const width = host.querySelector('input[aria-label="Width"]');
    if (!(width instanceof HTMLInputElement)) throw new Error('Expected the viewport width input');

    await act(async () => {
      width.focus();
      setInputValue(width, '400');
      width.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '400' }));
    });
    expect(commands).toEqual([]);

    await act(async () => width.blur());
    const command = commands[0];
    if (!command) throw new Error('Expected a viewport resize command');
    expect(command.type).toBe('viewportSet');
    expect(command.width).toBe(400);
    expect(command.height).toBe(844);
    expect(command.mode).toBe('fixed');
    expect(command.mobile).toBe(true);
    expect(command.takeover).toBe(true);
    expect(host.textContent).toContain('Confirmed: 390 × 844');
    expect(host.textContent).toContain('Display scale: 50%');
  });

  test('reports the canvas fit scale instead of page visual viewport zoom', async () => {
    const { host } = await mountControls(299.65625 / 390);

    expect(host.textContent).toContain('Display scale: 77%');
    expect(host.textContent).not.toContain('Display scale: 50%');
  });

  test('keeps the confirmed dimensions visible when a resize fails', async () => {
    const { commands, host, viewport } = await mountControls();
    const width = host.querySelector('input[aria-label="Width"]');
    if (!(width instanceof HTMLInputElement)) throw new Error('Expected the viewport width input');

    await act(async () => {
      width.focus();
      setInputValue(width, '400');
      width.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '400' }));
      width.blur();
    });
    const command = commands[0];
    if (!command) throw new Error('Expected a viewport resize command');
    await act(async () => {
      viewport.receive(JSON.stringify({
        type: 'viewportError',
        requestId: command.requestId,
        tabId: command.tabId,
        attachmentRequestId: command.attachmentRequestId,
        code: 'RESIZE_FAILED',
        message: 'backend detail',
      }));
    });

    expect(host.textContent).toContain('Confirmed: 390 × 844');
    expect(host.textContent).toContain('Viewport resize failed: RESIZE_FAILED');
  });

  test('does not invent mobile emulation for externally controlled DevTools', async () => {
    const { host, viewport } = await mountControls();
    await act(async () => {
      viewport.receive(JSON.stringify({
        type: 'viewportState',
        tabId: 'sc:tab-1',
        attachmentRequestId: 'attachment-1',
        viewport: {
          revision: 2,
          width: 1280,
          height: 720,
          mode: 'external',
          source: 'external',
          mobile: null,
          deviceScaleFactor: null,
          observed: { layoutWidth: 1280, layoutHeight: 720, visualWidth: 1280, visualHeight: 720, visualScale: 1 },
          autoAllowed: false,
        },
      }));
    });

    expect(host.textContent).toContain('External DevTools controls this viewport');
    expect(host.querySelector('[aria-label="Emulate mobile device"]')).toBeNull();
  });
});
