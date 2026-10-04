import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitRemote } from '@/lib/gitApi';

const origin: GitRemote = { name: 'origin', fetchUrl: 'git@example.com:me/project.git', pushUrl: 'git@example.com:me/project.git' };
const upstream: GitRemote = { name: 'upstream', fetchUrl: 'git@example.com:them/project.git', pushUrl: 'git@example.com:them/project.git' };

test('the sync menu offers a pull from the tracking remote and blocks it over tracked changes', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { SyncActions } = await import('./SyncActions');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls: string[] = [];
  const render = (hasUncommittedChanges: boolean, aheadCount = 1) => act(async () => root.render(
    <I18nProvider>
      <SyncActions
        syncAction={null}
        remotes={[upstream, origin]}
        onFetch={(remote) => calls.push(`fetch:${remote.name}`)}
        onPull={(remote) => calls.push(`pull:${remote.name}`)}
        onSync={(remote) => calls.push(`sync:${remote.name}`)}
        onPublish={() => calls.push('publish')}
        onChooseSyncTargets={() => calls.push('choose')}
        currentBranch="main"
        hasTracking
        disabled={false}
        aheadCount={aheadCount}
        behindCount={2}
        trackingRemoteName="origin"
        trackingBranch="origin/main"
        hasUncommittedChanges={hasUncommittedChanges}
      />
    </I18nProvider>
  ));
  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="More sync actions"]');
    if (!trigger) throw new Error('Missing menu trigger');
    await act(async () => { trigger.click(); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.startsWith('Pull (rebase)'));
    if (!item) throw new Error('Missing pull item');
    return item;
  };

  try {
    await render(false);
    let item = await openMenu();
    expect(item.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { item.click(); });
    expect(calls).toEqual(['pull:origin']);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    await render(true);
    item = await openMenu();
    expect(item.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { item.click(); });
    expect(calls).toEqual(['pull:origin']);
    const fetchItems = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((entry) => entry.textContent?.includes('Fetch from'));
    expect(fetchItems.map((entry) => entry.getAttribute('aria-disabled'))).toEqual([null, null]);
    const pushItem = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.startsWith('Push'));
    expect(pushItem()?.getAttribute('aria-disabled')).toBeNull();

    // Nothing ahead of the tracked branch: nothing to push, as the sync button shows no count.
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await render(false, 0);
    await openMenu();
    expect(pushItem()?.getAttribute('aria-disabled')).toBe('true');
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
