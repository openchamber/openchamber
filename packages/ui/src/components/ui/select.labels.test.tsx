import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import('react-dom/client');
const { Select, SelectTrigger, SelectValue } = await import('./select');

afterAll(() => browser.close());

describe('select triggers', () => {
  test('show the option label wherever the value differs from it', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(
        <Select defaultValue="internal-id">
          <SelectTrigger>
            <SelectValue>Visible option label</SelectValue>
          </SelectTrigger>
        </Select>,
      ));
      expect(host.querySelector('[data-slot="select-value"]')?.textContent).toBe('Visible option label');
      expect(host.textContent).not.toContain('internal-id');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
