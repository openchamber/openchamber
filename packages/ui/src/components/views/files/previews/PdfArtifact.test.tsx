import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
});
// React DOM and the i18n store read the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { PdfArtifact } = await import('./PdfArtifact');
type OpenedPdf = import('./pdfjs').OpenedPdf;
type PdfDocument = import('./pdfjs').PdfDocument;

const SRC = 'http://h/api/fs/raw?path=%2Frepo%2Fbook.pdf&oc_url_token=t';

let reactRoot: Root | null = null;
let container: HTMLElement | null = null;

const setPdfViewer = (enabled: boolean | undefined) => {
  Object.defineProperty(browser.navigator, 'pdfViewerEnabled', { configurable: true, get: () => enabled });
};

const fakeDocument = (pages: number): PdfDocument => ({
  numPages: pages,
  getPage: async () => ({
    getViewport: () => ({ width: 612, height: 792 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  }),
});

const render = async (openPdf: (url: string) => Promise<OpenedPdf>) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(
    <I18nProvider>
      <PdfArtifact src={SRC} name="book.pdf" sizeBytes={2048} download={<button type="button">Download</button>} openPdf={openPdf} />
    </I18nProvider>,
  ));
};

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  container?.remove();
  reactRoot = null;
  container = null;
});

describe('PdfArtifact', () => {
  test('a runtime without a PDF viewer gets the pages from pdf.js, not an empty frame', async () => {
    setPdfViewer(false);
    const opened: string[] = [];
    let destroyed = 0;
    await render(async (url) => {
      opened.push(url);
      return { promise: Promise.resolve(fakeDocument(3)), destroy: async () => { destroyed += 1; } };
    });
    expect(container?.querySelector('iframe')).toBeNull();
    expect(opened).toEqual([SRC]);
    expect(container?.textContent).toContain('3 pages');
    expect(container?.textContent).toContain('2.0 KB');

    await act(async () => reactRoot?.unmount());
    reactRoot = null;
    expect(destroyed).toBe(1);
  });

  test('a PDF pdf.js cannot read says so and offers the download', async () => {
    setPdfViewer(false);
    const invalid = new Error('Invalid PDF structure.');
    invalid.name = 'InvalidPDFException';
    await render(async () => ({ promise: Promise.reject(invalid), destroy: async () => {} }));
    expect(container?.textContent).toContain('This PDF cannot be shown here');
    expect(container?.querySelector('button')?.textContent).toBe('Download');
  });

  test('a read that fails is not blamed on the PDF', async () => {
    setPdfViewer(false);
    const response = new Error('Unexpected server response (401).');
    response.name = 'ResponseException';
    await render(async () => ({ promise: Promise.reject(response), destroy: async () => {} }));
    expect(container?.textContent).toContain('Failed to read file');
    expect(container?.textContent).not.toContain('This PDF cannot be shown here');
  });

  test('a runtime with a PDF viewer keeps the frame and never loads pdf.js', async () => {
    setPdfViewer(true);
    let calls = 0;
    await render(async () => {
      calls += 1;
      throw new Error('not expected');
    });
    expect(container?.querySelector('iframe')?.getAttribute('src')).toBe(SRC);
    expect(calls).toBe(0);
  });

  test('a runtime that does not say whether it has a PDF viewer keeps the frame', async () => {
    setPdfViewer(undefined);
    await render(async () => {
      throw new Error('not expected');
    });
    expect(container?.querySelector('iframe')?.getAttribute('src')).toBe(SRC);
  });
});
