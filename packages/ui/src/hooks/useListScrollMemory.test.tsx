import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

let restore: () => Promise<void>;

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true,
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
});

afterEach(async () => {
  await restore();
});

const scrollerIn = (host: HTMLElement, id: string): HTMLDivElement => {
  const node = host.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof window.HTMLDivElement)) throw new Error(`the ${id} scroller did not render`);
  return node;
};

test('a list comes back to where it was after its preview unmounts', async () => {
  const { createRoot } = await import('react-dom/client');
  const { useListScrollMemory } = await import('./useListScrollMemory');

  const host = document.createElement('div');
  document.body.appendChild(host);

  const Probe = ({ listKey }: { listKey: string | null }) => {
    const bind = useListScrollMemory(listKey);
    return listKey === null
      ? <section><div data-testid="preview" /></section>
      : <div ref={bind} data-testid="list" />;
  };

  const root = createRoot(host);
  const render = (listKey: string | null) => act(async () => {
    root.render(<Probe listKey={listKey} />);
  });

  await render('files:/project');
  const list = scrollerIn(host, 'list');
  list.scrollTop = 900;
  await act(async () => { list.dispatchEvent(new window.Event('scroll')); });

  // The preview replaces the list; its own scroller starts at the top.
  await render(null);
  expect(scrollerIn(host, 'preview').scrollTop).toBe(0);

  // The list mounts again as a new element and returns to the offset it left.
  await render('files:/project');
  expect(scrollerIn(host, 'list').scrollTop).toBe(900);

  await act(async () => { root.unmount(); });
});

test('each list keeps its own offset, and a view without a list records nothing', async () => {
  const { createRoot } = await import('react-dom/client');
  const { useListScrollMemory } = await import('./useListScrollMemory');

  const host = document.createElement('div');
  document.body.appendChild(host);

  const memory = new Map<string, number>();
  const Probe = ({ listKey }: { listKey: string | null }) => {
    const bind = useListScrollMemory(listKey, { memory });
    return <div ref={bind} data-testid="list" />;
  };

  const root = createRoot(host);
  const render = (listKey: string | null) => act(async () => {
    root.render(<Probe listKey={listKey} />);
  });
  const scrollTo = async (top: number) => {
    const node = scrollerIn(host, 'list');
    node.scrollTop = top;
    await act(async () => { node.dispatchEvent(new window.Event('scroll')); });
  };

  await render('a');
  await scrollTo(900);
  await render('b');
  expect(scrollerIn(host, 'list').scrollTop).toBe(0);
  await scrollTo(300);

  await render('a');
  expect(scrollerIn(host, 'list').scrollTop).toBe(900);
  await render('b');
  expect(scrollerIn(host, 'list').scrollTop).toBe(300);

  // A preview in the same scroller starts at its top, and its scroll must not
  // replace the offset the list had.
  await render(null);
  expect(scrollerIn(host, 'list').scrollTop).toBe(0);
  await scrollTo(120);
  await render('b');
  expect(scrollerIn(host, 'list').scrollTop).toBe(300);

  await act(async () => { root.unmount(); });
});

test('content that is not the key\'s own neither restores nor records', async () => {
  const { createRoot } = await import('react-dom/client');
  const { useListScrollMemory } = await import('./useListScrollMemory');

  const host = document.createElement('div');
  document.body.appendChild(host);

  const memory = new Map<string, number>();
  const Probe = ({ listKey, ready = true }: { listKey: string | null; ready?: boolean }) => {
    const bind = useListScrollMemory(listKey, { ready, memory });
    return <div ref={bind} data-testid="list" />;
  };

  const root = createRoot(host);
  const render = (listKey: string, ready?: boolean) => act(async () => {
    root.render(<Probe listKey={listKey} ready={ready} />);
  });

  await render('a');
  const list = scrollerIn(host, 'list');
  list.scrollTop = 700;
  await act(async () => { list.dispatchEvent(new window.Event('scroll')); });

  // The new list's entries have not arrived; the previous entries are still
  // rendered, and their offset must not be saved as the new list's.
  await render('b', false);
  expect(scrollerIn(host, 'list').scrollTop).toBe(700);
  await act(async () => {
    scrollerIn(host, 'list').scrollTop = 100;
    scrollerIn(host, 'list').dispatchEvent(new window.Event('scroll'));
  });

  await render('b', true);
  expect(scrollerIn(host, 'list').scrollTop).toBe(0);

  await render('a', false);
  await render('a', true);
  expect(scrollerIn(host, 'list').scrollTop).toBe(700);

  await act(async () => { root.unmount(); });
});

test('an offset kept outside the component survives the list unmounting with it', async () => {
  const { createRoot } = await import('react-dom/client');
  const { useListScrollMemory } = await import('./useListScrollMemory');
  const memory = new Map<string, number>();

  const host = document.createElement('div');
  document.body.appendChild(host);
  const Probe = () => {
    const bind = useListScrollMemory('changes:/project', { memory });
    return <div ref={bind} data-testid="list" />;
  };

  const first = createRoot(host);
  await act(async () => first.render(<Probe />));
  const list = scrollerIn(host, 'list');
  list.scrollTop = 640;
  await act(async () => { list.dispatchEvent(new window.Event('scroll')); });
  await act(async () => first.unmount());

  const second = createRoot(host);
  await act(async () => second.render(<Probe />));
  expect(scrollerIn(host, 'list').scrollTop).toBe(640);
  await act(async () => second.unmount());
});

test('a list already on screen is left alone when its content is re-read', async () => {
  const { createRoot } = await import('react-dom/client');
  const { useListScrollMemory } = await import('./useListScrollMemory');

  const host = document.createElement('div');
  document.body.appendChild(host);
  const memory = new Map<string, number>();
  const Probe = ({ ready }: { ready: boolean }) => {
    const bind = useListScrollMemory('a', { ready, memory });
    return <div ref={bind} data-testid="list" />;
  };

  const root = createRoot(host);
  await act(async () => root.render(<Probe ready />));
  const list = scrollerIn(host, 'list');
  list.scrollTop = 800;
  await act(async () => { list.dispatchEvent(new window.Event('scroll')); });

  await act(async () => root.render(<Probe ready={false} />));
  list.scrollTop = 200;
  await act(async () => { list.dispatchEvent(new window.Event('scroll')); });
  await act(async () => root.render(<Probe ready />));
  expect(scrollerIn(host, 'list').scrollTop).toBe(200);

  // The re-read's placeholder clamped the offset; that is not the list's, so
  // the next return still lands where the list was left.
  await act(async () => { root.unmount(); });
  const again = createRoot(host);
  await act(async () => again.render(<Probe ready />));
  expect(scrollerIn(host, 'list').scrollTop).toBe(800);

  await act(async () => { again.unmount(); });
});
