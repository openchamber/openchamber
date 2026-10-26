import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { cloneSelectionContent } from './selectionRange';

const dom = new Window();
const originalDocument = globalThis.document;
Object.assign(globalThis, { document: dom.document });
afterAll(() => {
  Object.assign(globalThis, { document: originalDocument });
  return dom.happyDOM.close();
});

test('source coverage survives every text and element boundary in nested code owners', () => {
  const doc = document;
  const root = doc.createElement('div');
  root.innerHTML = 'before<!--edge--><section id="outer" data-oc-code-source="outer"><div id="inner" data-oc-code-source="inner"><span>ab</span><span></span><span>cd</span></div></section><p>between</p><div id="last" data-oc-code-source="last"><span>ef</span></div>after';
  doc.body.append(root);
  const originalHTML = root.innerHTML;
  const positions: Array<{ node: Node; offset: number }> = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3 || node.nodeType === 8) {
      for (let offset = 0; offset <= (node.textContent?.length ?? 0); offset += 1) positions.push({ node, offset });
      return;
    }
    positions.push({ node, offset: 0 });
    Array.from(node.childNodes).forEach((child, index) => {
      visit(child);
      positions.push({ node, offset: index + 1 });
    });
  };
  visit(root);
  for (let start = 0; start < positions.length; start += 1) {
    for (let end = start; end < positions.length; end += 1) {
      const range = doc.createRange();
      range.setStart(positions[start].node, positions[start].offset);
      range.setEnd(positions[end].node, positions[end].offset);
      const native = range.cloneContents();
      // Test-only IDs provide an independent correspondence oracle. Production
      // has neither IDs nor an original-tree query to pair cloned elements.
      const expected = Array.from(native.querySelectorAll('[data-oc-code-source]')).map((clone) => {
        const original = doc.getElementById(clone.id);
        if (!original) throw new Error('Missing original owner');
        const full = doc.createRange();
        full.selectNodeContents(original);
        const complete = range.compareBoundaryPoints(0, full) <= 0 && range.compareBoundaryPoints(2, full) >= 0;
        return { id: clone.id, source: complete ? original.getAttribute('data-oc-code-source') : null };
      });
      const copy = cloneSelectionContent(range);
      expect(copy.textContent).toBe(native.textContent);
      expect(Array.from(copy.querySelectorAll('[id]'), (clone) => ({ id: clone.id, source: clone.getAttribute('data-oc-code-source') }))).toEqual(expected);
    }
  }
  expect(root.innerHTML).toBe(originalHTML);
  root.remove();
});
