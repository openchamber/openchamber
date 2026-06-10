import React from "react";
import { cn } from "@/lib/utils";
import { OVERLAY_SCROLLBAR_CANCEL_SCROLL_EVENT } from "./overlay-scrollbar-events";
import { animateElementScrollTo } from "./scroll-animation";

type OverlayScrollbarProps = {
  containerRef: React.RefObject<HTMLElement | null>;
  minThumbSize?: number;
  hideDelayMs?: number;
  className?: string;
  disableHorizontal?: boolean;
  observeMutations?: boolean;
  suppressVisibility?: boolean;
  userIntentOnly?: boolean;
  forceVisible?: boolean;
  style?: React.CSSProperties;
};

type ThumbMetrics = {
  length: number;
  offset: number;
};

const USER_SCROLL_INTENT_WINDOW_MS = 1000;
const METRIC_EPSILON = 0.5;
const EMPTY_THUMB: ThumbMetrics = { length: 0, offset: 0 };

const isSameThumbMetrics = (a: ThumbMetrics, b: ThumbMetrics): boolean => {
  return Math.abs(a.length - b.length) < METRIC_EPSILON && Math.abs(a.offset - b.offset) < METRIC_EPSILON;
};

const OverlayScrollbarComponent: React.FC<OverlayScrollbarProps> = ({
  containerRef,
  minThumbSize = 32,
  hideDelayMs = 1000,
  className,
  disableHorizontal = false,
  observeMutations = true,
  suppressVisibility = false,
  userIntentOnly = false,
  forceVisible = false,
  style,
}) => {
  const scrollbarRef = React.useRef<HTMLDivElement>(null);
  const scrollAnimRef = React.useRef<number | null>(null);
  const wheelAnimFrameRef = React.useRef<number | null>(null);
  const isWheelAnimatingRef = React.useRef(false);
  const wheelTargetRef = React.useRef<number | null>(null);
  const [visible, setVisible] = React.useState(false);
  const [vertical, setVertical] = React.useState<ThumbMetrics>({ length: 0, offset: 0 });
  const [horizontal, setHorizontal] = React.useState<ThumbMetrics>({ length: 0, offset: 0 });
  const hideTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const metricsFrameRef = React.useRef<number | null>(null);
  const isDraggingRef = React.useRef(false);
  const isHoveringRef = React.useRef(false);
  const lastUserIntentAtRef = React.useRef(0);
  const dragStartRef = React.useRef<{
    pointerX: number;
    pointerY: number;
    scrollTop: number;
    scrollLeft: number;
  }>({ pointerX: 0, pointerY: 0, scrollTop: 0, scrollLeft: 0 });
  const dragAxisRef = React.useRef<"vertical" | "horizontal" | null>(null);
  const observedElementsRef = React.useRef<Set<Element>>(new Set());

  const updateMetrics = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollHeight, clientHeight, scrollTop, scrollWidth, clientWidth, scrollLeft } = container;
    const scrollbarHeight = scrollbarRef.current?.clientHeight ?? clientHeight;
    const scrollbarWidth = scrollbarRef.current?.clientWidth ?? clientWidth;
    const trackInset = 8;

    let nextVertical: ThumbMetrics = EMPTY_THUMB;
    if (scrollHeight > clientHeight) {
      const trackLength = Math.max(scrollbarHeight - trackInset * 2, 0);
      const rawThumb = (clientHeight / scrollHeight) * trackLength;
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb));
      const maxOffset = Math.max(trackLength - length, 0);
      const maxScroll = Math.max(scrollHeight - clientHeight, 1);
      const offset = (scrollTop / maxScroll) * maxOffset;
      nextVertical = { length, offset };
    }
    setVertical((prev) => (isSameThumbMetrics(prev, nextVertical) ? prev : nextVertical));

    let nextHorizontal: ThumbMetrics = EMPTY_THUMB;
    if (!disableHorizontal && scrollWidth > clientWidth) {
      const trackLength = Math.max(scrollbarWidth - trackInset * 2, 0);
      const rawThumb = (clientWidth / scrollWidth) * trackLength;
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb));
      const maxOffset = Math.max(trackLength - length, 0);
      const maxScroll = Math.max(scrollWidth - clientWidth, 1);
      const offset = (scrollLeft / maxScroll) * maxOffset;
      nextHorizontal = { length, offset };
    }
    setHorizontal((prev) => (isSameThumbMetrics(prev, nextHorizontal) ? prev : nextHorizontal));
  }, [containerRef, minThumbSize, disableHorizontal]);

  const scheduleMetricsUpdate = React.useCallback(() => {
    if (metricsFrameRef.current !== null) return;
    metricsFrameRef.current = requestAnimationFrame(() => {
      metricsFrameRef.current = null;
      updateMetrics();
    });
  }, [updateMetrics]);

  const syncObservedElements = React.useCallback((container: HTMLElement, resizeObserver: ResizeObserver | null) => {
    if (!resizeObserver) {
      observedElementsRef.current.clear();
      return;
    }

    const nextObserved = new Set<Element>();
    nextObserved.add(container);
    Array.from(container.children).forEach((child) => {
      nextObserved.add(child);
    });

    observedElementsRef.current.forEach((element) => {
      if (!nextObserved.has(element)) {
        resizeObserver.unobserve(element);
      }
    });

    nextObserved.forEach((element) => {
      if (!observedElementsRef.current.has(element)) {
        resizeObserver.observe(element);
      }
    });

    observedElementsRef.current = nextObserved;
  }, []);

  const scheduleHide = React.useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    // Don't schedule hide if hovering over the thumb
    if (isHoveringRef.current) {
      return;
    }
    hideTimeoutRef.current = setTimeout(() => setVisible(false), hideDelayMs);
  }, [hideDelayMs]);

  const markUserIntent = React.useCallback(() => {
    lastUserIntentAtRef.current = Date.now();
  }, []);

  const cancelTrackScrollAnimation = React.useCallback(() => {
    if (scrollAnimRef.current !== null) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
  }, []);

  const cancelScrollAnimations = React.useCallback(() => {
    cancelTrackScrollAnimation();
    if (wheelAnimFrameRef.current !== null) {
      cancelAnimationFrame(wheelAnimFrameRef.current);
      wheelAnimFrameRef.current = null;
    }
    wheelTargetRef.current = null;
    isWheelAnimatingRef.current = false;
  }, [cancelTrackScrollAnimation]);

  const handleScroll = React.useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      updateMetrics();
      if (forceVisible) {
        setVisible(true);
        return;
      }
      if (suppressVisibility && !isDraggingRef.current) {
        setVisible(false);
        return;
      }
      if (userIntentOnly && !isDraggingRef.current) {
        const hasRecentUserIntent = Date.now() - lastUserIntentAtRef.current <= USER_SCROLL_INTENT_WINDOW_MS;
        if (!hasRecentUserIntent) {
          setVisible(false);
          return;
        }
      }
      setVisible(true);
      scheduleHide();
    });
  }, [forceVisible, scheduleHide, suppressVisibility, updateMetrics, userIntentOnly]);

  React.useEffect(() => {
    if (forceVisible) {
      updateMetrics();
      setVisible(true);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      return;
    }

    if (!isDraggingRef.current && !isHoveringRef.current) {
      scheduleHide();
    }
  }, [forceVisible, scheduleHide, updateMetrics]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateMetrics();
    setVisible(false);

    const onScroll = () => handleScroll();
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'ArrowUp'
        || event.key === 'ArrowDown'
        || event.key === 'PageUp'
        || event.key === 'PageDown'
        || event.key === 'Home'
        || event.key === 'End'
        || event.key === ' '
      ) {
        markUserIntent();
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener(OVERLAY_SCROLLBAR_CANCEL_SCROLL_EVENT, cancelScrollAnimations);
    if (userIntentOnly) {
      container.addEventListener("wheel", markUserIntent, { passive: true });
      container.addEventListener("touchstart", markUserIntent, { passive: true });
      container.addEventListener("touchmove", markUserIntent, { passive: true });
      container.addEventListener("keydown", onKeyDown);
    }

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            scheduleMetricsUpdate();
          })
        : null;
    syncObservedElements(container, resizeObserver);

    const mutationObserver =
      observeMutations && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            syncObservedElements(container, resizeObserver);
            scheduleMetricsUpdate();
          })
        : null;
    mutationObserver?.observe(container, { childList: true });

    const onInput = () => scheduleMetricsUpdate();
    const onLoad = () => scheduleMetricsUpdate();
    container.addEventListener("input", onInput, true);
    container.addEventListener("load", onLoad, true);

    return () => {
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener(OVERLAY_SCROLLBAR_CANCEL_SCROLL_EVENT, cancelScrollAnimations);
      container.removeEventListener("input", onInput, true);
      container.removeEventListener("load", onLoad, true);
      if (userIntentOnly) {
        container.removeEventListener("wheel", markUserIntent);
        container.removeEventListener("touchstart", markUserIntent);
        container.removeEventListener("touchmove", markUserIntent);
        container.removeEventListener("keydown", onKeyDown);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      observedElementsRef.current.clear();
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      if (metricsFrameRef.current) cancelAnimationFrame(metricsFrameRef.current);
      cancelScrollAnimations();
    };
  }, [cancelScrollAnimations, containerRef, handleScroll, markUserIntent, observeMutations, scheduleMetricsUpdate, syncObservedElements, updateMetrics, userIntentOnly]);

  React.useEffect(() => {
    if (!suppressVisibility) {
      return;
    }
    if (isDraggingRef.current) {
      return;
    }
    setVisible(false);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, [suppressVisibility]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, axis: "vertical" | "horizontal") => {
    const container = containerRef.current;
    if (!container) return;

    cancelScrollAnimations();

    isDraggingRef.current = true;
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
    };
    dragAxisRef.current = axis;
    markUserIntent();
    setVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    if (scrollAnimRef.current !== null) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }

    const axis = dragAxisRef.current;
    if (axis === "vertical") {
      const { pointerY, scrollTop } = dragStartRef.current;
      const delta = event.clientY - pointerY;
      const scrollbarHeight = scrollbarRef.current?.clientHeight ?? container.clientHeight;
      const trackLength = scrollbarHeight;
      const thumbTravel = Math.max(trackLength - vertical.length, 1);
      const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 1);
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      container.scrollTop = scrollTop + scrollDelta;
    } else if (axis === "horizontal") {
      const { pointerX, scrollLeft } = dragStartRef.current;
      const delta = event.clientX - pointerX;
      const scrollbarWidth = scrollbarRef.current?.clientWidth ?? container.clientWidth;
      const trackLength = scrollbarWidth;
      const thumbTravel = Math.max(trackLength - horizontal.length, 1);
      const maxScroll = Math.max(container.scrollWidth - container.clientWidth, 1);
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      container.scrollLeft = scrollLeft + scrollDelta;
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    scheduleHide();
  };

  const handleThumbMouseEnter = React.useCallback(() => {
    isHoveringRef.current = true;
    // Cancel any pending hide when hovering
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const handleThumbMouseLeave = React.useCallback(() => {
    isHoveringRef.current = false;
    // Schedule hide when leaving the thumb
    scheduleHide();
  }, [scheduleHide]);

  const handleTrackMouseEnter = React.useCallback(() => {
    isHoveringRef.current = true;
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setVisible(true);
  }, []);

  const handleTrackMouseLeave = React.useCallback(() => {
    isHoveringRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  const handleTrackWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    markUserIntent();
    setVisible(true);
    scheduleHide();
    cancelTrackScrollAnimation();

    event.preventDefault();
    const clonedEvent = new WheelEvent("wheel", {
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(clonedEvent);

    const maxScroll = container.scrollHeight - container.clientHeight;
    if (wheelTargetRef.current === null) {
      wheelTargetRef.current = container.scrollTop;
    }

    wheelTargetRef.current = Math.max(0, Math.min(maxScroll, wheelTargetRef.current + event.deltaY));

    const smoothScroll = () => {
      wheelAnimFrameRef.current = null;
      const container = containerRef.current;
      if (!container || wheelTargetRef.current === null) {
        isWheelAnimatingRef.current = false;
        return;
      }

      const diff = wheelTargetRef.current - container.scrollTop;
      if (Math.abs(diff) < 0.5) {
        container.scrollTop = wheelTargetRef.current;
        wheelTargetRef.current = null;
        isWheelAnimatingRef.current = false;
      } else {
        container.scrollTop += diff * 0.25;
        wheelAnimFrameRef.current = requestAnimationFrame(smoothScroll);
      }
    };

    if (!isWheelAnimatingRef.current) {
      isWheelAnimatingRef.current = true;
      wheelAnimFrameRef.current = requestAnimationFrame(smoothScroll);
    }
  }, [cancelTrackScrollAnimation, containerRef, markUserIntent, scheduleHide]);

  const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>, axis: "vertical" | "horizontal") => {
    if (event.target !== event.currentTarget) {
      return;
    }

    const container = containerRef.current;
    const track = event.currentTarget;
    if (!container || !track) return;

    cancelScrollAnimations();
    markUserIntent();
    setVisible(true);

    const rect = track.getBoundingClientRect();
    const maxScroll = axis === "vertical"
      ? container.scrollHeight - container.clientHeight
      : container.scrollWidth - container.clientWidth;

    let targetScroll = 0;
    if (axis === "vertical") {
      const clickY = event.clientY - rect.top;
      const trackHeight = rect.height;
      const pct = Math.max(0, Math.min(1, clickY / trackHeight));
      targetScroll = pct * maxScroll;
      animateElementScrollTo(container, targetScroll, "vertical", 220, scrollAnimRef);
    } else {
      const clickX = event.clientX - rect.left;
      const trackWidth = rect.width;
      const pct = Math.max(0, Math.min(1, clickX / trackWidth));
      targetScroll = pct * maxScroll;
      animateElementScrollTo(container, targetScroll, "horizontal", 220, scrollAnimRef);
    }

    isDraggingRef.current = true;
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollTop: axis === "vertical" ? targetScroll : container.scrollTop,
      scrollLeft: axis === "horizontal" ? targetScroll : container.scrollLeft,
    };
    dragAxisRef.current = axis;
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    track.setPointerCapture(event.pointerId);
  };

  const showVertical = vertical.length > 0;
  const showHorizontal = horizontal.length > 0;
  if (!showVertical && !showHorizontal) return null;

  const trackInset = 8;

  return (
    <div
      ref={scrollbarRef}
      className={cn("overlay-scrollbar", className)}
      aria-hidden="true"
      style={{ ...style, opacity: visible ? 1 : 0 }}
    >
      {showVertical && (
        <div
          className="overlay-scrollbar__track overlay-scrollbar__track--vertical"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: "16px",
            pointerEvents: "auto",
            cursor: "pointer",
          }}
          onPointerDown={(e) => handleTrackPointerDown(e, "vertical")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onMouseEnter={handleTrackMouseEnter}
          onMouseLeave={handleTrackMouseLeave}
          onWheel={handleTrackWheel}
        >
          <div
            className="overlay-scrollbar__thumb-wrapper"
            data-overlay-scrollbar-thumb="vertical"
            style={{
              position: "absolute",
              height: `${vertical.length}px`,
              top: `${trackInset + vertical.offset}px`,
              right: 0,
              width: "16px",
              pointerEvents: "auto",
              cursor: "pointer",
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              handlePointerDown(e, "vertical");
            }}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onMouseEnter={handleThumbMouseEnter}
            onMouseLeave={handleThumbMouseLeave}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                right: "4px",
                width: "6px",
                borderRadius: "9999px",
                backgroundColor: "var(--oc-scrollbar-thumb)",
                transition: "background-color 0.15s ease",
              }}
              className="overlay-scrollbar__thumb-visual"
            />
          </div>
        </div>
      )}
      {showHorizontal && (
        <div
          className="overlay-scrollbar__track overlay-scrollbar__track--horizontal"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: "16px",
            pointerEvents: "auto",
            cursor: "pointer",
          }}
          onPointerDown={(e) => handleTrackPointerDown(e, "horizontal")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onMouseEnter={handleTrackMouseEnter}
          onMouseLeave={handleTrackMouseLeave}
          onWheel={handleTrackWheel}
        >
          <div
            className="overlay-scrollbar__thumb-wrapper"
            data-overlay-scrollbar-thumb="horizontal"
            style={{
              position: "absolute",
              width: `${horizontal.length}px`,
              left: `${trackInset + horizontal.offset}px`,
              bottom: 0,
              height: "16px",
              pointerEvents: "auto",
              cursor: "pointer",
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              handlePointerDown(e, "horizontal");
            }}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onMouseEnter={handleThumbMouseEnter}
            onMouseLeave={handleThumbMouseLeave}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "4px",
                height: "6px",
                borderRadius: "9999px",
                backgroundColor: "var(--oc-scrollbar-thumb)",
                transition: "background-color 0.15s ease",
              }}
              className="overlay-scrollbar__thumb-visual"
            />
          </div>
        </div>
      )}
    </div>
  );
};

OverlayScrollbarComponent.displayName = "OverlayScrollbar";

export const OverlayScrollbar = OverlayScrollbarComponent;
