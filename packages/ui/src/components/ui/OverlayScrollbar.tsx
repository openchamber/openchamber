import React from "react";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/useUIStore";
import { isRightToLeft } from '@/lib/i18n';

export type OverlayScrollbarProps = {
  containerRef: React.RefObject<HTMLElement | null>;
  minThumbSize?: number;
  hideDelayMs?: number;
  className?: string;
  disableHorizontal?: boolean;
  observeMutations?: boolean;
  suppressVisibility?: boolean;
  userIntentOnly?: boolean;
  verticalTrackStart?: number;
  onThumbDragStart?: () => void;
};

type ScrollbarOptions = Required<Pick<
  OverlayScrollbarProps,
  "minThumbSize" | "hideDelayMs" | "disableHorizontal" | "observeMutations" | "suppressVisibility" | "userIntentOnly" | "verticalTrackStart"
>> & { alwaysVisible: boolean };

const TRACK_INSET = 8;
const USER_INTENT_DURATION_MS = 1000;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

function setHidden(element: HTMLElement, hidden: boolean) {
  if (element.hidden !== hidden) element.hidden = hidden;
}

function setStyle(element: HTMLElement, property: "height" | "width", value: string) {
  if (element.style[property] !== value) element.style[property] = value;
}

function calculateThumb(viewportLength: number, contentLength: number, minThumbSize: number, trackStart = 0) {
  const trackLength = Math.max(viewportLength - TRACK_INSET * 2 - trackStart, 0);
  const scrollRange = Math.max(contentLength - viewportLength, 0);
  if (trackLength === 0 || scrollRange === 0) return null;

  const length = Math.min(
    trackLength,
    Math.max(minThumbSize, (viewportLength / contentLength) * trackLength),
  );
  return {
    length,
    thumbPixelsPerScrollPixel: (trackLength - length) / scrollRange,
  };
}

function bindScrollbar(
  container: HTMLElement,
  root: HTMLDivElement,
  verticalThumb: HTMLDivElement,
  horizontalThumb: HTMLDivElement,
  initialOptions: ScrollbarOptions,
  onThumbDragStart: () => void,
) {
  let options = initialOptions;

  let frameId: number | null = null;
  let needsMeasurement = true;

  let verticalThumbPixelsPerScrollPixel = 0;
  let horizontalThumbPixelsPerScrollPixel = 0;
  let horizontalScrollOrigin = 0;

  let hideTimerId: ReturnType<typeof setTimeout> | null = null;
  let hideDeadlineMs = 0;
  let lastUserIntentTimeMs = Number.NEGATIVE_INFINITY;
  let pointerOverThumb = false;
  let pointerOverContainer = false;

  let drag: {
    axis: "vertical" | "horizontal";
    pointerId: number;
    pointerStartPx: number;
    scrollStartPx: number;
  } | null = null;

  const setVisible = (visible: boolean) => {
    const value = String(visible);
    if (root.dataset.visible !== value) root.dataset.visible = value;
  };

  const scheduleHide = () => {
    if (options.alwaysVisible || pointerOverThumb || pointerOverContainer || drag || hideTimerId !== null) return;

    const hide = () => {
      hideTimerId = null;
      if (options.alwaysVisible || pointerOverThumb || pointerOverContainer || drag) return;
      const delay = hideDeadlineMs - performance.now();
      if (delay > 0) {
        hideTimerId = setTimeout(hide, delay);
      } else {
        setVisible(false);
      }
    };

    hideTimerId = setTimeout(hide, Math.max(hideDeadlineMs - performance.now(), 0));
  };

  const containerStyle = container.ownerDocument.defaultView?.getComputedStyle(container) ?? null;
  const scrolls = (overflow: string | undefined) => !overflow || overflow === "auto" || overflow === "scroll";

  const measureThumbs = () => {
    const scrollsVertically = scrolls(containerStyle?.overflowY);
    const scrollsHorizontally = !options.disableHorizontal && scrolls(containerStyle?.overflowX);
    const clientHeight = scrollsVertically ? container.clientHeight : 0;
    const scrollHeight = scrollsVertically ? container.scrollHeight : 0;
    const clientWidth = scrollsHorizontally ? container.clientWidth : 0;
    const scrollWidth = scrollsHorizontally ? container.scrollWidth : 0;
    const vertical = scrollsVertically
      ? calculateThumb(clientHeight, scrollHeight, options.minThumbSize, options.verticalTrackStart)
      : null;
    const horizontal = scrollsHorizontally
      ? calculateThumb(clientWidth, scrollWidth, options.minThumbSize)
      : null;

    if (vertical) {
      verticalThumbPixelsPerScrollPixel = vertical.thumbPixelsPerScrollPixel;
      setHidden(verticalThumb, false);
      setStyle(verticalThumb, "height", `${vertical.length}px`);
    } else {
      verticalThumbPixelsPerScrollPixel = 0;
      setHidden(verticalThumb, true);
    }

    if (horizontal) {
      horizontalThumbPixelsPerScrollPixel = horizontal.thumbPixelsPerScrollPixel;
      horizontalScrollOrigin = isRightToLeft(container) ? scrollWidth - clientWidth : 0;
      setHidden(horizontalThumb, false);
      setStyle(horizontalThumb, "width", `${horizontal.length}px`);
    } else {
      horizontalThumbPixelsPerScrollPixel = 0;
      setHidden(horizontalThumb, true);
    }
  };

  const positionThumbs = () => {
    if (!verticalThumb.hidden) {
      verticalThumb.style.transform = `translate3d(0, ${TRACK_INSET + options.verticalTrackStart + container.scrollTop * verticalThumbPixelsPerScrollPixel}px, 0)`;
    }
    if (!horizontalThumb.hidden) {
      horizontalThumb.style.transform = `translate3d(${TRACK_INSET + (horizontalScrollOrigin + container.scrollLeft) * horizontalThumbPixelsPerScrollPixel}px, 0, 0)`;
    }
  };

  const scheduleUpdate = (measure = false) => {
    needsMeasurement ||= measure;
    if (frameId !== null) return;

    frameId = requestAnimationFrame(() => {
      frameId = null;
      if (needsMeasurement) {
        needsMeasurement = false;
        measureThumbs();
      }
      positionThumbs();
    });
  };

  const markUserIntent = () => {
    lastUserIntentTimeMs = performance.now();
  };

  const onScroll = () => {
    const shouldShow = options.alwaysVisible || drag
      || (!options.suppressVisibility
        && (pointerOverContainer || pointerOverThumb || !options.userIntentOnly
          || performance.now() - lastUserIntentTimeMs <= USER_INTENT_DURATION_MS));

    if (!shouldShow) {
      setVisible(false);
      return;
    }

    scheduleUpdate();
    hideDeadlineMs = performance.now() + options.hideDelayMs;
    setVisible(true);
    scheduleHide();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) {
      markUserIntent();
    }
  };

  const getThumbAxis = (target: EventTarget | null) => {
    if (target === verticalThumb) return "vertical";
    if (target === horizontalThumb) return "horizontal";
    return null;
  };

  const onPointerDown = (event: PointerEvent) => {
    const axis = getThumbAxis(event.target);
    if (!axis) return;
    const thumb = axis === "vertical" ? verticalThumb : horizontalThumb;
    drag = {
      axis,
      pointerId: event.pointerId,
      pointerStartPx: axis === "vertical" ? event.clientY : event.clientX,
      scrollStartPx: axis === "vertical" ? container.scrollTop : container.scrollLeft,
    };
    markUserIntent();
    onThumbDragStart();
    hideDeadlineMs = Number.POSITIVE_INFINITY;
    if (hideTimerId !== null) {
      clearTimeout(hideTimerId);
      hideTimerId = null;
    }
    setVisible(true);
    thumb.setPointerCapture(event.pointerId);
  };

  const keepFocusOnThumbPress = (event: MouseEvent) => {
    if (getThumbAxis(event.target)) event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const pointer = drag.axis === "vertical" ? event.clientY : event.clientX;
    const scale = drag.axis === "vertical"
      ? verticalThumbPixelsPerScrollPixel
      : horizontalThumbPixelsPerScrollPixel;
    if (scale <= 0) return;
    const scrollOffset = drag.scrollStartPx + (pointer - drag.pointerStartPx) / scale;
    if (drag.axis === "vertical") container.scrollTop = scrollOffset;
    else container.scrollLeft = scrollOffset;
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const thumb = drag.axis === "vertical" ? verticalThumb : horizontalThumb;
    drag = null;
    if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
    hideDeadlineMs = performance.now() + options.hideDelayMs;
    scheduleHide();
  };

  const onPointerOver = (event: PointerEvent) => {
    if (!getThumbAxis(event.target)) return;
    pointerOverThumb = true;
    if (hideTimerId !== null) {
      clearTimeout(hideTimerId);
      hideTimerId = null;
    }
  };

  const onPointerOut = (event: PointerEvent) => {
    if (!getThumbAxis(event.target)) return;
    pointerOverThumb = false;
    hideDeadlineMs = performance.now() + options.hideDelayMs;
    scheduleHide();
  };

  const onContainerPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    pointerOverContainer = true;
    if (options.suppressVisibility && !options.alwaysVisible) return;
    hideDeadlineMs = performance.now() + options.hideDelayMs;
    if (hideTimerId !== null) {
      clearTimeout(hideTimerId);
      hideTimerId = null;
    }
    setVisible(true);
    scheduleUpdate(true);
  };

  const onContainerPointerLeave = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    pointerOverContainer = false;
    if (options.suppressVisibility) return;
    hideDeadlineMs = performance.now() + options.hideDelayMs;
    scheduleHide();
  };

  container.addEventListener("scroll", onScroll, { passive: true });
  container.addEventListener("pointerenter", onContainerPointerEnter);
  container.addEventListener("pointerleave", onContainerPointerLeave);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("mousedown", keepFocusOnThumbPress);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerEnd);
  root.addEventListener("pointercancel", onPointerEnd);
  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);

  const resizeObserver = globalThis.ResizeObserver
    ? new ResizeObserver(() => {
        needsMeasurement = false;
        measureThumbs();
        positionThumbs();
      })
    : null;

  const observeSizes = () => {
    if (!resizeObserver) return;
    resizeObserver.disconnect();
    resizeObserver.observe(container);
    for (const child of container.children) {
      resizeObserver.observe(child);
    }
  };

  observeSizes();

  const mutationObserver = globalThis.MutationObserver
    ? new MutationObserver(() => {
        observeSizes();
        scheduleUpdate(true);
      })
    : null;

  const setMutationObservation = (enabled: boolean) => {
    mutationObserver?.disconnect();
    if (enabled) mutationObserver?.observe(container, { childList: true });
  };

  const setUserIntentListeners = (enabled: boolean) => {
    if (enabled) {
      container.addEventListener("wheel", markUserIntent, { passive: true });
      container.addEventListener("touchstart", markUserIntent, { passive: true });
      container.addEventListener("touchmove", markUserIntent, { passive: true });
      container.addEventListener("keydown", onKeyDown);
    } else {
      container.removeEventListener("wheel", markUserIntent);
      container.removeEventListener("touchstart", markUserIntent);
      container.removeEventListener("touchmove", markUserIntent);
      container.removeEventListener("keydown", onKeyDown);
    }
  };

  setMutationObservation(options.observeMutations);
  setUserIntentListeners(options.userIntentOnly);
  setVisible(options.alwaysVisible);
  scheduleUpdate(true);

  return {
    update(nextOptions: ScrollbarOptions) {
      const visibilityChanged = nextOptions.alwaysVisible !== options.alwaysVisible;
      const mustMeasure = nextOptions.disableHorizontal !== options.disableHorizontal
        || nextOptions.minThumbSize !== options.minThumbSize
        || nextOptions.verticalTrackStart !== options.verticalTrackStart;
      if (nextOptions.observeMutations !== options.observeMutations) {
        setMutationObservation(nextOptions.observeMutations);
        if (nextOptions.observeMutations) observeSizes();
      }
      if (nextOptions.userIntentOnly !== options.userIntentOnly) {
        setUserIntentListeners(nextOptions.userIntentOnly);
      }
      options = nextOptions;
      if (mustMeasure) scheduleUpdate(true);
      if (options.disableHorizontal) horizontalThumb.hidden = true;
      if (options.alwaysVisible) {
        if (hideTimerId !== null) {
          clearTimeout(hideTimerId);
          hideTimerId = null;
        }
        if (visibilityChanged) scheduleUpdate();
        setVisible(true);
      } else if (options.suppressVisibility && !drag) {
        setVisible(false);
      } else if (pointerOverContainer || pointerOverThumb) {
        scheduleUpdate();
        setVisible(true);
      } else if (visibilityChanged) {
        setVisible(Boolean(drag));
      }
    },
    disconnect() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (hideTimerId !== null) clearTimeout(hideTimerId);
      setVisible(false);
      verticalThumb.hidden = true;
      horizontalThumb.hidden = true;
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("pointerenter", onContainerPointerEnter);
      container.removeEventListener("pointerleave", onContainerPointerLeave);
      setUserIntentListeners(false);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("mousedown", keepFocusOnThumbPress);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerEnd);
      root.removeEventListener("pointercancel", onPointerEnd);
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    },
  };
}

export const OverlayScrollbar: React.FC<OverlayScrollbarProps> = ({
  containerRef,
  minThumbSize = 32,
  hideDelayMs = 1000,
  className,
  disableHorizontal = false,
  observeMutations = true,
  suppressVisibility = false,
  userIntentOnly = false,
  verticalTrackStart = 0,
  onThumbDragStart,
}) => {
  const onThumbDragStartRef = React.useRef(onThumbDragStart);
  onThumbDragStartRef.current = onThumbDragStart;
  const alwaysVisible = useUIStore((state) => state.alwaysShowScrollbars === true);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const verticalThumbRef = React.useRef<HTMLDivElement>(null);
  const horizontalThumbRef = React.useRef<HTMLDivElement>(null);
  const bindingRef = React.useRef<ReturnType<typeof bindScrollbar> | null>(null);
  const boundContainerRef = React.useRef<HTMLElement | null>(null);
  const optionsRef = React.useRef<ScrollbarOptions>({
    alwaysVisible,
    minThumbSize,
    hideDelayMs,
    disableHorizontal,
    observeMutations,
    suppressVisibility,
    userIntentOnly,
    verticalTrackStart,
  });
  optionsRef.current = {
    alwaysVisible,
    minThumbSize,
    hideDelayMs,
    disableHorizontal,
    observeMutations,
    suppressVisibility,
    userIntentOnly,
    verticalTrackStart,
  };

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === boundContainerRef.current) return;

    bindingRef.current?.disconnect();
    bindingRef.current = null;
    boundContainerRef.current = container;

    const root = rootRef.current;
    const verticalThumb = verticalThumbRef.current;
    const horizontalThumb = horizontalThumbRef.current;
    if (!container || !root || !verticalThumb || !horizontalThumb) return;

    bindingRef.current = bindScrollbar(container, root, verticalThumb, horizontalThumb, optionsRef.current, () => onThumbDragStartRef.current?.());
  });

  React.useLayoutEffect(() => () => {
    bindingRef.current?.disconnect();
    bindingRef.current = null;
    boundContainerRef.current = null;
  }, []);

  React.useLayoutEffect(() => {
    bindingRef.current?.update({
      alwaysVisible,
      minThumbSize,
      hideDelayMs,
      disableHorizontal,
      observeMutations,
      suppressVisibility,
      userIntentOnly,
      verticalTrackStart,
    });
  }, [alwaysVisible, disableHorizontal, hideDelayMs, minThumbSize, observeMutations, suppressVisibility, userIntentOnly, verticalTrackStart]);

  return (
    <div ref={rootRef} className={cn("overlay-scrollbar", className)} aria-hidden="true">
      <div
        ref={verticalThumbRef}
        hidden
        className="overlay-scrollbar__thumb overlay-scrollbar__thumb--vertical"
        data-overlay-scrollbar-thumb="vertical"
        style={{ right: 0 }}
      />
      <div
        ref={horizontalThumbRef}
        hidden
        className="overlay-scrollbar__thumb overlay-scrollbar__thumb--horizontal"
        data-overlay-scrollbar-thumb="horizontal"
        style={{ bottom: 0, left: 0 }}
      />
    </div>
  );
};

OverlayScrollbar.displayName = "OverlayScrollbar";
