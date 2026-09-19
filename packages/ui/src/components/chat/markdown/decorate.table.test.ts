import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import {
  decorateMarkdown,
  stabilizeMarkdownTableWidths,
  type DecorateContext,
} from './decorate';

const labels: DecorateContext['labels'] = {
  copy: 'Copy',
  copied: 'Copied',
  enableCodeWrap: 'Wrap',
  disableCodeWrap: 'Unwrap',
  copyTable: 'Copy table',
  downloadTable: 'Download table',
  copyDiagram: 'Copy diagram',
  downloadDiagram: 'Download diagram',
  zoomInDiagram: 'Zoom in',
  zoomOutDiagram: 'Zoom out',
  resetDiagramView: 'Reset',
  previewLabel: 'Preview',
  previewTitle: 'Preview',
};

const decorateContext: DecorateContext = {
  labels,
  mermaidControls: { download: false, copy: false, showPanZoomControls: false },
  codeBlockLineWrap: false,
  renderMermaid: () => ({}),
};

const windowInstance = new Window({ url: 'http://localhost/' });
windowInstance.document.write('<!doctype html><html><head></head><body></body></html>');
windowInstance.document.close();

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const installGlobal = (name: string, value: Window[keyof Window]): void => {
  previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

installGlobal('window', windowInstance);
installGlobal('document', windowInstance.document);
installGlobal('navigator', windowInstance.navigator);
installGlobal('HTMLElement', windowInstance.HTMLElement);
installGlobal('Element', windowInstance.Element);
installGlobal('Node', windowInstance.Node);
installGlobal('SVGElement', windowInstance.SVGElement);
installGlobal('HTMLTableElement', windowInstance.HTMLTableElement);
installGlobal('DOMRect', windowInstance.DOMRect);

let probeWidths: Map<string, number> | null = null;
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: function (this: Element): DOMRect {
    if (this.matches('table') && this.closest('[data-md-table-measure]')) {
      const key = (this.textContent ?? '').trim();
      return new windowInstance.DOMRect(0, 0, probeWidths?.get(key) ?? 0, 20);
    }
    return originalGetBoundingClientRect.call(this);
  },
});

afterAll(() => {
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: originalGetBoundingClientRect,
  });
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
});

const decorateAndStabilizeTable = (): HTMLTableElement => {
  const root = document.createElement('div');
  root.innerHTML = [
    '<table>',
    '<thead><tr><th>Widget</th><th>Processing state</th><th>Count</th></tr></thead>',
    '<tbody><tr>',
    '<td>short</td>',
    '<td>processing_completed_successfully</td>',
    '<td>120</td>',
    '</tr></tbody>',
    '</table>',
  ].join('');
  document.body.appendChild(root);
  decorateMarkdown(root, decorateContext);
  stabilizeMarkdownTableWidths(root);
  const table = root.querySelector<HTMLTableElement>('table[data-markdown="table"]');
  if (!table) throw new Error('decorated table missing');
  return table;
};

describe('markdown table decoration layout', () => {
  test('lets columns use natural width and available space instead of a 320px wrap cap', () => {
    probeWidths = new Map([
      ['short', 48],
      ['processing_completed_successfully', 410],
      ['120', 36],
    ]);

    const table = decorateAndStabilizeTable();
    const wrapper = table.closest('[data-markdown="table-wrapper"]');
    const cells = Array.from(table.querySelectorAll('th, td'));
    const columnWidths = Array.from(
      table.querySelectorAll<HTMLTableColElement>('colgroup[data-md-table-columns] col'),
    ).map((column) => column.style.width);

    try {
      expect(table.getAttribute('data-md-table-layout')).toBe('fixed');
      expect(table.style.tableLayout).toBe('fixed');
      expect(columnWidths).toEqual(['120px', '410px', '120px']);
      expect(table.style.width).toBe('100%');
      expect(table.style.minWidth).toBe('650px');
      expect(table.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
      expect(wrapper?.classList.contains('w-full')).toBe(true);
      expect(wrapper?.classList.contains('max-w-full')).toBe(true);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((cell) => cell.classList.contains('min-w-[120px]'))).toBe(true);
      expect(cells.every((cell) => cell.classList.contains('max-w-[320px]'))).toBe(false);
      expect(cells.every((cell) => cell.classList.contains('[overflow-wrap:anywhere]'))).toBe(false);
      expect(cells.every((cell) => cell.classList.contains('break-words'))).toBe(true);
    } finally {
      probeWidths = null;
      table.closest('[data-markdown="table-wrapper"]')?.parentElement?.remove();
    }
  });
});
