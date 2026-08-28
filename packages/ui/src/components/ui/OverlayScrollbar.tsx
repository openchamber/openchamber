import React from "react";
import { cn } from "@/lib/utils";

type OverlayScrollbarProps = {
  /** The authoritative scrolling element. Its identity must stay stable while mounted. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Minimum thumb length in CSS pixels, capped to the available track. */
  minThumbSize?: number;
  /** Time in milliseconds before an inactive thumb fades out. */
  hideDelayMs?: number;
  className?: string;
  /** Skips horizontal geometry reads and keeps the horizontal thumb hidden. */
  disableHorizontal?: boolean;
  /** Tracks direct-child replacement so newly mounted content remains size-observed. */
  observeMutations?: boolean;
  /** Hides the scrollbar during programmatic motion, except while the user is dragging it. */
  suppressVisibility?: boolean;
  /** Shows the scrollbar only after recent wheel, touch, keyboard, or thumb input. */
  userIntentOnly?: boolean;
};

type ScrollbarOptions = Required<Pick<
  OverlayScrollbarProps,
  "minThumbSize" | "hideDelayMs" | "disableHorizontal" | "observeMutations" | "suppressVisibility" | "userIntentOnly"
>>;

// The inset is part of both rendering and drag math; changing it must preserve that shared track.
const TRACK_INSET = 8;
const USER_INTENT_DURATION_MS = 1000;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

function calculateThumb(viewportLength: number, contentLength: number, minThumbSize: number) {
  const trackLength = Math.max(viewportLength - TRACK_INSET * 2, 0);
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
) {
  let options = initialOptions;

  // One frame coalesces scroll, resize, and mutation signals. Measurement is requested only when sizes may change.
  let frameId: number | null = null;
  let needsMeasurement = true;

  // Cached unit conversions let steady scrolling avoid layout-dependent size reads.
  let verticalThumbPixelsPerScrollPixel = 0;
  let horizontalThumbPixelsPerScrollPixel = 0;

  // A single moving deadline avoids clearing and recreating a timer on every scroll event.
  let hideTimerId: ReturnType<typeof setTimeout> | null = null;
  let hideDeadlineMs = 0;
  let lastUserIntentTimeMs = Number.NEGATIVE_INFINITY;
  let pointerOverThumb = false;

  // Drag state is the minimum snapshot needed to convert pointer travel back into a scroll offset.
  let drag: {
    axis: "vertical" | "horizontal";
    pointerId: number;
    pointerStartPx: number;
    scrollStartPx: number;
  } | null = null;

  // Visibility is an imperative presentation detail; no React consumer needs it as state.
  // React owns the stable elements; this binding exclusively owns their dynamic attributes and styles.
  const setVisible = (visible: boolean) => {
    const value = String(visible);
    if (root.dataset.visible !== value) root.dataset.visible = value;
  };

  const scheduleHide = () => {
    if (pointerOverThumb || drag || hideTimerId !== null) return;

    const hide = () => {
      hideTimerId = null;
      if (pointerOverThumb || drag) return;
      const delay = hideDeadlineMs - performance.now();
      if (delay > 0) {
        hideTimerId = setTimeout(hide, delay);
      } else {
        setVisible(false);
      }
    };

    hideTimerId = setTimeout(hide, Math.max(hideDeadlineMs - performance.now(), 0));
  };

  // Measurement is the cold path. Read every axis before writing either thumb to avoid forced layout.
  const measureThumbs = () => {
    const clientHeight = container.clientHeight;
    const scrollHeight = container.scrollHeight;
    const clientWidth = options.disableHorizontal ? 0 : container.clientWidth;
    const scrollWidth = options.disableHorizontal ? 0 : container.scrollWidth;
    const vertical = calculateThumb(clientHeight, scrollHeight, options.minThumbSize);
    const horizontal = options.disableHorizontal
      ? null
      : calculateThumb(clientWidth, scrollWidth, options.minThumbSize);

    if (vertical) {
      verticalThumbPixelsPerScrollPixel = vertical.thumbPixelsPerScrollPixel;
      verticalThumb.hidden = false;
      verticalThumb.style.height = `${vertical.length}px`;
    } else {
      verticalThumbPixelsPerScrollPixel = 0;
      verticalThumb.hidden = true;
    }

    if (horizontal) {
      horizontalThumbPixelsPerScrollPixel = horizontal.thumbPixelsPerScrollPixel;
      horizontalThumb.hidden = false;
      horizontalThumb.style.width = `${horizontal.length}px`;
    } else {
      horizontalThumbPixelsPerScrollPixel = 0;
      horizontalThumb.hidden = true;
    }
  };

  const positionThumbs = () => {
    // This is the hot path: cached scales leave only scroll offsets to read and transforms to write.
    if (!verticalThumb.hidden) {
      verticalThumb.style.transform = `translate3d(0, ${TRACK_INSET + container.scrollTop * verticalThumbPixelsPerScrollPixel}px, 0)`;
    }
    if (!horizontalThumb.hidden) {
      horizontalThumb.style.transform = `translate3d(${TRACK_INSET + container.scrollLeft * horizontalThumbPixelsPerScrollPixel}px, 0, 0)`;
    }
  };

  const scheduleUpdate = (measure = false) => {
    needsMeasurement ||= measure;
    if (frameId !== null) return;

    // All event sources share one read-before-write pass per frame.
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

  // Scroll visibility is separate from positioning so hidden programmatic scrolling does no DOM work.
  const onScroll = () => {
    const shouldShow = drag
      || (!options.suppressVisibility
        && (!options.userIntentOnly
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

  // Both thumbs delegate pointer interaction through the stable overlay root.
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
    hideDeadlineMs = Number.POSITIVE_INFINITY;
    if (hideTimerId !== null) {
      clearTimeout(hideTimerId);
      hideTimerId = null;
    }
    setVisible(true);
    thumb.setPointerCapture(event.pointerId);
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

  container.addEventListener("scroll", onScroll, { passive: true });
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerEnd);
  root.addEventListener("pointercancel", onPointerEnd);
  root.addEventListener("pointerover", onPointerOver);
  root.addEventListener("pointerout", onPointerOut);

  // ResizeObserver invalidates measurements; MutationObserver only keeps direct-child observation current.
  const resizeObserver = globalThis.ResizeObserver
    ? new ResizeObserver(() => scheduleUpdate(true))
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
  root.dataset.visible = "false";
  scheduleUpdate(true);

  // Props update policy in place; only mounting and unmounting bind browser resources.
  return {
    update(nextOptions: ScrollbarOptions) {
      const mustMeasure = nextOptions.disableHorizontal !== options.disableHorizontal
        || nextOptions.minThumbSize !== options.minThumbSize;
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
      if (options.suppressVisibility && !drag) setVisible(false);
    },
    disconnect() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      if (hideTimerId !== null) clearTimeout(hideTimerId);
      container.removeEventListener("scroll", onScroll);
      setUserIntentListeners(false);
      root.removeEventListener("pointerdown", onPointerDown);
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
}) => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const verticalThumbRef = React.useRef<HTMLDivElement>(null);
  const horizontalThumbRef = React.useRef<HTMLDivElement>(null);
  const bindingRef = React.useRef<ReturnType<typeof bindScrollbar> | null>(null);
  const boundContainerRef = React.useRef<HTMLElement | null>(null);
  const optionsRef = React.useRef<ScrollbarOptions>({
    minThumbSize,
    hideDelayMs,
    disableHorizontal,
    observeMutations,
    suppressVisibility,
    userIntentOnly,
  });
  optionsRef.current = {
    minThumbSize,
    hideDelayMs,
    disableHorizontal,
    observeMutations,
    suppressVisibility,
    userIntentOnly,
  };

  // Follow the LIVE container node, not the ref object: the chat timeline's
  // scroll element is owned by the virtualized list and remounts on every
  // session switch (key={sessionKey}), so a bind-once contract would leave
  // the scrollbar attached to a dead element after the first switch. This
  // effect runs on every commit and rebinds only when the node identity
  // actually changed — steady renders are a single pointer comparison.
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

    bindingRef.current = bindScrollbar(container, root, verticalThumb, horizontalThumb, optionsRef.current);
  });

  React.useLayoutEffect(() => () => {
    bindingRef.current?.disconnect();
    bindingRef.current = null;
    boundContainerRef.current = null;
  }, []);

  React.useLayoutEffect(() => {
    bindingRef.current?.update({
      minThumbSize,
      hideDelayMs,
      disableHorizontal,
      observeMutations,
      suppressVisibility,
      userIntentOnly,
    });
  }, [disableHorizontal, hideDelayMs, minThumbSize, observeMutations, suppressVisibility, userIntentOnly]);

  return (
    <div ref={rootRef} className={cn("overlay-scrollbar", className)} aria-hidden="true">
      <div
        ref={verticalThumbRef}
        hidden
        className="overlay-scrollbar__thumb overlay-scrollbar__thumb--vertical"
        data-overlay-scrollbar-thumb="vertical"
        style={{ right: `${TRACK_INSET / 2}px` }}
      />
      <div
        ref={horizontalThumbRef}
        hidden
        className="overlay-scrollbar__thumb overlay-scrollbar__thumb--horizontal"
        data-overlay-scrollbar-thumb="horizontal"
        style={{ bottom: `${TRACK_INSET / 2}px` }}
      />
    </div>
  );
};

OverlayScrollbar.displayName = "OverlayScrollbar";
