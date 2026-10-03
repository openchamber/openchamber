import React from 'react';
import { flushSync } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactDimensions, formatArtifactSize } from './artifactMeta';
import {
  IMAGE_VIEWPORT_PADDING,
  clampImageScale,
  fitImageScale,
  stepImageScale,
  wheelZoomFactor,
} from './imageZoom';

type Size = { width: number; height: number };

/** An image point that must stay under a screen point once a zoom renders. */
type ZoomAnchor = { imageX: number; imageY: number; clientX: number; clientY: number };

type DragState = { pointerId: number; x: number; y: number; left: number; top: number };

type TouchPinch = { distance: number; scale: number };

const touchDistance = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/**
 * An image the way a designer looks at one: whole first, then closer. Fit never
 * upscales, so a small icon stays its real size instead of blurring across the
 * panel. Zoom follows the pointer: Ctrl/⌘ + wheel or a trackpad pinch
 * (Chromium, Firefox), WebKit gesture events (Safari), a two-finger touch pinch,
 * the − and + steps, or a double-click between fit and 1:1. A zoomed image
 * larger than the viewer pans by dragging.
 */
export const ImageArtifact: React.FC<{
  src: string;
  name: string;
  sizeBytes: number | null;
}> = ({ src, name, sizeBytes }) => {
  const { t } = useI18n();
  // null is fit: the scale then follows the viewer's size.
  const [scale, setScale] = React.useState<number | null>(null);
  const [natural, setNatural] = React.useState<Size | null>(null);
  const [viewport, setViewport] = React.useState<Size | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const anchorRef = React.useRef<ZoomAnchor | null>(null);
  const dragRef = React.useRef<DragState | null>(null);

  React.useEffect(() => {
    setNatural(null);
    setScale(null);
  }, [src]);

  React.useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitScale = natural && viewport ? fitImageScale(natural, viewport) : 1;
  const shownScale = scale ?? fitScale;
  const canPan = scale !== null && natural !== null && viewport !== null && (
    natural.width * scale + IMAGE_VIEWPORT_PADDING * 2 > viewport.width
    || natural.height * scale + IMAGE_VIEWPORT_PADDING * 2 > viewport.height
  );

  // Zooms so the image point under (clientX, clientY) stays there. The render
  // is flushed at once so the next wheel or pinch event measures the new size.
  const zoomTo = (nextScale: number, clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image || !natural) return;
    const rect = image.getBoundingClientRect();
    const rendered = image.clientWidth / natural.width;
    if (rendered <= 0) return;
    anchorRef.current = {
      imageX: (clientX - rect.left - image.clientLeft) / rendered,
      imageY: (clientY - rect.top - image.clientTop) / rendered,
      clientX,
      clientY,
    };
    flushSync(() => setScale(clampImageScale(nextScale, fitScale)));
  };

  const zoomAtCenter = (nextScale: number) => {
    const element = viewportRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    zoomTo(nextScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const element = viewportRef.current;
    const image = imageRef.current;
    anchorRef.current = null;
    if (!anchor || !element || !image || scale === null || image.naturalWidth <= 0) return;
    const rect = image.getBoundingClientRect();
    const rendered = image.clientWidth / image.naturalWidth;
    element.scrollLeft += rect.left + image.clientLeft + anchor.imageX * rendered - anchor.clientX;
    element.scrollTop += rect.top + image.clientTop + anchor.imageY * rendered - anchor.clientY;
  }, [scale]);

  // Native listeners: React's wheel and touch listeners are passive and could
  // not stop the page from zooming or scrolling instead of the image.
  const gestureHandlersRef = React.useRef({ zoomTo, shownScale });
  gestureHandlersRef.current = { zoomTo, shownScale };
  React.useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let touchCount = 0;
    let touchPinch: TouchPinch | null = null;
    let gestureBase: number | null = null;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const handlers = gestureHandlersRef.current;
      handlers.zoomTo(handlers.shownScale * wheelZoomFactor(event.deltaY, event.deltaMode), event.clientX, event.clientY);
    };
    const onTouchStart = (event: TouchEvent) => {
      touchCount = event.touches.length;
      if (event.touches.length !== 2) return;
      touchPinch = {
        distance: touchDistance(event.touches[0], event.touches[1]),
        scale: gestureHandlersRef.current.shownScale,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!touchPinch || event.touches.length !== 2 || touchPinch.distance <= 0) return;
      event.preventDefault();
      const [first, second] = [event.touches[0], event.touches[1]];
      gestureHandlersRef.current.zoomTo(
        touchPinch.scale * (touchDistance(first, second) / touchPinch.distance),
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2,
      );
    };
    const onTouchEnd = (event: TouchEvent) => {
      touchCount = event.touches.length;
      if (event.touches.length < 2) touchPinch = null;
    };
    // iOS sends gesture events alongside the touch pinch above; only a
    // trackpad pinch in Safari, with no finger on the screen, zooms here.
    const onGestureStart = (event: GestureEvent) => {
      event.preventDefault();
      gestureBase = touchCount > 0 ? null : gestureHandlersRef.current.shownScale;
    };
    const onGestureChange = (event: GestureEvent) => {
      event.preventDefault();
      if (gestureBase === null) return;
      gestureHandlersRef.current.zoomTo(gestureBase * event.scale, event.clientX, event.clientY);
    };
    const onGestureEnd = (event: GestureEvent) => {
      event.preventDefault();
      gestureBase = null;
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd, { passive: true });
    element.addEventListener('touchcancel', onTouchEnd, { passive: true });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    element.addEventListener('gestureend', onGestureEnd);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
      element.removeEventListener('gestureend', onGestureEnd);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canPan || event.pointerType !== 'mouse' || event.button !== 0) return;
    const element = event.currentTarget;
    // A press on the viewer's own scrollbar keeps scrolling the native way.
    const bounds = element.getBoundingClientRect();
    if (event.clientX - bounds.left >= element.clientWidth || event.clientY - bounds.top >= element.clientHeight) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
    };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
    event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (scale === null) {
      zoomTo(1, event.clientX, event.clientY);
      return;
    }
    setScale(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[formatArtifactDimensions(natural), formatArtifactSize(sizeBytes)]}
        actions={(
          <>
            <Button
              variant="ghost"
              size="xs"
              aria-label={t('filesView.artifact.image.zoomOut')}
              title={t('filesView.artifact.image.zoomOut')}
              disabled={!natural}
              onClick={() => zoomAtCenter(stepImageScale(shownScale, -1))}
            >
              <Icon name="subtract" className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="min-w-11 tabular-nums"
              title={t('filesView.artifact.image.actualTitle')}
              disabled={!natural}
              onClick={() => zoomAtCenter(1)}
            >
              {`${Math.round(shownScale * 100)}%`}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-label={t('filesView.artifact.image.zoomIn')}
              title={t('filesView.artifact.image.zoomIn')}
              disabled={!natural}
              onClick={() => zoomAtCenter(stepImageScale(shownScale, 1))}
            >
              <Icon name="add" className="size-3.5" />
            </Button>
            <Button
              variant="chip"
              size="xs"
              aria-pressed={scale === null}
              title={t('filesView.artifact.image.fitTitle')}
              onClick={() => setScale(null)}
            >
              {t('filesView.artifact.image.fit')}
            </Button>
          </>
        )}
      />
      <div
        ref={viewportRef}
        className={cn(
          'min-h-0 flex-1 overflow-auto',
          canPan && (dragging ? 'cursor-grabbing' : 'cursor-grab'),
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={handleDoubleClick}
      >
        <div
          className={cn(
            'flex items-center justify-center p-3',
            scale === null ? 'h-full w-full' : 'min-h-full min-w-full w-max',
          )}
        >
          <img
            ref={imageRef}
            key={src}
            src={src}
            alt={name}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget;
              setNatural({ width: image.naturalWidth, height: image.naturalHeight });
            }}
            style={scale !== null && natural
              ? { width: natural.width * scale, height: natural.height * scale }
              : undefined}
            className={cn(
              'select-none rounded-md border border-border/30 bg-primary/10',
              scale === null ? 'max-h-full max-w-full object-contain' : 'max-w-none shrink-0',
            )}
          />
        </div>
      </div>
    </div>
  );
};
