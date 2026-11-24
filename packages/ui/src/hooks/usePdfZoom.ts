import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { wheelZoomFactor } from '@/components/views/files/previews/imageZoom';
import {
  PDF_PAGE_GAP_PX,
  anchorScrollDelta,
  clampPdfZoom,
  pageAtY,
  pageCssWidth,
  pdfZoomCeiling,
} from '@/components/views/files/previews/pdfZoom';

type PageSize = { width: number; height: number };
type ZoomAnchor = { page: HTMLElement; x: number; y: number; clientX: number; clientY: number; width: number };
type TouchPinch = { distance: number; zoom: number };

const touchDistance = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

export const usePdfZoom = (
  scroller: HTMLElement | null,
  sizes: ReadonlyArray<PageSize> | null,
  fitWidth: number,
) => {
  const [zoom, setZoom] = useState(1);
  const anchorRef = useRef<ZoomAnchor | null>(null);

  const referenceWidth = pageCssWidth(sizes?.[0]?.width ?? 0);
  const ceiling = pdfZoomCeiling(referenceWidth, fitWidth);
  const shownZoom = clampPdfZoom(zoom, ceiling);
  const pageWidth = fitWidth * shownZoom;

  const zoomRef = useRef(shownZoom);
  zoomRef.current = shownZoom;

  const zoomAt = (nextZoom: number, clientX: number, clientY: number) => {
    if (!scroller || !sizes || fitWidth <= 0) return;
    const clamped = clampPdfZoom(nextZoom, ceiling);
    if (clamped === shownZoom) return;
    const rect = scroller.getBoundingClientRect();
    const point = pageAtY(sizes, pageWidth, scroller.scrollTop + (clientY - rect.top) - PDF_PAGE_GAP_PX);
    if (!point) return;
    const page = scroller.querySelector<HTMLElement>(`[data-pdf-page="${point.index}"]`);
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    anchorRef.current = {
      page,
      x: clientX - pageRect.left,
      y: clientY - pageRect.top,
      clientX,
      clientY,
      width: pageWidth,
    };
    flushSync(() => setZoom(clamped));
  };

  const zoomAtCenter = (nextZoom: number) => {
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    zoomAt(nextZoom, rect.left + scroller.clientWidth / 2, rect.top + scroller.clientHeight / 2);
  };

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor || !scroller) return;
    const rect = anchor.page.getBoundingClientRect();
    const delta = anchorScrollDelta({
      pageLeft: rect.left,
      pageTop: rect.top,
      x: anchor.x,
      y: anchor.y,
      clientX: anchor.clientX,
      clientY: anchor.clientY,
      width: anchor.width,
    }, pageWidth);
    scroller.scrollLeft += delta.left;
    scroller.scrollTop += delta.top;
  }, [pageWidth, scroller]);

  const gestureRef = useRef({ zoomAt });
  gestureRef.current = { zoomAt };
  useEffect(() => {
    const element = scroller;
    if (!element) return;
    let pinch: TouchPinch | null = null;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      gestureRef.current.zoomAt(
        zoomRef.current * wheelZoomFactor(event.deltaY, event.deltaMode),
        event.clientX,
        event.clientY,
      );
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinch = null;
        return;
      }
      pinch = {
        distance: touchDistance(event.touches[0], event.touches[1]),
        zoom: zoomRef.current,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2 || pinch.distance <= 0) return;
      event.preventDefault();
      const [first, second] = [event.touches[0], event.touches[1]];
      gestureRef.current.zoomAt(
        pinch.zoom * (touchDistance(first, second) / pinch.distance),
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2,
      );
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [scroller]);

  return { zoom: shownZoom, pageWidth, referenceWidth, ceiling, zoomAtCenter };
};
