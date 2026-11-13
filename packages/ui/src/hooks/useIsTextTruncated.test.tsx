import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const observed: Element[] = [];
class RecordingResizeObserver {
  observe(element: Element) { observed.push(element); }
  disconnect() {}
  unobserve() {}
}

let restore: () => Promise<void>;

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
    ResizeObserver: RecordingResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  restore = async () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  };
  observed.length = 0;
});

afterEach(async () => {
  await restore();
});

test('a label keyed by its text is observed again after it remounts', async () => {
  const { createRoot } = await import('react-dom/client');
  const { useIsTextTruncated } = await import('./useIsTextTruncated');
  const Label = ({ text }: { text: string }) => {
    const ref = React.useRef<HTMLSpanElement>(null);
    useIsTextTruncated(ref, [text]);
    return <span key={text} ref={ref}>{text}</span>;
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Label text="Opus 5.5" />));
  await act(async () => root.render(<Label text="GPT-6.1 Sol" />));
  const label = container.querySelector('span');
  expect(observed.at(-1)).toBe(label!);
  await act(async () => root.unmount());
});
