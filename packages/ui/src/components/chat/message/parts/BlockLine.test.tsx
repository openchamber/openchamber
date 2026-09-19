import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import { BlockLine } from './BlockLine';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'HTMLElement',
  'Element',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDomStub = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    HTMLElement: happyWindow.HTMLElement,
    Element: happyWindow.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  // Read back through the global bindings just installed, so the container is
  // typed as the DOM element React expects rather than happy-dom's own class.
  const container = document.createElement('div');
  document.body.appendChild(container);

  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('BlockLine', () => {
  test('renders a 12px hit strip with the 1px line centered on it', () => {
    const markup = renderToStaticMarkup(<BlockLine topOffset={1} />);
    expect(markup).toContain('width:12px');
    expect(markup).toContain('left:-6px');
  });

  test('clicking the line fires the toggle', async () => {
    const { container, restore } = installDomStub();
    try {
      let toggles = 0;
      const root = createRoot(container);
      await act(async () => {
        root.render(<BlockLine onToggle={() => { toggles += 1; }} />);
      });
      const strip = container.querySelector('span.cursor-pointer') as HTMLElement | null;
      expect(strip).not.toBeNull();
      await act(async () => {
        strip!.click();
      });
      expect(toggles).toBe(1);
      await act(async () => {
        root.unmount();
      });
    } finally {
      restore();
    }
  });

  test('without onToggle, clicking toggles the nearest native details', async () => {
    const { container, restore } = installDomStub();
    try {
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <details open>
            <summary>section</summary>
            <div><BlockLine /></div>
          </details>,
        );
      });
      const strip = container.querySelector('span.cursor-pointer') as HTMLElement | null;
      const details = container.querySelector('details') as HTMLDetailsElement | null;
      expect(details?.open).toBe(true);
      await act(async () => {
        strip!.click();
      });
      expect(details?.open).toBe(false);
      await act(async () => {
        root.unmount();
      });
    } finally {
      restore();
    }
  });
});
