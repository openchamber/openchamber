import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { isRowBoxClick } from './rowBoxClick';

let browser: Window;
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, Element: browser.Element, IS_REACT_ACT_ENVIRONMENT: true })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

// The session row sits in the drag handle, which carries role="button".
const renderRow = async (onBoxClick: () => void) => {
  await act(async () => root.render(
    <div role="button" tabIndex={0}>
      <div data-testid="box" onClick={(event) => { if (isRowBoxClick(event)) onBoxClick(); }}>
        <span data-testid="padding" />
        <div role="button" data-testid="main" />
        <button type="button" data-testid="action" />
      </div>
    </div>,
  ));
};

const click = (testId: string) => {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${testId}`);
  act(() => element.click());
};

test('a click on the box padding opens the row inside a wrapper with a button role', async () => {
  let opened = 0;
  await renderRow(() => { opened += 1; });
  click('padding');
  click('box');
  expect(opened).toBe(2);
});

test('a click on a control inside the box is left to that control', async () => {
  let opened = 0;
  await renderRow(() => { opened += 1; });
  click('main');
  click('action');
  expect(opened).toBe(0);
});
