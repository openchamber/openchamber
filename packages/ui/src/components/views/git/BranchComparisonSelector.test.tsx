import React, { act, useState } from 'react';
import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';

const checkBranchSelection = async (mobile: boolean, tablet = false) => {
  const dom = new Window({ url: 'http://localhost' });
  if (mobile && !tablet) dom.happyDOM.setWindowSize({ width: 390, height: 844 });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { BranchComparisonSelector } = await import('./BranchComparisonSelector');
  const { I18nProvider } = await import('@/lib/i18n');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const choices: string[] = [];
  function Harness() {
    const [base, setBase] = useState<string | null>(null);
    return <BranchComparisonSelector
      mobile={mobile}
      branches={['feature', 'main', 'parent', 'remotes/origin/main']}
      currentBranch="feature"
      base={base}
      onSelect={(ref) => { choices.push(ref); setBase(ref); }}
    />;
  }
  const trigger = () => {
    const button = container.querySelector('button');
    if (!button) throw new Error('Missing branch trigger');
    return button;
  };
  const selectedRef = () => document.querySelector('[cmdk-item][data-selected="true"]')?.getAttribute('data-value');
  const press = async (key: string, ctrlKey = false) => {
    const input = document.querySelector('input');
    if (!input) throw new Error('Missing branch search');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }));
    });
  };
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
    await act(async () => trigger().click());
    if (mobile) {
      if (tablet) expect(document.querySelector('[role="dialog"]')).toBeNull();
      else expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      if (!tablet) expect(document.activeElement).not.toBe(document.querySelector('input'));
    }
    expect(document.querySelector('[data-value="refs/heads/feature"]')).toBeNull();
    await press('ArrowDown');
    const afterDown = selectedRef();
    expect(afterDown).toBe('refs/heads/parent');
    await press('ArrowUp');
    await press('n', true);
    expect(selectedRef()).toBe(afterDown);
    await press('p', true);
    await press('Enter');
    expect(choices).toHaveLength(1);
    expect(trigger().textContent).toContain('main');

    await act(async () => trigger().click());
    const input = document.querySelector('input');
    if (!input) throw new Error('Missing branch search');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'parent');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(1);
    await press('Enter');
    expect(choices).toEqual(['refs/heads/main', 'refs/heads/parent']);
    expect(trigger().textContent).toContain('parent');
    await act(async () => trigger().click());
    expect(document.querySelector('input')?.value).toBe('');
    const remote = document.querySelector<HTMLElement>('[data-value="refs/remotes/origin/main"]');
    if (!remote) throw new Error('Missing remote branch');
    await act(async () => remote.click());
    expect(choices.at(-1)).toBe('refs/remotes/origin/main');
    expect(trigger().textContent).toContain('origin/main');
    await act(async () => {
      trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelector('input')).toBeNull();
    await act(async () => trigger().click());
    await press('Escape');
    expect(document.querySelector('input')).toBeNull();
    expect(choices).toHaveLength(3);
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
  test(`allows repeated base selection with search and keyboard navigation (mobile=${mobile})`, () => checkBranchSelection(mobile));
}
test('keeps the mobile branch picker anchored on tablets', () => checkBranchSelection(true, true));
