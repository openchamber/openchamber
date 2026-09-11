import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { HunkBusyState } from './HunkActions';

test('each compact capsule acts on its own hunk and shares the mutation lock', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { HunkActions } = await import('./HunkActions');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const actions: string[] = [];
  const render = (staged = false, busyHunk: HunkBusyState = null) => act(async () => root.render(
    <I18nProvider>{[0, 1, 2].map((index) => <HunkActions key={index} index={index} staged={staged}
      busyHunk={busyHunk} disabled={false} onAction={(hunk, action) => actions.push(`${action}:${hunk}`)} />)}</I18nProvider>
  ));
  const button = (label: string) => {
    const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!target) throw new Error(`Missing ${label}`);
    return target;
  };
  try {
    await render();
    expect(container.querySelectorAll('[data-hunk-actions]')).toHaveLength(3);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(button('Stage hunk 2').closest('[data-hunk-actions]')?.getAttribute('data-hunk-actions')).toBe('1');
    await act(async () => button('Stage hunk 2').click());
    await act(async () => button('Discard hunk 3').click());
    expect(actions).toEqual(['stage:1', 'discard:2']);

    await render(false, { index: 1, action: 'stage' });
    expect([...container.querySelectorAll('button')].every((entry) => entry.disabled)).toBe(true);
    expect(button('Stage hunk 2').querySelector('.animate-spin')).not.toBeNull();
    await act(async () => button('Discard hunk 1').click());
    expect(actions).toHaveLength(2);

    await render(true);
    expect(container.querySelectorAll('button')).toHaveLength(3);
    expect(container.querySelector('button[aria-label="Stage hunk 1"]')).toBeNull();
    await act(async () => button('Unstage hunk 1').click());
    expect(actions.at(-1)).toBe('unstage:0');
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
