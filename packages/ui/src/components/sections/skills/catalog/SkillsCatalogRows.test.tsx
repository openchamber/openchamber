import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { SkillsCatalogItem } from '@/lib/api/types';

/**
 * A catalog list mounts every row up to the virtualization threshold and only
 * the rows near the viewport from there on, so a source with thousands of
 * skills no longer mounts thousands of rows.
 */

let SkillsCatalogRows: typeof import('./SkillsCatalogRows')['SkillsCatalogRows'];
// The row count from which the list mounts only the rows near the viewport.
const VIRTUAL_CATALOG_MIN_ROWS = 100;
let dom: Window;
let root: Root;
let scroller: HTMLDivElement;
const globals = new Map<string, PropertyDescriptor | undefined>();

const makeItems = (count: number): SkillsCatalogItem[] => Array.from({ length: count }, (_, index) => ({
  sourceId: 'lab',
  repoSource: 'acme/skills',
  skillDir: `skills/skill-${index + 1}`,
  skillName: `skill-${index + 1}`,
  installable: true,
}));

const itemKey = (item: SkillsCatalogItem) => `${item.sourceId}:${item.skillDir}`;

const renderRows = async (count: number) => {
  const items = makeItems(count);
  await act(async () => {
    root.render(
      <SkillsCatalogRows
        items={items}
        itemKey={itemKey}
        renderRow={(item) => <div className="py-2" data-skill-row={item.skillName}>{item.skillName}</div>}
      />,
    );
  });
  return [...scroller.querySelectorAll('[data-skill-row]')].map((row) => row.getAttribute('data-skill-row'));
};

beforeEach(async () => {
  dom = new Window({ url: 'http://localhost', width: 1280, height: 800 });
  const values = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Event: dom.Event, MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(values)) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  ({ SkillsCatalogRows } = await import('./SkillsCatalogRows'));
  // The settings page scroller the list finds from the DOM.
  scroller = document.createElement('div');
  scroller.className = 'overlay-scrollbar-target';
  // happy-dom lays nothing out; the virtualizer reads the viewport from these.
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 800 });
  const content = document.createElement('div');
  scroller.appendChild(content);
  document.body.appendChild(scroller);
  const { createRoot } = await import('react-dom/client');
  root = createRoot(content);
});

afterEach(async () => {
  await act(async () => root.unmount());
  scroller.remove();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
  await dom.happyDOM.abort();
  dom.close();
});

test('mounts every row of a list just under the threshold, in order', async () => {
  const rows = await renderRows(VIRTUAL_CATALOG_MIN_ROWS - 1);

  expect(rows).toHaveLength(VIRTUAL_CATALOG_MIN_ROWS - 1);
  expect(rows[0]).toBe('skill-1');
  expect(rows[rows.length - 1]).toBe(`skill-${VIRTUAL_CATALOG_MIN_ROWS - 1}`);
});

// happy-dom measures every row at 0 height, as a browser does on a hidden page.
test('mounts only the first rows of a list at the threshold and above, even when rows measure 0', async () => {
  for (const count of [VIRTUAL_CATALOG_MIN_ROWS, VIRTUAL_CATALOG_MIN_ROWS + 1, 8451]) {
    const rows = await renderRows(count);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length < 30).toBe(true);
    expect(rows[0]).toBe('skill-1');
  }
});

test('keeps the page where the user scrolled it when a long list replaces a short one', async () => {
  await renderRows(VIRTUAL_CATALOG_MIN_ROWS - 1);
  scroller.scrollTop = 250;

  await renderRows(VIRTUAL_CATALOG_MIN_ROWS + 1);

  expect(scroller.scrollTop).toBe(250);
});

test('goes back to plain rows when a long list shrinks under the threshold', async () => {
  await renderRows(8451);
  const rows = await renderRows(VIRTUAL_CATALOG_MIN_ROWS - 1);

  expect(rows).toHaveLength(VIRTUAL_CATALOG_MIN_ROWS - 1);
});
