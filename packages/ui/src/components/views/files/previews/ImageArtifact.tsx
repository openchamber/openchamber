import React from 'react';
import { flushSync } from 'react-dom';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { isEditableEventTarget } from '@/hooks/keyboard-shortcut-dom';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

type ZoomAnchor = { imageX: number; imageY: number; clientX: number; clientY: number };

type DragState = { pointerId: number; x: number; y: number; left: number; top: number };

type TouchPinch = { distance: number; scale: number };

const touchDistance = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

export type ImageNeighbor = { name: string; open: () => void };

let lastPointerRegion: Element | null = null;

const ARROW_KEY_OWNERS = '[role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [role="radiogroup"], [role="slider"], [role="combobox"], [role="tree"], [role="grid"], [role="toolbar"]';

const NEIGHBOR_BUTTON_CLASS = 'absolute top-1/2 -translate-y-1/2 z-10 h-10 w-10 flex items-center justify-center rounded-full bg-surface-elevated/90 text-surface-elevated-foreground hover:bg-surface-elevated focus:outline-none focus:ring-2 focus:ring-ring';

type ImageArtifactProps = {
  src: string;
  name: string;
  sizeBytes: number | null;
  neighbors?: { previous: ImageNeighbor; next: ImageNeighbor } | null;
  onRetry?: () => void;
  download?: React.ReactNode;
};

const ImageArtifactView: React.FC<ImageArtifactProps> = ({ src, name, sizeBytes, neighbors, onRetry, download }) => {
  const { t, direction } = useI18n();
  const [scale, setScale] = React.useState<number | null>(null);
  const [natural, setNatural] = React.useState<Size | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [viewport, setViewport] = React.useState<Size | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const viewerRef = React.useRef<HTMLDivElement | null>(null);
  const imageRef = React.useRef<HTMLImageElement | null>(null);
  const anchorRef = React.useRef<ZoomAnchor | null>(null);
  const dragRef = React.useRef<DragState | null>(null);

  const retry = () => {
    setFailed(false);
    setAttempt((value) => value + 1);
    onRetry?.();
  };

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

  // external: https://github.com/facebook/react/issues/19651 React wheel and touch listeners are passive, so zoom uses native listeners.
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

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!neighbors || scale !== null || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const previousKey = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const nextKey = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    if (event.key !== previousKey && event.key !== nextKey) return;
    const viewer = viewerRef.current;
    if (!viewer || viewer.getClientRects().length === 0) return;
    const scope = viewer.closest('[data-context-panel]') ?? viewer;
    const target = event.target;
    if (target === document.body) {
      if (!lastPointerRegion || !scope.contains(lastPointerRegion)) return;
    } else {
      if (!(target instanceof Element) || isEditableEventTarget(target) || target.closest(ARROW_KEY_OWNERS)) return;
      if (!scope.contains(target)) return;
    }
    event.preventDefault();
    (event.key === previousKey ? neighbors.previous : neighbors.next).open();
  };
  const keyDownRef = React.useRef(handleKeyDown);
  keyDownRef.current = handleKeyDown;
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyDownRef.current(event);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      lastPointerRegion = target?.closest('[data-context-panel]') ?? target;
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

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
            <ButtonTooltip side="bottom" label={t('filesView.artifact.image.zoomOut')}>
              <Button
                variant="ghost"
                size="xs"
                aria-label={t('filesView.artifact.image.zoomOut')}
                disabled={!natural}
                onClick={() => zoomAtCenter(stepImageScale(shownScale, -1))}
              >
                <Icon name="subtract" className="size-3.5" />
              </Button>
            </ButtonTooltip>
            <ButtonTooltip side="bottom" label={t('filesView.artifact.image.actualTitle')}>
              <Button
                variant="ghost"
                size="xs"
                className="min-w-11 tabular-nums"
                aria-label={t('filesView.artifact.image.actualTitle')}
                disabled={!natural}
                onClick={() => zoomAtCenter(1)}
              >
                {`${Math.round(shownScale * 100)}%`}
              </Button>
            </ButtonTooltip>
            <ButtonTooltip side="bottom" label={t('filesView.artifact.image.zoomIn')}>
              <Button
                variant="ghost"
                size="xs"
                aria-label={t('filesView.artifact.image.zoomIn')}
                disabled={!natural}
                onClick={() => zoomAtCenter(stepImageScale(shownScale, 1))}
              >
                <Icon name="add" className="size-3.5" />
              </Button>
            </ButtonTooltip>
            <ButtonTooltip side="bottom" label={t('filesView.artifact.image.fitTitle')}>
              <Button
                variant="chip"
                size="xs"
                aria-pressed={scale === null}
                aria-label={t('filesView.artifact.image.fitTitle')}
                onClick={() => setScale(null)}
              >
                {t('filesView.artifact.image.fit')}
              </Button>
            </ButtonTooltip>
          </>
        )}
      />
      <div ref={viewerRef} className="relative flex min-h-0 flex-1 flex-col">
        {failed ? (
          <ContentState
            className={neighbors ? 'px-16' : undefined}
            icon={<Icon name="image" className="size-10 text-muted-foreground" />}
            title={t('filesView.artifact.image.loadFailed')}
            description={t('filesView.artifact.image.loadFailedDescription')}
            actions={(
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="outline" size="sm" onClick={retry}>
                      <Icon name="refresh" className="me-2 size-4" />
                      {t('filesView.artifact.state.retry')}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>{t('contextTooltips.files.retryImage')}</TooltipContent>
                </Tooltip>
                {download}
              </>
            )}
          />
        ) : null}
        {!failed && !natural ? (
          <ContentLoadingState label={t('filesView.artifact.state.loading')} className="pointer-events-none absolute inset-0" />
        ) : null}
        <ScrollableOverlay
          ref={viewportRef}
          tabIndex={neighbors ? 0 : undefined}
          outerClassName={cn('min-h-0 flex-1', failed && 'hidden')}
          className={cn(
            'outline-none',
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
            {src ? (
              <img
                ref={imageRef}
                key={`${src}:${attempt}`}
                src={src}
                alt={name}
                draggable={false}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  setNatural({ width: image.naturalWidth, height: image.naturalHeight });
                }}
                onError={() => setFailed(true)}
                style={scale !== null && natural
                  ? { width: natural.width * scale, height: natural.height * scale }
                  : undefined}
                className={cn(
                  'select-none rounded-md border border-edge-muted bg-primary/10',
                  scale === null ? 'max-h-full max-w-full object-contain' : 'max-w-none shrink-0',
                  !natural && 'invisible',
                )}
              />
            ) : null}
          </div>
        </ScrollableOverlay>
        {neighbors ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(NEIGHBOR_BUTTON_CLASS, 'inset-s-3')}
                  aria-label={t('filesView.artifact.image.previous', { name: neighbors.previous.name })}
                  onClick={() => neighbors.previous.open()}
                >
                  <Icon name="arrow-left-s" className="h-6 w-6" />
                </button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{t('filesView.artifact.image.previous', { name: neighbors.previous.name })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(NEIGHBOR_BUTTON_CLASS, 'inset-e-3')}
                  aria-label={t('filesView.artifact.image.next', { name: neighbors.next.name })}
                  onClick={() => neighbors.next.open()}
                >
                  <Icon name="arrow-right-s" className="h-6 w-6" />
                </button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{t('filesView.artifact.image.next', { name: neighbors.next.name })}</TooltipContent>
            </Tooltip>
          </>
        ) : null}
      </div>
    </div>
  );
};

export const ImageArtifact: React.FC<ImageArtifactProps> = (props) => (
  <ImageArtifactView {...props} key={props.src} />
);
