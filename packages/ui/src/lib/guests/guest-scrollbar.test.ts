import { afterEach, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';
import { GUEST_SCROLLBAR_CSS, GUEST_SCROLLBAR_SCRIPT } from '@openchamber/sdk';

const windows: Window[] = [];
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

test('guest scrollbars are hidden at rest and shown on hover or while scrolling, with forced colors kept', () => {
  expect(GUEST_SCROLLBAR_CSS).toContain('scrollbar-color: transparent transparent');
  expect(GUEST_SCROLLBAR_CSS).toContain(':hover::-webkit-scrollbar-thumb, [data-oc-scrolling]::-webkit-scrollbar-thumb');
  expect(GUEST_SCROLLBAR_CSS).toContain('@media (forced-colors: active)');
});

test('the served script marks a scrolling element and clears it after a quiet second', async () => {
  const window = new Window();
  windows.push(window);
  const { document } = window;
  document.body.innerHTML = '<div id="list"></div>';
  const run = () => runInNewContext(GUEST_SCROLLBAR_SCRIPT, {
    document, Element: window.Element, WeakMap, setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
  });
  run();
  run(); // a second copy (kit + served script) must not add another listener
  const list = document.getElementById('list');
  if (!list) throw new Error('Missing list');
  list.dispatchEvent(new window.Event('scroll'));
  expect(list.hasAttribute('data-oc-scrolling')).toBe(true);
  document.dispatchEvent(new window.Event('scroll'));
  expect(document.documentElement.hasAttribute('data-oc-scrolling')).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(list.hasAttribute('data-oc-scrolling')).toBe(false);
  expect(document.documentElement.hasAttribute('data-oc-scrolling')).toBe(false);
});
