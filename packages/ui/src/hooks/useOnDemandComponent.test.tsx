import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';

const withDom = async (run: () => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  try {
    await run();
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

type Deferred = { promise: Promise<React.ComponentType<{ label: string }>>; resolve: () => void; reject: (error: Error) => void };

const Loaded: React.FC<{ label: string }> = ({ label }) => <span data-loaded="true">{label}</span>;

const createLoader = () => {
  const calls: Deferred[] = [];
  const load = () => {
    let resolve = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<React.ComponentType<{ label: string }>>((resolvePromise, rejectPromise) => {
      resolve = () => resolvePromise(Loaded);
      reject = rejectPromise;
    });
    calls.push({ promise, resolve, reject });
    return promise;
  };
  return { calls, load };
};

const mount = async (element: React.ReactElement): Promise<{ root: Root; container: HTMLElement }> => {
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { root, container };
};

test('loads only once needed, renders the component once its module arrives, and never reloads it', () => withDom(async () => {
  const { useOnDemandComponent } = await import('./useOnDemandComponent');
  const { calls, load } = createLoader();
  const Host: React.FC<{ needed: boolean }> = ({ needed }) => {
    const Component = useOnDemandComponent(needed, load, () => {});
    return Component ? <Component label="settings" /> : null;
  };

  const { root, container } = await mount(<Host needed={false} />);
  expect(calls.length).toBe(0);
  expect(container.innerHTML).toBe('');

  await act(async () => root.render(<Host needed />));
  expect(calls.length).toBe(1);
  expect(container.innerHTML).toBe('');

  await act(async () => {
    calls[0].resolve();
    await calls[0].promise;
  });
  expect(container.querySelector('[data-loaded]')?.textContent).toBe('settings');

  await act(async () => root.render(<Host needed={false} />));
  await act(async () => root.render(<Host needed />));
  expect(calls.length).toBe(1);
  expect(container.querySelector('[data-loaded]')?.textContent).toBe('settings');

  await act(async () => root.unmount());
}));

test('reports a failed load and tries again on the next open', () => withDom(async () => {
  const { useOnDemandComponent } = await import('./useOnDemandComponent');
  const { calls, load } = createLoader();
  let failures = 0;
  const originalConsoleError = console.error;
  console.error = () => {};
  const Host: React.FC<{ needed: boolean }> = ({ needed }) => {
    const Component = useOnDemandComponent(needed, load, () => { failures += 1; });
    return Component ? <Component label="settings" /> : null;
  };

  try {
    const { root, container } = await mount(<Host needed />);
    await act(async () => {
      calls[0].reject(new Error('boom'));
      await calls[0].promise.catch(() => {});
    });
    expect(failures).toBe(1);
    expect(container.innerHTML).toBe('');

    await act(async () => root.render(<Host needed={false} />));
    await act(async () => root.render(<Host needed />));
    expect(calls.length).toBe(2);
    await act(async () => {
      calls[1].resolve();
      await calls[1].promise;
    });
    expect(container.querySelector('[data-loaded]')?.textContent).toBe('settings');
    await act(async () => root.unmount());
  } finally {
    console.error = originalConsoleError;
  }
}));
