import React, { act, useState } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitLogEntry } from '@/lib/api/types';

const checkCommitSelection = async (mobile: boolean, tablet = false) => {
  const dom = new Window({ url: 'http://localhost' });
  if (mobile && !tablet) dom.happyDOM.setWindowSize({ width: 390, height: 844 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { CommitComparisonSelector } = await import('./CommitComparisonSelector');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const commits: GitLogEntry[] = ['a', 'b'].map((letter, index) => ({
    hash: letter.repeat(40), message: index === 0 ? 'fix: first commit' : 'feat: second commit',
    author_name: 'Test Author', author_email: 'test@example.com', date: '2026-09-09T09:22:00Z',
    body: '', refs: '', parents: [], filesChanged: 1, insertions: 2, deletions: 1,
  }));
  const selected: string[] = [];
  let refreshes = 0;
  function Harness() {
    const [hash, setHash] = useState<string | null>(null);
    return <>{['changes', 'walkthrough'].map((name) => <section key={name} data-picker={name}>
      <CommitComparisonSelector mobile={mobile} commits={commits} selectedHash={hash} loading={false} error={null}
        onRefresh={() => { refreshes += 1; }}
        onSelect={(commit) => { selected.push(commit.hash); setHash(commit.hash); }} />
    </section>)}</>;
  }
  const trigger = (name: string) => {
    const button = container.querySelector<HTMLButtonElement>(`[data-picker="${name}"] button`);
    if (!button) throw new Error('Missing commit picker');
    return button;
  };
  const input = () => {
    const value = document.querySelector('input');
    if (!value) throw new Error('Missing commit search');
    return value;
  };
  const press = async (key: string, ctrlKey = false) => {
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true })); });
  };
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    await act(async () => trigger('changes').click());
    if (mobile) {
      if (tablet) expect(document.querySelector('[role="dialog"]')).toBeNull();
      else expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      if (!tablet) expect(document.activeElement).not.toBe(input());
    }
    const first = document.querySelector('[cmdk-item]');
    expect(first?.textContent).toContain('fix: first commit');
    expect(first?.textContent).toContain('Test Author');
    expect(first?.textContent).toContain('2026');
    expect(first?.textContent).toContain('aaaaaaaa');
    await press('ArrowDown');
    expect(document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value')).toBe('b'.repeat(40));
    await press('p', true);
    await press('n', true);
    await press('Enter');
    expect(trigger('walkthrough').textContent).toContain('bbbbbbbb');

    await act(async () => trigger('walkthrough').click());
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set?.call(input(), 'first');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(1);
    await press('Enter');
    expect(trigger('changes').textContent).toContain('aaaaaaaa');
    expect(selected).toEqual(['b'.repeat(40), 'a'.repeat(40)]);
    expect(refreshes).toBe(2);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

for (const mobile of [false, true]) {
  test(`shows commit metadata and shares repeated searched selections between two pickers (mobile=${mobile})`, () => checkCommitSelection(mobile));
}
test('keeps the mobile commit picker anchored on tablets', () => checkCommitSelection(true, true));
