import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import type { OpenedPdf, PdfDocument, PdfPage } from './pdfjs';

type OpenPdf = (url: string) => Promise<OpenedPdf>;

const openWithPdfJs: OpenPdf = async (url) => (await import('./pdfjs')).openPdf(url);

/**
 * Whether the runtime shows a PDF in a frame by itself. Desktop browsers, the
 * desktop app and Safari do; the Android WebView and Android Chrome report
 * `false` and paint an empty frame. A runtime that does not say keeps the frame.
 */
const hasBuiltInPdfViewer = (): boolean => navigator.pdfViewerEnabled !== false;

const PAGE_GAP_PX = 8;

// pdf.js names the errors that come from the file itself; anything else (a
// dropped connection, an expired token) is a failed read, not a bad PDF.
const UNREADABLE_PDF_ERRORS = new Set(['InvalidPDFException', 'PasswordException']);

type PageSize = { width: number; height: number };

/**
 * One page: a box with the page's proportions at the pane width, painted only
 * while it is within a screen of the visible part. A page that leaves that
 * range drops its pixels, so a long document holds a few canvases at a time.
 */
const PdfPageCanvas: React.FC<{
  doc: PdfDocument;
  pageNumber: number;
  size: PageSize;
  width: number;
  scroller: HTMLElement | null;
  label: string;
}> = ({ doc, pageNumber, size, width, scroller, label }) => {
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = React.useState(false);

  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || !scroller) return;
    const observer = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: scroller, rootMargin: '100% 0px' },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [scroller]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near || width <= 0) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    let cancelled = false;
    let task: ReturnType<PdfPage['render']> | null = null;
    void doc.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / size.width) * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      task = page.render({ canvas, viewport });
      task.promise.catch(() => {});
    }).catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, near, width, size.width]);

  return (
    <div
      ref={boxRef}
      className="shrink-0 bg-white"
      style={{ width, height: Math.round((width * size.height) / size.width) }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="block h-full w-full" />
    </div>
  );
};

/** Pages drawn by pdf.js, for runtimes without a PDF viewer. Fits the pane width and scrolls down. */
const PdfPages: React.FC<{
  src: string;
  name: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
  openPdf: OpenPdf;
}> = ({ src, name, sizeBytes, download, openPdf }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<
    | { status: 'loading' }
    | { status: 'failed'; unreadable: boolean }
    | { status: 'ready'; doc: PdfDocument; sizes: PageSize[] }
  >({ status: 'loading' });
  const [scroller, setScroller] = React.useState<HTMLElement | null>(null);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    if (!src) return;
    let cancelled = false;
    let opened: OpenedPdf | null = null;
    setState({ status: 'loading' });
    void (async () => {
      try {
        opened = await openPdf(src);
        if (cancelled) {
          void opened.destroy();
          return;
        }
        const doc = await opened.promise;
        const pageNumbers = Array.from({ length: doc.numPages }, (_, index) => index + 1);
        const sizes = await Promise.all(pageNumbers.map(async (number): Promise<PageSize> => {
          const viewport = (await doc.getPage(number)).getViewport({ scale: 1 });
          return { width: viewport.width, height: viewport.height };
        }));
        if (!cancelled) setState({ status: 'ready', doc, sizes });
      } catch (error) {
        if (!cancelled) setState({ status: 'failed', unreadable: error instanceof Error && UNREADABLE_PDF_ERRORS.has(error.name) });
      }
    })();
    return () => {
      cancelled = true;
      void opened?.destroy();
    };
  }, [src, openPdf]);

  React.useEffect(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(0, scroller.clientWidth - PAGE_GAP_PX * 2)));
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  const pageCount = state.status === 'ready' ? state.sizes.length : null;
  const pages = pageCount === null
    ? ''
    : t(pageCount === 1 ? 'filesView.artifact.pdf.pagesSingle' : 'filesView.artifact.pdf.pagesPlural', { pages: pageCount });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[pages, formatArtifactSize(sizeBytes)]} />
      {state.status === 'failed' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="max-w-md typography-ui text-muted-foreground">{t(state.unreadable ? 'filesView.artifact.pdf.loadFailed' : 'filesView.error.readFileFailed')}</div>
          {download}
        </div>
      ) : state.status === 'loading' ? (
        <div className="flex items-center gap-2 p-3 typography-ui text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : (
        <ScrollableOverlay
          ref={setScroller}
          outerClassName="min-h-0 flex-1 bg-[var(--surface-background)]"
          style={{ padding: PAGE_GAP_PX }}
          disableHorizontal
        >
          <div className="flex flex-col items-center" style={{ gap: PAGE_GAP_PX }}>
            {width > 0 && state.sizes.map((size, index) => (
              <PdfPageCanvas
                key={index}
                doc={state.doc}
                pageNumber={index + 1}
                size={size}
                width={width}
                scroller={scroller}
                label={t('filesView.artifact.pdf.pageLabel', { page: index + 1, name })}
              />
            ))}
          </div>
        </ScrollableOverlay>
      )}
    </div>
  );
};

/**
 * A PDF in the viewer. Where the runtime has a PDF viewer, the file opens in
 * a frame as before; elsewhere pdf.js draws the pages.
 */
export const PdfArtifact: React.FC<{
  src: string;
  name: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
  /** Replaced in tests; loads pdf.js on first use. */
  openPdf?: OpenPdf;
}> = ({ src, name, sizeBytes, download, openPdf = openWithPdfJs }) => {
  if (hasBuiltInPdfViewer()) {
    return (
      <div className="h-full overflow-hidden bg-[var(--surface-background)]">
        <iframe src={src} className="h-full w-full border-0" title={name} />
      </div>
    );
  }
  return <PdfPages src={src} name={name} sizeBytes={sizeBytes} download={download} openPdf={openPdf} />;
};
