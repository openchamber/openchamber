import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { StatusHeaderControls } from './StatusHeaderControls.tsx';

test('renders independent controls with full accessible labels and refuses disabled activation', async () => {
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
  const events: Array<{ id: string; value?: string }> = [];

  try {
    await act(async () => root.render(
      <StatusHeaderControls
        layout="below"
        controls={[
          { kind: 'button', id: 'refresh', label: 'Refresh all remote branches' },
          { kind: 'button', id: 'disabled', label: 'Disabled action', disabled: true },
          {
            kind: 'select',
            id: 'scope',
            label: 'Repository scope',
            value: 'current',
            options: [{ value: 'current', label: 'Current repository' }, { value: 'all', label: 'All repositories' }],
          },
          {
            kind: 'select',
            id: 'disabled-scope',
            label: 'Disabled repository scope',
            value: 'current',
            disabled: true,
            options: [{ value: 'current', label: 'Current repository' }],
          },
        ]}
        onActivate={(id, value) => events.push(value === undefined ? { id } : { id, value })}
      />,
    ));

    const controls = container.querySelector<HTMLElement>('[data-work-status-controls]');
    expect(controls?.className).toContain('grid-cols-2');
    expect(container.querySelector('[data-work-status-control="refresh"] button')?.getAttribute('aria-label'))
      .toBe('Refresh all remote branches');
    expect(container.querySelector('[data-work-status-control="scope"] button')?.getAttribute('aria-label'))
      .toBe('Repository scope: Current repository');
    expect(container.querySelector<HTMLButtonElement>('[data-work-status-control="disabled-scope"] button')?.disabled).toBe(true);

    const refresh = container.querySelector<HTMLButtonElement>('[data-work-status-control="refresh"] button');
    const disabled = container.querySelector<HTMLButtonElement>('[data-work-status-control="disabled"] button');
    if (!refresh || !disabled) throw new Error('Status controls did not render');
    await act(async () => refresh.click());
    await act(async () => disabled.click());
    expect(events).toEqual([{ id: 'refresh' }]);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
