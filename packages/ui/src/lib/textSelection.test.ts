import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { hasTextSelectionInside } from './textSelection';

const withDomWindow = (run: () => void) => {
  const dom = new Window();
  Object.assign(globalThis, { window: dom, document: dom.document });
  try {
    run();
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  }
};

const selectNode = (node: Node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

describe('hasTextSelectionInside', () => {
  test('is false without a container or a document', () => {
    expect(hasTextSelectionInside(null)).toBe(false);
    expect(hasTextSelectionInside(undefined)).toBe(false);
    expect(hasTextSelectionInside({ contains: () => false })).toBe(false);
  });

  test('is false for a collapsed selection', () => {
    withDomWindow(() => {
      const container = document.createElement('div');
      const text = document.createElement('span');
      text.textContent = 'src/index.ts';
      container.append(text);
      document.body.append(container);

      window.getSelection()?.collapse(text, 0);

      expect(hasTextSelectionInside(container)).toBe(false);
    });
  });

  test('is true when either selection endpoint is inside the container', () => {
    withDomWindow(() => {
      const container = document.createElement('div');
      const inside = document.createElement('span');
      inside.textContent = 'inside';
      container.append(inside);
      const outside = document.createElement('span');
      outside.textContent = 'outside';
      document.body.append(container, outside);

      const range = document.createRange();
      range.setStart(inside, 0);
      range.setEnd(outside, 1);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      expect(hasTextSelectionInside(container)).toBe(true);

      const outsideBefore = document.createElement('span');
      outsideBefore.textContent = 'before';
      document.body.prepend(outsideBefore);
      const reverse = document.createRange();
      reverse.setStart(outsideBefore, 0);
      reverse.setEnd(inside, 1);
      selection?.removeAllRanges();
      selection?.addRange(reverse);
      expect(hasTextSelectionInside(container)).toBe(true);
    });
  });

  test('is false when the selection sits outside the container', () => {
    withDomWindow(() => {
      const container = document.createElement('div');
      const elsewhere = document.createElement('span');
      elsewhere.textContent = 'elsewhere';
      document.body.append(container, elsewhere);
      selectNode(elsewhere);

      expect(hasTextSelectionInside(container)).toBe(false);
    });
  });
});
