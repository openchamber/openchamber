import React, { act } from 'react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { MobileSessionRowLines } from './MobileSessionRowLines';
import { mobileSessionRowHeightClass, mobileSessionRowLinesFor } from './mobileSessionRowLayout';

let browser: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  browser = new Window({ url: 'http://localhost' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

test('Chats and Tree project rows use their own one- or two-line preference', () => {
  expect(mobileSessionRowLinesFor('chats', { chatsLines: 'two', projectLines: 'one' })).toBe('two');
  expect(mobileSessionRowLinesFor('project', { chatsLines: 'two', projectLines: 'one' })).toBe('one');
  expect(mobileSessionRowLinesFor('chats', { chatsLines: 'one', projectLines: 'two' })).toBe('one');
  expect(mobileSessionRowLinesFor('project', { chatsLines: 'one', projectLines: 'two' })).toBe('two');
  expect(mobileSessionRowLinesFor('other', { chatsLines: 'two', projectLines: 'two' })).toBe('one');
});

test('two-line rows render the context line and reserve the matching row height', async () => {
  const host = document.querySelector('div');
  if (!host) throw new Error('Missing render host');

  await act(async () => root.render(
    <MobileSessionRowLines rowLines="one"><span>Session title</span></MobileSessionRowLines>,
  ));
  expect(host.querySelector('[data-mobile-row-title-line]')?.textContent).toBe('Session title');
  expect(host.querySelector('[data-mobile-row-context-line]')).toBeNull();
  expect(mobileSessionRowHeightClass('one', false)).toBe('h-9');

  await act(async () => root.render(
    <MobileSessionRowLines rowLines="two" contextLabel="مشروع · main">
      <span>Session title</span>
    </MobileSessionRowLines>,
  ));
  expect(host.querySelector('[data-mobile-row-title-line]')?.textContent).toBe('Session title');
  const contextLine = host.querySelector('[data-mobile-row-context-line]');
  expect(contextLine?.textContent).toBe('مشروع · main');
  expect(contextLine?.getAttribute('dir')).toBe('auto');
  expect(mobileSessionRowHeightClass('two', true)).toBe('min-h-[52px] py-1');
});
