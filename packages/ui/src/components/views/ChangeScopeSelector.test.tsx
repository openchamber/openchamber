import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('the view picker shows a count only once it is known', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, NodeList: dom.NodeList,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ChangeScopeSelector } = await import('./ChangeScopeSelector');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const trigger = async (prCount: number | null) => {
    await act(async () => {
      root.render(<I18nProvider><ChangeScopeSelector scope="pr" workingCount={4} stagedCount={1} turnCount={0}
        branchCount={null} commitCount={null} prCount={prCount} showCommitOption showBranchOption={false}
        changeRequestTerm="pullRequest" /></I18nProvider>);
    });
    return container.querySelector('button')?.textContent;
  };
  try {
    // A pull request whose files are not read (still loading, or a diff the
    // host does not serve) is not a pull request with no files.
    expect(await trigger(null)).toBe('Pull Requests');
    expect(await trigger(3)).toBe('Pull Requests: 3');
    const requestedScopes: string[] = [];
    await act(async () => {
      root.render(<I18nProvider><ChangeScopeSelector scope="turn" historicalTurn={{ count: 2 }} workingCount={4} stagedCount={1} turnCount={5}
        branchCount={null} commitCount={null} prCount={null} showCommitOption showBranchOption={false}
        changeRequestTerm="pullRequest" onScopeChange={(value) => requestedScopes.push(value)} /></I18nProvider>);
    });
    expect(container.querySelector('button')?.textContent).toBe('Earlier turn: 2');
    await act(async () => container.querySelector('button')?.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    // The older turn has its own entry; Last turn keeps the latest turn's count.
    expect(items.find((element) => element.textContent?.startsWith('Earlier turn'))?.textContent).toBe('Earlier turn2');
    const lastTurn = items.find((element) => element.textContent?.includes('Last turn'));
    expect(lastTurn?.textContent).toBe('Last turn5');
    await act(async () => lastTurn?.click());
    expect(requestedScopes).toEqual(['turn']);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 30_000);
