import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSection } from './WorkStatusPrimitives.tsx';

test('saved expansion overrides a section default and keeps below-title actions independent', async () => {
  const dom = new Window({ url: 'http://status.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Event: dom.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const previous = useUIStore.getState().workStatusExpandedSections;

  try {
    await act(async () => useUIStore.setState({ workStatusExpandedSections: { extension: false } }));
    await act(async () => root.render(
      <WorkStatusCollapsibleSection
        id="extension"
        title="Extension"
        defaultExpanded
        actionLayout="below"
        action={<button type="button">Guest action</button>}
      >
        <span>Frame body</span>
      </WorkStatusCollapsibleSection>,
    ));

    expect(container.textContent).toContain('Guest action');
    expect(container.textContent).not.toContain('Frame body');
    expect(container.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!toggle) throw new Error('Section toggle did not render');
    await act(async () => toggle.click());
    expect(container.textContent).toContain('Frame body');
  } finally {
    await act(async () => useUIStore.setState({ workStatusExpandedSections: previous }));
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
