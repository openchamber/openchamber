import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { measureGitPanelMinimumWidth } from './gitPanelMinimumWidth';

test('measures the compact toolbar and card chrome independently of the animated aside', async () => {
  const dom = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    document: dom.document,
    HTMLElement: dom.HTMLElement,
    getComputedStyle: dom.getComputedStyle.bind(dom),
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 263 });
  const aside = document.createElement('aside');
  const card = document.createElement('div');
  card.setAttribute('data-zone-card', '');
  card.style.marginInlineStart = '8px';
  card.style.marginInlineEnd = '6px';
  const header = document.createElement('header');
  const slot = document.createElement('div');
  const toolbar = document.createElement('div');
  const row = document.createElement('div');
  Object.defineProperty(aside, 'getBoundingClientRect', { value: () => new dom.DOMRect(0, 0, 0, 40) });
  Object.defineProperty(card, 'getBoundingClientRect', { value: () => new dom.DOMRect(0, 0, 306, 40) });
  Object.defineProperty(toolbar, 'getBoundingClientRect', { value: () => new dom.DOMRect(0, 0, 228, 40) });
  row.style.paddingInlineEnd = '4px';
  toolbar.append(row);
  slot.append(toolbar);
  header.append(slot);
  card.append(header);
  aside.append(card);
  document.body.append(aside);
  const before = header.outerHTML;

  try {
    expect(measureGitPanelMinimumWidth(toolbar)).toBe(359);
    expect(header.outerHTML).toBe(before);
    expect(header.children.length).toBe(1);
    expect(measureGitPanelMinimumWidth(document.createElement('div'))).toBe(0);
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
