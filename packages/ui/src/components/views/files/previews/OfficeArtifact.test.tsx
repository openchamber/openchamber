import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { OfficePreview } from './officeDocument';
import type { WorkbookDocument } from './workbook/model';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});

// React DOM and the i18n store read the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { OfficeArtifact } = await import('./OfficeArtifact');

const bytes = new Uint8Array([1, 2, 3]);
let root: Root | null = null;

const render = async (element: React.ReactElement) => {
  const container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<I18nProvider>{element}</I18nProvider>);
  });
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('OfficeArtifact', () => {
  test('a page goes into a frame that cannot reach the app', async () => {
    const preview: OfficePreview = { kind: 'page', html: '<p>Deck</p>', slideCount: 3 };
    const container = await render(
      <OfficeArtifact name="deck.pptx" path="/deck.pptx" sizeBytes={2048} loadBytes={async () => bytes} readPreview={async () => preview} />,
    );
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('srcdoc')).toBe('<p>Deck</p>');
    expect(container.textContent).toContain('3 slides');
  });

  test('a workbook shows column letters, row numbers and its own column count', async () => {
    const document: WorkbookDocument = {
      sheets: [{
        name: 'Data',
        locked: new Set(),
        protected: false,
        cells: new Map([
          ['1:0', { row: 1, column: 0, kind: 'number', raw: '1', display: '1' }],
          ['3:1', { row: 3, column: 1, kind: 'text', raw: 'b', display: 'b' }],
        ]),
      }],
      definedNames: [],
      date1904: false,
      write: async () => bytes,
    };
    const preview: OfficePreview = { kind: 'workbook', document, bytes };
    const container = await render(
      <OfficeArtifact name="book.xlsx" path="/book.xlsx" sizeBytes={null} loadBytes={async () => bytes} readPreview={async () => preview} />,
    );
    expect(Array.from(container.querySelectorAll('th')).map((cell) => cell.textContent)).toEqual(['', 'A', 'B']);
    expect(container.textContent).toContain('3 rows · 2 columns');
  });

  test('a file that cannot be parsed says so and keeps its actions', async () => {
    const container = await render(
      <OfficeArtifact
        name="locked.docx"
        path="/locked.docx"
        sizeBytes={null}
        loadBytes={async () => bytes}
        readPreview={async () => { throw new Error('not a zip'); }}
        actions={<button type="button">Save file</button>}
      />,
    );
    expect(container.textContent).toContain('damaged or protected with a password');
    expect(container.textContent).toContain('Save file');
  });

  test('a failed read offers Retry and reads again', async () => {
    let reads = 0;
    const preview: OfficePreview = { kind: 'page', html: '<p>Doc</p>', slideCount: null };
    const container = await render(
      <OfficeArtifact
        name="doc.docx"
        path="/doc.docx"
        sizeBytes={null}
        loadBytes={async () => {
          reads += 1;
          if (reads === 1) throw new Error('offline');
          return bytes;
        }}
        readPreview={async () => preview}
      />,
    );
    expect(container.textContent).toContain('Couldn\'t read doc.docx');
    await act(async () => {
      container.querySelector('button')?.click();
    });
    expect(reads).toBe(2);
    expect(container.querySelector('iframe')).not.toBeNull();
  });
});
