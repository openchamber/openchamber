import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { usePdfZoom } from '@/hooks/usePdfZoom';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import {
  PDF_PAGE_GAP_PX,
  clampPdfZoom,
  fitPageWidth,
  pageDisplayHeight,
  pageRenderScale,
  stepPdfZoom,
} from './pdfZoom';
import type { OpenedPdf, PdfDocument, PdfPage } from './pdfjs';

type OpenPdf = (url: string) => Promise<OpenedPdf>;

const openWithPdfJs: OpenPdf = async (url) => (await import('./pdfjs')).openPdf(url);

// external: #5823 Android WebView and Chrome report no built-in PDF viewer and leave PDF frames empty.
const hasBuiltInPdfViewer = (): boolean => navigator.pdfViewerEnabled !== false;

const UNREADABLE_PDF_ERRORS = new Set(['InvalidPDFException', 'PasswordException']);

type PageSize = { width: number; height: number };

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
    const buffer = document.createElement('canvas');
    void doc.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: pageRenderScale(width, size, ratio) });
      buffer.width = Math.floor(viewport.width);
      buffer.height = Math.floor(viewport.height);
      task = page.render({ canvas: buffer, viewport });
      task.promise.then(() => {
        if (cancelled) return;
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.getContext('2d')?.drawImage(buffer, 0, 0);
      }).catch(() => {});
    }).catch(() => {});
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber, near, width, size]);

  return (
    <div
      ref={boxRef}
      data-pdf-page={pageNumber - 1}
      className="shrink-0 bg-white"
      style={{ width, height: pageDisplayHeight(size, width) }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="block h-full w-full" />
    </div>
  );
};

// external: #6113 a phone fits the page to the screen, so body text is unreadable without zoom.
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
  const [fitWidth, setFitWidth] = React.useState(0);

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
    const measure = () => setFitWidth(fitPageWidth(scroller.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  const sizes = state.status === 'ready' ? state.sizes : null;
  const { zoom, pageWidth, referenceWidth, ceiling, zoomAtCenter } = usePdfZoom(scroller, sizes, fitWidth);

  const pageCount = sizes?.length ?? null;
  const pages = pageCount === null
    ? ''
    : t(pageCount === 1 ? 'filesView.artifact.pdf.pagesSingle' : 'filesView.artifact.pdf.pagesPlural', { pages: pageCount });
  const percent = referenceWidth > 0 && pageWidth > 0 ? (pageWidth / referenceWidth) * 100 : 100;
  const controlsReady = sizes !== null && fitWidth > 0 && referenceWidth > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[pages, formatArtifactSize(sizeBytes)]}
        actions={(
          <>
            <ButtonTooltip side="bottom" label={t('filesView.artifact.pdf.zoomOut')}>
              <Button
                variant="ghost"
                size="xs"
                aria-label={t('filesView.artifact.pdf.zoomOut')}
                disabled={!controlsReady || zoom <= 1}
                onClick={() => zoomAtCenter(stepPdfZoom(zoom, -1, ceiling))}
              >
                <Icon name="subtract" className="size-3.5" />
              </Button>
            </ButtonTooltip>
            <ButtonTooltip side="bottom" label={t('filesView.artifact.pdf.actualTitle')}>
              <Button
                variant="ghost"
                size="xs"
                className="min-w-11 tabular-nums"
                aria-label={t('filesView.artifact.pdf.actualTitle')}
                disabled={!controlsReady || referenceWidth <= fitWidth}
                onClick={() => zoomAtCenter(clampPdfZoom(fitWidth > 0 ? referenceWidth / fitWidth : 1, ceiling))}
              >
                {`${Math.round(percent)}%`}
              </Button>
            </ButtonTooltip>
            <ButtonTooltip side="bottom" label={t('filesView.artifact.pdf.zoomIn')}>
              <Button
                variant="ghost"
                size="xs"
                aria-label={t('filesView.artifact.pdf.zoomIn')}
                disabled={!controlsReady || zoom >= ceiling}
                onClick={() => zoomAtCenter(stepPdfZoom(zoom, 1, ceiling))}
              >
                <Icon name="add" className="size-3.5" />
              </Button>
            </ButtonTooltip>
            <ButtonTooltip side="bottom" label={t('filesView.artifact.pdf.fitTitle')}>
              <Button
                variant="chip"
                size="xs"
                aria-pressed={zoom <= 1}
                aria-label={t('filesView.artifact.pdf.fitTitle')}
                onClick={() => zoomAtCenter(1)}
              >
                {t('filesView.artifact.pdf.fit')}
              </Button>
            </ButtonTooltip>
          </>
        )}
      />
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
          style={{ padding: PDF_PAGE_GAP_PX }}
        >
          <div className="flex flex-col" style={{ gap: PDF_PAGE_GAP_PX, width: pageWidth }}>
            {pageWidth > 0 && state.sizes.map((size, index) => (
              <PdfPageCanvas
                key={index}
                doc={state.doc}
                pageNumber={index + 1}
                size={size}
                width={pageWidth}
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

export const PdfArtifact: React.FC<{
  src: string;
  name: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
  openPdf?: OpenPdf;
}> = ({ src, name, sizeBytes, download, openPdf = openWithPdfJs }) => {
  if (hasBuiltInPdfViewer()) {
    return (
      <div className="h-full overflow-hidden bg-[var(--surface-background)]">
        <iframe src={src} className="h-full w-full border-0" title={name} />
      </div>
    );
  }
  return <PdfPages key={src} src={src} name={name} sizeBytes={sizeBytes} download={download} openPdf={openPdf} />;
};
