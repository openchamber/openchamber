import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

type PdfViewport = { width: number; height: number };

export type PdfPage = {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: { canvas: HTMLCanvasElement | null; viewport: PdfViewport }): { promise: Promise<void>; cancel(): void };
};

export type PdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
};

export type OpenedPdf = {
  promise: Promise<PdfDocument>;
  destroy: () => Promise<void>;
};

export const openPdf = (url: string): OpenedPdf => {
  const task = getDocument({ url, disableRange: true });
  return { promise: task.promise, destroy: () => task.destroy() };
};
