import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

mock.module('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div>,
}));

mock.module('@/sync/sync-context', () => ({
  useScopedBlockingPermissions: () => [],
  useScopedBlockingForms: () => [],
}));

type BtwInput = {
  parentSessionId: string;
  directory: string | null;
  question: string;
  runtimeKey: string;
};
const runCalls: BtwInput[] = [];
const dismissCalls: string[] = [];
const openCalls: Array<[string, string, string | null]> = [];
const runBtwQuestion = (input: BtwInput) => {
  runCalls.push(input);
  return Promise.resolve();
};
const dismissBtw = (parentSessionId: string) => {
  dismissCalls.push(parentSessionId);
};
const openBtwComposer = (parentSessionId: string, ownerKey: string, directory: string | null) => {
  openCalls.push([parentSessionId, ownerKey, directory]);
  return true;
};
mock.module('@/lib/btw', () => ({ runBtwQuestion, dismissBtw, openBtwComposer }));

const { BtwDialog } = await import('./BtwDialog');
const { useBtwStore } = await import('@/stores/useBtwStore');

const PARENT = 'parent-1';

let happyWindow: Window;
let previous: Array<readonly [string, PropertyDescriptor | undefined]>;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  happyWindow = new Window({ url: 'http://localhost' });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    localStorage: happyWindow.localStorage,
    customElements: happyWindow.customElements,
    Node: happyWindow.Node,
    Text: happyWindow.Text,
    NodeList: happyWindow.NodeList,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    SVGElement: happyWindow.SVGElement,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    ResizeObserver: happyWindow.ResizeObserver,
    MutationObserver: happyWindow.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useBtwStore.setState({ byParent: {} });
  runCalls.length = 0;
  dismissCalls.length = 0;
  openCalls.length = 0;
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  await happyWindow.happyDOM.abort();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const render = async () => {
  await act(async () => {
    root.render(
      <I18nProvider>
        <BtwDialog parentSessionId={PARENT} ownerKey="main:parent-1" directory="/repo" />
      </I18nProvider>,
    );
  });
};

const button = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text));

describe('BtwDialog', () => {
  test('compose asks through the transient runner', async () => {
    useBtwStore.getState().openComposer(PARENT, 'main:parent-1', '/repo', 'why did step 2 fail?');
    await render();

    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('why did step 2 fail?');
    await act(async () => button('Ask')?.click());
    expect(runCalls[0]).toMatchObject({
      parentSessionId: PARENT,
      ownerKey: 'main:parent-1',
      directory: '/repo',
      question: 'why did step 2 fail?',
    });
  });

  test('a request owned by another composer does not open this dialog', async () => {
    useBtwStore.getState().openComposer(PARENT, 'pinned:other', '/repo', 'why?');
    await render();
    expect(container.querySelector('textarea')).toBeNull();
  });

  test('running shows a cancel action that dismisses only the side question', async () => {
    useBtwStore.getState().begin(PARENT, 'req-1', 'main:parent-1', 'why?', '/repo', 'runtime');
    await render();
    expect(container.textContent).toContain('why?');
    await act(async () => button('Cancel')?.click());
    expect(dismissCalls).toEqual([PARENT]);
  });

  test('an answered request renders markdown and copies it', async () => {
    useBtwStore.getState().begin(PARENT, 'req-1', 'main:parent-1', 'why?', '/repo', 'runtime');
    useBtwStore.getState().succeed(PARENT, 'req-1', 'Because the fixture was stale.', 2);
    await render();
    expect(container.querySelector('[data-markdown]')?.textContent).toBe('Because the fixture was stale.');

    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (value: string) => { writes.push(value); return Promise.resolve(); } },
    });
    await act(async () => button('Copy')?.click());
    expect(writes).toEqual(['Because the fixture was stale.']);
  });

  test('a failed request retries the same question', async () => {
    useBtwStore.getState().begin(PARENT, 'req-1', 'main:parent-1', 'why?', '/repo', 'runtime');
    useBtwStore.getState().fail(PARENT, 'req-1', 'timeout');
    await render();
    expect(container.textContent).toContain('The side question timed out. Retry.');
    await act(async () => button('Retry')?.click());
    expect(runCalls[0]).toMatchObject({
      parentSessionId: PARENT,
      ownerKey: 'main:parent-1',
      directory: '/repo',
      question: 'why?',
    });
  });

  test('Ask another returns to the compose stage', async () => {
    useBtwStore.getState().begin(PARENT, 'req-1', 'main:parent-1', 'why?', '/repo', 'runtime');
    useBtwStore.getState().succeed(PARENT, 'req-1', 'answer', 2);
    await render();
    await act(async () => button('Ask another')?.click());
    expect(openCalls).toEqual([[PARENT, 'main:parent-1', '/repo']]);
  });
});
