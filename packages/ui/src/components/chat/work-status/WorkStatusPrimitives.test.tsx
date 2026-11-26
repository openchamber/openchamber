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

test('titleAction sits between the title and summary without toggling the section on click', async () => {
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
  let clicks = 0;

  try {
    await act(async () => useUIStore.setState({ workStatusExpandedSections: { usage: false } }));
    await act(async () => root.render(
      <WorkStatusCollapsibleSection
        id="usage"
        title="Usage"
        summary="20%"
        titleAction={<button type="button" onClick={() => { clicks += 1; }}>Refresh</button>}
      >
        <span>Usage body</span>
      </WorkStatusCollapsibleSection>,
    ));

    const heading = container.querySelector('[data-work-status-heading]');
    expect(heading?.textContent).toBe('UsageRefresh20%');

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    const describedBy = toggle?.getAttribute('aria-describedby');
    expect(describedBy ? document.getElementById(describedBy)?.textContent : null).toBe('20%');

    const refresh = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Refresh');
    if (!refresh) throw new Error('Title action button did not render');
    await act(async () => refresh.click());

    expect(clicks).toBe(1);
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Usage body');
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
