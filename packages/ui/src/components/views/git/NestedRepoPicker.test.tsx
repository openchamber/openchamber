import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('hides the label at icon-only widths and restores it when the picker grows', async () => {
  const dom = new Window({ url: 'http://localhost' });
  let labelWidth = 80;
  let resizeLabel = () => {};
  let disconnected = false;
  class PickerResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.matches('span.font-medium')) {
        resizeLabel = () => this.callback([], this);
      }
    }
    unobserve() {}
    disconnect() { disconnected = true; }
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    ResizeObserver: PickerResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new dom.DOMRect(0, 0, labelWidth, 28),
  });
  const style = document.createElement('style');
  style.textContent = 'span { font-size: 14px; }';
  document.head.append(style);
  const container = document.createElement('div');
  document.body.append(container);
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { NestedRepoPicker } = await import('./NestedRepoPicker');
  const root = createRoot(container);

  try {
    await act(async () => root.render(
      <I18nProvider>
        <NestedRepoPicker
          repositories={['/workspace/long-repository-name']}
          selectedRepository="/workspace/long-repository-name"
          repositoryRoot="/workspace"
          onSelectRepository={() => {}}
        />
      </I18nProvider>,
    ));
    const label = container.querySelector<HTMLSpanElement>('span.font-medium');
    if (!label) throw new Error('Missing repository label');
    expect(label.style.visibility).toBe('');
    for (const width of [0.2, 8]) {
      labelWidth = width;
      await act(async () => resizeLabel());
      expect(label.style.visibility).toBe('hidden');
      expect(label.textContent).toBe('long-repository-name');
    }
    labelWidth = 80;
    await act(async () => resizeLabel());
    expect(label.style.visibility).toBe('');
  } finally {
    await act(async () => root.unmount());
    expect(disconnected).toBe(true);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
