import { afterAll, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { Checkbox } = await import('./checkbox');

afterAll(() => {
  browser.close();
});

describe('Checkbox inside a clickable parent', () => {
  test('a click on the box toggles once and never reaches the parent', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const capture = { on: false, parentClicks: 0 };

    const Harness = () => {
      const [on, setOn] = React.useState(false);
      capture.on = on;
      return (
        <button
          type="button"
          onClick={() => {
            capture.parentClicks += 1;
            setOn((value) => !value);
          }}
        >
          <Checkbox checked={on} onChange={setOn} ariaLabel="Draft" />
          Draft
        </button>
      );
    };

    try {
      await act(async () => root.render(<Harness />));
      const box = container.querySelector<HTMLElement>('[role="checkbox"]');
      expect(box).not.toBeNull();
      await act(async () => {
        box?.click();
      });
      expect(capture.on).toBe(true);
      expect(capture.parentClicks).toBe(0);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
