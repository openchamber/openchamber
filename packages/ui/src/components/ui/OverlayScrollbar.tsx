import React from "react";
import { cn } from "@/lib/utils";
import { OVERLAY_SCROLLBAR_CANCEL_SCROLL_EVENT } from "./overlay-scrollbar-events";
import { animateElementScrollToRatio } from "./scroll-animation";
import { cancelSmoothWheelScroll, smoothWheelScrollElement } from "./smoothWheelScroll";

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
  pinVerticalToBottom?: boolean;
  style?: React.CSSProperties;
  onDragEnd?: (axis: "vertical" | "horizontal", isAtEnd: boolean) => void;
};

type ThumbMetrics = {
  length: number;
  offset: number;
};

const USER_SCROLL_INTENT_WINDOW_MS = 1000;
const CONTENT_GROWTH_VISIBILITY_WINDOW_MS = 1200;
const METRIC_EPSILON = 0.5;
const EMPTY_THUMB: ThumbMetrics = { length: 0, offset: 0 };
const TRACK_INSET = 8;

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(Math.max(value, min), max);
};

const getTrackScrollDuration = (distance: number, viewport: number): number => {
  const normalizedDistance = viewport > 0 ? distance / viewport : 0;
  return clamp(105 + Math.sqrt(Math.max(normalizedDistance, 0)) * 18, 105, 185);
};

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
  pinVerticalToBottom = false,
  style,
  onDragEnd,
}) => {
  const scrollbarRef = React.useRef<HTMLDivElement>(null);
  const verticalThumbRef = React.useRef<HTMLDivElement>(null);
  const horizontalThumbRef = React.useRef<HTMLDivElement>(null);
  const scrollAnimRef = React.useRef<number | null>(null);
  const isTrackScrollAnimatingRef = React.useRef(false);
  const [visible, setVisible] = React.useState(false);
  const visibleRef = React.useRef(false);
  const [showVertical, setShowVertical] = React.useState(false);
  const [showHorizontal, setShowHorizontal] = React.useState(false);
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
    thumbTravel: number;
    maxScroll: number;
    thumbLength: number;
  }>({ pointerX: 0, pointerY: 0, scrollTop: 0, scrollLeft: 0, thumbTravel: 1, maxScroll: 1, thumbLength: 0 });
  const dragAxisRef = React.useRef<"vertical" | "horizontal" | null>(null);
  const dragScrollTargetRef = React.useRef<{ top: number | null; left: number | null }>({ top: null, left: null });
  const dragFrameRef = React.useRef<number | null>(null);
  const observedElementsRef = React.useRef<Set<Element>>(new Set());
  const verticalMetricsRef = React.useRef<ThumbMetrics>(EMPTY_THUMB);
  const horizontalMetricsRef = React.useRef<ThumbMetrics>(EMPTY_THUMB);
  const verticalVisibilityRef = React.useRef(false);
  const horizontalVisibilityRef = React.useRef(false);
  const lastContentHeightRef = React.useRef(0);
  const lastContentGrowthAtRef = React.useRef(0);

  const applyThumbMetrics = React.useCallback((thumb: HTMLDivElement | null, axis: "vertical" | "horizontal", metrics: ThumbMetrics) => {
    if (!thumb) {
      return;
    }

    if (axis === "vertical") {
      thumb.style.height = `${metrics.length}px`;
      if (pinVerticalToBottom) {
        thumb.style.bottom = `${TRACK_INSET}px`;
        thumb.style.transform = "translate3d(0, 0, 0)";
        return;
      }

      thumb.style.bottom = "";
      thumb.style.transform = `translate3d(0, ${TRACK_INSET + metrics.offset}px, 0)`;
      return;
    }

    thumb.style.width = `${metrics.length}px`;
    thumb.style.transform = `translate3d(${TRACK_INSET + metrics.offset}px, 0, 0)`;
  }, [pinVerticalToBottom]);

  const updateVisibility = React.useCallback((axis: "vertical" | "horizontal", nextVisible: boolean) => {
    if (axis === "vertical") {
      if (verticalVisibilityRef.current === nextVisible) {
        return;
      }
      verticalVisibilityRef.current = nextVisible;
      setShowVertical(nextVisible);
      return;
    }

    if (horizontalVisibilityRef.current === nextVisible) {
      return;
    }
    horizontalVisibilityRef.current = nextVisible;
    setShowHorizontal(nextVisible);
  }, []);

  const setVisibleIfChanged = React.useCallback((nextVisible: boolean) => {
    if (visibleRef.current === nextVisible) {
      return;
    }
    visibleRef.current = nextVisible;
    setVisible(nextVisible);
  }, []);

  const scheduleHide = React.useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    // Don't schedule hide if hovering over the thumb
    if (isHoveringRef.current) {
      return;
    }
    hideTimeoutRef.current = setTimeout(() => setVisibleIfChanged(false), hideDelayMs);
  }, [hideDelayMs, setVisibleIfChanged]);

  const updateMetrics = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollHeight, clientHeight, scrollTop, scrollWidth, clientWidth, scrollLeft } = container;
    const scrollbarHeight = scrollbarRef.current?.clientHeight ?? clientHeight;
    const scrollbarWidth = scrollbarRef.current?.clientWidth ?? clientWidth;

    let nextVertical: ThumbMetrics = EMPTY_THUMB;
    if (scrollHeight > clientHeight) {
      const trackLength = Math.max(scrollbarHeight - TRACK_INSET * 2, 0);
      const rawThumb = (clientHeight / scrollHeight) * trackLength;
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb));
      const maxOffset = Math.max(trackLength - length, 0);
      const maxScroll = Math.max(scrollHeight - clientHeight, 1);
      const offset = pinVerticalToBottom ? maxOffset : (scrollTop / maxScroll) * maxOffset;
      nextVertical = { length, offset };
    }
    if (!isSameThumbMetrics(verticalMetricsRef.current, nextVertical)) {
      verticalMetricsRef.current = nextVertical;
      applyThumbMetrics(verticalThumbRef.current, "vertical", nextVertical);
    }
    updateVisibility("vertical", nextVertical.length > 0);

    let nextHorizontal: ThumbMetrics = EMPTY_THUMB;
    if (!disableHorizontal && scrollWidth > clientWidth) {
      const trackLength = Math.max(scrollbarWidth - TRACK_INSET * 2, 0);
      const rawThumb = (clientWidth / scrollWidth) * trackLength;
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb));
      const maxOffset = Math.max(trackLength - length, 0);
      const maxScroll = Math.max(scrollWidth - clientWidth, 1);
      const offset = (scrollLeft / maxScroll) * maxOffset;
      nextHorizontal = { length, offset };
    }
    if (!isSameThumbMetrics(horizontalMetricsRef.current, nextHorizontal)) {
      horizontalMetricsRef.current = nextHorizontal;
      applyThumbMetrics(horizontalThumbRef.current, "horizontal", nextHorizontal);
    }
    updateVisibility("horizontal", nextHorizontal.length > 0);

    if (scrollHeight > lastContentHeightRef.current + METRIC_EPSILON) {
      lastContentGrowthAtRef.current = Date.now();
      setVisibleIfChanged(true);
      scheduleHide();
    }
    lastContentHeightRef.current = scrollHeight;
  }, [applyThumbMetrics, containerRef, disableHorizontal, minThumbSize, pinVerticalToBottom, scheduleHide, setVisibleIfChanged, updateVisibility]);

  const scheduleMetricsUpdate = React.useCallback(() => {
    if (isDraggingRef.current) return;
    if (metricsFrameRef.current !== null) return;
    metricsFrameRef.current = requestAnimationFrame(() => {
      metricsFrameRef.current = null;
      updateMetrics();
    });
  }, [updateMetrics]);

  React.useLayoutEffect(() => {
    if (showVertical) {
      applyThumbMetrics(verticalThumbRef.current, "vertical", verticalMetricsRef.current);
    }
    if (showHorizontal) {
      applyThumbMetrics(horizontalThumbRef.current, "horizontal", horizontalMetricsRef.current);
    }
  }, [applyThumbMetrics, pinVerticalToBottom, showHorizontal, showVertical]);

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

  const markUserIntent = React.useCallback(() => {
    lastUserIntentAtRef.current = Date.now();
  }, []);

  const cancelTrackScrollAnimation = React.useCallback(() => {
    if (scrollAnimRef.current !== null) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
    isTrackScrollAnimatingRef.current = false;
  }, []);

  const cancelScrollAnimations = React.useCallback(() => {
    cancelTrackScrollAnimation();
    const container = containerRef.current;
    if (container) {
      cancelSmoothWheelScroll(container);
    }
  }, [cancelTrackScrollAnimation, containerRef]);

  const flushDragScrollTarget = React.useCallback(() => {
    dragFrameRef.current = null;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const { top, left } = dragScrollTargetRef.current;
    if (top !== null) {
      container.scrollTop = top;
    }
    if (left !== null) {
      container.scrollLeft = left;
    }
    if (isDraggingRef.current) {
      const axis = dragAxisRef.current;
      const { thumbLength, thumbTravel, maxScroll } = dragStartRef.current;
      if (axis === "vertical") {
        const nextOffset = maxScroll > 0
          ? (container.scrollTop / maxScroll) * thumbTravel
          : 0;
        const nextMetrics = { length: thumbLength, offset: nextOffset };
        verticalMetricsRef.current = nextMetrics;
        applyThumbMetrics(verticalThumbRef.current, "vertical", nextMetrics);
      } else if (axis === "horizontal") {
        const nextOffset = maxScroll > 0
          ? (container.scrollLeft / maxScroll) * thumbTravel
          : 0;
        const nextMetrics = { length: thumbLength, offset: nextOffset };
        horizontalMetricsRef.current = nextMetrics;
        applyThumbMetrics(horizontalThumbRef.current, "horizontal", nextMetrics);
      }
      updateVisibility("vertical", verticalMetricsRef.current.length > 0);
      updateVisibility("horizontal", horizontalMetricsRef.current.length > 0);
      return;
    }
    updateMetrics();
  }, [applyThumbMetrics, containerRef, updateMetrics, updateVisibility]);

  const scheduleDragScrollTarget = React.useCallback(() => {
    if (dragFrameRef.current !== null) {
      return;
    }
    dragFrameRef.current = requestAnimationFrame(flushDragScrollTarget);
  }, [flushDragScrollTarget]);

  const handleScroll = React.useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      if (isTrackScrollAnimatingRef.current) {
        return;
      }
      if (isDraggingRef.current) {
        setVisibleIfChanged(true);
        return;
      }
      updateMetrics();
      const hasRecentContentGrowth = Date.now() - lastContentGrowthAtRef.current <= CONTENT_GROWTH_VISIBILITY_WINDOW_MS;
      if (forceVisible) {
        setVisibleIfChanged(true);
        return;
      }
      if (suppressVisibility && !isDraggingRef.current && !hasRecentContentGrowth) {
        setVisibleIfChanged(false);
        return;
      }
      if (userIntentOnly && !isDraggingRef.current && !hasRecentContentGrowth) {
        const hasRecentUserIntent = Date.now() - lastUserIntentAtRef.current <= USER_SCROLL_INTENT_WINDOW_MS;
        if (!hasRecentUserIntent) {
          setVisibleIfChanged(false);
          return;
        }
      }
      setVisibleIfChanged(true);
      scheduleHide();
    });
  }, [forceVisible, scheduleHide, setVisibleIfChanged, suppressVisibility, updateMetrics, userIntentOnly]);

  React.useEffect(() => {
    if (forceVisible) {
      updateMetrics();
      setVisibleIfChanged(true);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      return;
    }

    if (!isDraggingRef.current && !isHoveringRef.current) {
      scheduleHide();
    }
  }, [forceVisible, scheduleHide, setVisibleIfChanged, updateMetrics]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateMetrics();
    lastContentHeightRef.current = container.scrollHeight;
    setVisibleIfChanged(false);

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
            if (isDraggingRef.current) {
              return;
            }
            scheduleMetricsUpdate();
          })
        : null;
    syncObservedElements(container, resizeObserver);

    const mutationObserver =
      observeMutations && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (isDraggingRef.current) {
              return;
            }
            syncObservedElements(container, resizeObserver);
            scheduleMetricsUpdate();
          })
        : null;
    mutationObserver?.observe(container, { childList: true });

    const onInput = () => {
      if (isDraggingRef.current) {
        return;
      }
      scheduleMetricsUpdate();
    };
    const onLoad = () => {
      if (isDraggingRef.current) {
        return;
      }
      scheduleMetricsUpdate();
    };
    container.addEventListener("input", onInput, true);
    container.addEventListener("load", onLoad, true);

    return () => {
      isDraggingRef.current = false;
      dragAxisRef.current = null;
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
      if (dragFrameRef.current) cancelAnimationFrame(dragFrameRef.current);
      cancelScrollAnimations();
    };
  }, [cancelScrollAnimations, containerRef, handleScroll, markUserIntent, observeMutations, scheduleMetricsUpdate, setVisibleIfChanged, syncObservedElements, updateMetrics, userIntentOnly]);

  React.useEffect(() => {
    if (!suppressVisibility) {
      return;
    }
    if (isDraggingRef.current) {
      return;
    }
    setVisibleIfChanged(false);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, [setVisibleIfChanged, suppressVisibility]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>, axis: "vertical" | "horizontal") => {
    const container = containerRef.current;
    if (!container) return;

    cancelScrollAnimations();

    const scrollbarHeight = scrollbarRef.current?.clientHeight ?? container.clientHeight;
    const scrollbarWidth = scrollbarRef.current?.clientWidth ?? container.clientWidth;
    const metrics = axis === "vertical" ? verticalMetricsRef.current : horizontalMetricsRef.current;
    const trackLength = axis === "vertical"
      ? Math.max(scrollbarHeight - TRACK_INSET * 2, 0)
      : Math.max(scrollbarWidth - TRACK_INSET * 2, 0);

    isDraggingRef.current = true;
    dragScrollTargetRef.current.top = container.scrollTop;
    dragScrollTargetRef.current.left = container.scrollLeft;
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      thumbTravel: Math.max(trackLength - metrics.length, 1),
      maxScroll: axis === "vertical"
        ? Math.max(container.scrollHeight - container.clientHeight, 1)
        : Math.max(container.scrollWidth - container.clientWidth, 1),
      thumbLength: metrics.length,
    };
    dragAxisRef.current = axis;
    markUserIntent();
    setVisibleIfChanged(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const container = containerRef.current;
    if (!container) return;

    cancelTrackScrollAnimation();

    const axis = dragAxisRef.current;
    if (axis === "vertical") {
      const { pointerY, scrollTop, thumbTravel, maxScroll } = dragStartRef.current;
      const delta = event.clientY - pointerY;
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      dragScrollTargetRef.current.top = scrollTop + scrollDelta;
      dragScrollTargetRef.current.left = null;
    } else if (axis === "horizontal") {
      const { pointerX, scrollLeft, thumbTravel, maxScroll } = dragStartRef.current;
      const delta = event.clientX - pointerX;
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      dragScrollTargetRef.current.left = scrollLeft + scrollDelta;
      dragScrollTargetRef.current.top = null;
    }
    scheduleDragScrollTarget();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    flushDragScrollTarget();

    const axis = dragAxisRef.current;
    const container = containerRef.current;
    if (onDragEnd && axis && container) {
      const isAtEnd = axis === "vertical"
        ? container.scrollTop >= Math.max(container.scrollHeight - container.clientHeight - 1, 0)
        : container.scrollLeft >= Math.max(container.scrollWidth - container.clientWidth - 1, 0);
      onDragEnd(axis, isAtEnd);
    }

    dragScrollTargetRef.current.top = null;
    dragScrollTargetRef.current.left = null;
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
    setVisibleIfChanged(true);
  }, [setVisibleIfChanged]);

  const handleTrackMouseLeave = React.useCallback(() => {
    isHoveringRef.current = false;
    scheduleHide();
  }, [scheduleHide]);

  const handleTrackWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    markUserIntent();
    setVisibleIfChanged(true);
    scheduleHide();
    cancelTrackScrollAnimation();

    event.preventDefault();
    smoothWheelScrollElement(container, event);
  }, [cancelTrackScrollAnimation, containerRef, markUserIntent, scheduleHide, setVisibleIfChanged]);

  const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>, axis: "vertical" | "horizontal") => {
    if (event.target !== event.currentTarget) {
      return;
    }

    const container = containerRef.current;
    const track = event.currentTarget;
    if (!container || !track) return;

    cancelScrollAnimations();
    markUserIntent();
    setVisibleIfChanged(true);

    const rect = track.getBoundingClientRect();
    const maxScroll = axis === "vertical"
      ? container.scrollHeight - container.clientHeight
      : container.scrollWidth - container.clientWidth;
    const metrics = axis === "vertical" ? verticalMetricsRef.current : horizontalMetricsRef.current;
    const laneLength = axis === "vertical"
      ? Math.max(rect.height - TRACK_INSET * 2, 0)
      : Math.max(rect.width - TRACK_INSET * 2, 0);
    const maxOffset = Math.max(laneLength - metrics.length, 0);

    let targetScroll = 0;
    if (axis === "vertical") {
      const clickY = event.clientY - rect.top;
      const laneClick = clamp(clickY - TRACK_INSET, 0, laneLength);
      const targetOffset = clamp(laneClick - metrics.length / 2, 0, maxOffset);
      const pct = maxOffset > 0 ? targetOffset / maxOffset : 0;
      targetScroll = pct * maxScroll;
      isTrackScrollAnimatingRef.current = true;
      animateElementScrollToRatio(
        container,
        pct,
        "vertical",
        getTrackScrollDuration(Math.abs(targetScroll - container.scrollTop), container.clientHeight),
        scrollAnimRef,
        updateMetrics,
        () => {
          isTrackScrollAnimatingRef.current = false;
          updateMetrics();
        },
      );
    } else {
      const clickX = event.clientX - rect.left;
      const laneClick = clamp(clickX - TRACK_INSET, 0, laneLength);
      const targetOffset = clamp(laneClick - metrics.length / 2, 0, maxOffset);
      const pct = maxOffset > 0 ? targetOffset / maxOffset : 0;
      targetScroll = pct * maxScroll;
      isTrackScrollAnimatingRef.current = true;
      animateElementScrollToRatio(
        container,
        pct,
        "horizontal",
        getTrackScrollDuration(Math.abs(targetScroll - container.scrollLeft), container.clientWidth),
        scrollAnimRef,
        updateMetrics,
        () => {
          isTrackScrollAnimatingRef.current = false;
          updateMetrics();
        },
      );
    }

    isDraggingRef.current = true;
    const trackLength = axis === "vertical"
      ? Math.max(rect.height - TRACK_INSET * 2, 0)
      : Math.max(rect.width - TRACK_INSET * 2, 0);
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollTop: axis === "vertical" ? targetScroll : container.scrollTop,
      scrollLeft: axis === "horizontal" ? targetScroll : container.scrollLeft,
      thumbTravel: Math.max(trackLength - metrics.length, 1),
      maxScroll: Math.max(maxScroll, 1),
      thumbLength: metrics.length,
    };
    dragAxisRef.current = axis;
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    track.setPointerCapture(event.pointerId);
  };

  if (!showVertical && !showHorizontal) return null;

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
              right: 0,
              width: "16px",
              pointerEvents: "auto",
              cursor: "pointer",
              willChange: "transform",
            }}
            ref={verticalThumbRef}
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
              bottom: 0,
              height: "16px",
              pointerEvents: "auto",
              cursor: "pointer",
              willChange: "transform",
            }}
            ref={horizontalThumbRef}
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
