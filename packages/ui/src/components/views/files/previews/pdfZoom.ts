export const PDF_PAGE_GAP_PX = 8;

const MIN_FIT_ZOOM = 1;
const MAX_FIT_ZOOM = 6;
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];
const PDF_POINT_TO_CSS_PX = 96 / 72;
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_SIDE = 8192;

type PageSize = { width: number; height: number };

type PdfZoomAnchor = {
  pageLeft: number;
  pageTop: number;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  width: number;
};

export const anchorScrollDelta = (anchor: PdfZoomAnchor, width: number) => {
  const ratio = anchor.width > 0 ? width / anchor.width : 1;
  return {
    left: anchor.pageLeft + anchor.x * ratio - anchor.clientX,
    top: anchor.pageTop + anchor.y * ratio - anchor.clientY,
  };
};

export const fitPageWidth = (viewportWidth: number): number => (
  Math.max(0, viewportWidth - PDF_PAGE_GAP_PX * 2)
);

export const pageCssWidth = (pointWidth: number): number => pointWidth * PDF_POINT_TO_CSS_PX;

export const pageDisplayHeight = (size: PageSize, width: number): number => (
  size.width > 0 ? Math.round((width * size.height) / size.width) : 0
);

export const pdfZoomCeiling = (actualWidth: number, fitWidth: number): number => (
  Math.max(MAX_FIT_ZOOM, actualWidth > 0 && fitWidth > 0 ? actualWidth / fitWidth : 0)
);

export const clampPdfZoom = (zoom: number, ceiling: number): number => (
  Math.min(Math.max(MIN_FIT_ZOOM, zoom), Math.max(MIN_FIT_ZOOM, ceiling))
);

export const stepPdfZoom = (zoom: number, direction: 1 | -1, ceiling: number): number => {
  const next = direction === 1
    ? ZOOM_STEPS.find((step) => step > zoom * 1.001) ?? ceiling
    : [...ZOOM_STEPS].reverse().find((step) => step < zoom * 0.999) ?? MIN_FIT_ZOOM;
  return clampPdfZoom(next, ceiling);
};

export const pageAtY = (
  sizes: ReadonlyArray<PageSize>,
  width: number,
  y: number,
): { index: number; localY: number } | null => {
  if (sizes.length === 0) return null;
  if (y < 0) return { index: 0, localY: 0 };
  let top = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const height = pageDisplayHeight(sizes[index], width);
    if (y < top + height) return { index, localY: Math.max(0, y - top) };
    top += height + PDF_PAGE_GAP_PX;
  }
  const last = sizes.length - 1;
  return { index: last, localY: pageDisplayHeight(sizes[last], width) };
};

export const pageRenderScale = (
  cssWidth: number,
  size: PageSize,
  devicePixelRatio: number,
): number => {
  if (cssWidth <= 0 || size.width <= 0 || size.height <= 0) return 1;
  const pixelWidth = cssWidth * devicePixelRatio;
  const pixelHeight = pixelWidth * (size.height / size.width);
  const pixels = pixelWidth * pixelHeight;
  const pixelCap = pixels > MAX_CANVAS_PIXELS ? Math.sqrt(MAX_CANVAS_PIXELS / pixels) : 1;
  const longestSide = Math.max(pixelWidth, pixelHeight);
  const sideCap = longestSide > MAX_CANVAS_SIDE ? MAX_CANVAS_SIDE / longestSide : 1;
  return (cssWidth / size.width) * devicePixelRatio * Math.min(pixelCap, sideCap);
};
