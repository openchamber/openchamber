import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { usePageDrawn } from './usePageDrawn';

test('input runs with a deadline on a drawn stage, and a timeout restores it', async () => {
  const dom = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let withInput: (<T>(run: (expiresAt: number) => Promise<T>) => Promise<T>) | undefined;
  let drawn = false;
  let reveals = 0;
  const reveal = () => { reveals++; drawn = true; return () => { drawn = false; }; };
  const wait = async () => true;
  function Probe() {
    const stage = React.useRef<HTMLElement | null>(null);
    const page = React.useRef<HTMLElement | null>(null);
    withInput = usePageDrawn(stage, page, reveal, wait);
    return null;
  }
  const input = <T,>(run: (expiresAt: number) => Promise<T>) => {
    if (!withInput) throw new Error('Hook did not mount');
    return withInput(run);
  };
  try {
    await act(async () => root.render(<Probe />));
    const now = spyOn(Date, 'now').mockImplementation(() => 1_000);
    const deadline = await input(async (expiresAt) => { expect(drawn).toBe(true); return expiresAt; })
      .finally(() => now.mockRestore());
    expect(deadline).toBe(13_000);
    expect(reveals).toBe(1);
    expect(drawn).toBe(false);
    await expect(input(() => new Promise(() => {}))).rejects.toThrow('did not take the input in time');
    expect(drawn).toBe(false);
    await input(async () => { expect(drawn).toBe(true); });
    expect(reveals).toBe(3);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.happyDOM.abort();
  }
}, 20_000);
