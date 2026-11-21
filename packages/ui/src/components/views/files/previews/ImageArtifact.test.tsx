import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLImageElement: browser.HTMLImageElement, Event: browser.Event, KeyboardEvent: browser.KeyboardEvent,
  PointerEvent: browser.PointerEvent, MouseEvent: browser.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
});
// A viewer that is laid out nowhere ignores the keys; happy-dom lays out nothing.
Object.defineProperty(browser.Element.prototype, 'getClientRects', { value: () => [{}] });
// React DOM and the i18n store read the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ImageArtifact } = await import('./ImageArtifact');

let reactRoot: Root | null = null;
let container: HTMLElement | null = null;

const neighbors = () => {
  const previous = mock(() => {});
  const next = mock(() => {});
  return { previous, next, value: { previous: { name: 'a.png', open: previous }, next: { name: 'c.png', open: next } } };
};

const render = async (node: React.ReactNode) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(<I18nProvider>{node}</I18nProvider>));
};

const pressRight = async (target: Element) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  });
};

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  container?.remove();
  reactRoot = null;
  container = null;
});

describe('ImageArtifact', () => {
  test('shows the fullscreen toggle only when the host offers it', async () => {
    const toggle = mock(() => {});
    await render(
      <>
        <div data-testid="plain"><ImageArtifact src="blob:a" name="b.png" sizeBytes={null} /></div>
        <div data-testid="offered"><ImageArtifact src="blob:b" name="b.png" sizeBytes={null} fullscreen={{ active: false, toggle }} /></div>
      </>,
    );
    expect(container?.querySelector('[data-testid="plain"] [data-image-fullscreen-toggle]')).toBeNull();
    const button = container?.querySelector<HTMLElement>('[data-testid="offered"] [data-image-fullscreen-toggle="enter"]');
    expect(button?.getAttribute('aria-label')).toBe('Fullscreen');
    await act(async () => { button?.click(); });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  test('an arrow key in a dialog that stops arrow keys, as Base UI does, steps that viewer, not the docked one', async () => {
    const docked = neighbors();
    const overlay = neighbors();
    await render(
      <>
        <div data-context-panel="">
          <ImageArtifact src="blob:b" name="b.png" sizeBytes={null} neighbors={docked.value} />
        </div>
        <div role="dialog" data-image-fullscreen="" tabIndex={-1} data-testid="dialog" onKeyDown={(event) => event.stopPropagation()}>
          <ImageArtifact src="blob:b" name="b.png" sizeBytes={null} neighbors={overlay.value} />
        </div>
      </>,
    );
    const dialog = container?.querySelector('[data-testid="dialog"]');
    if (!dialog) throw new Error('no dialog');
    await pressRight(dialog);
    expect(overlay.next).toHaveBeenCalledTimes(1);
    expect(docked.next).not.toHaveBeenCalled();
  });

  test('the docked viewer still steps with the focus in its panel', async () => {
    const docked = neighbors();
    await render(
      <div data-context-panel="" tabIndex={-1} data-testid="panel">
        <ImageArtifact src="blob:b" name="b.png" sizeBytes={null} neighbors={docked.value} />
      </div>,
    );
    const panel = container?.querySelector('[data-testid="panel"]');
    if (!panel) throw new Error('no panel');
    await pressRight(panel);
    expect(docked.next).toHaveBeenCalledTimes(1);
  });
});
