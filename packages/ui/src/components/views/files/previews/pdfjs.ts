// Loaded only when a PDF opens where the runtime has no PDF viewer of its own,
// so pdf.js and its worker cost nothing until then. The legacy build carries
// polyfills the modern one leaves out (`Map.prototype.getOrInsertComputed`),
// which Android WebViews that are a few versions behind do not have.
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
// Bundled with the app: a CDN would break offline use and the VS Code CSP.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

type PdfViewport = { width: number; height: number };

/** What the viewer uses of a pdf.js page. */
export type PdfPage = {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvas: HTMLCanvasElement | null; viewport: PdfViewport }): { promise: Promise<void>; cancel(): void };
};

/** What the viewer uses of a pdf.js document. */
export type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

export type OpenedPdf = {
  promise: Promise<PdfDocument>;
  /** Stops the load and frees the document and its worker. */
  destroy: () => Promise<void>;
};

export const openPdf = (url: string): OpenedPdf => {
  // One plain GET: a Range request carries a header the server's CORS list
  // does not allow, and the Android app is a cross-origin client.
  const task = getDocument({ url, disableRange: true });
  return { promise: task.promise, destroy: () => task.destroy() };
};
