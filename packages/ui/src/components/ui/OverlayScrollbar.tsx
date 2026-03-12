import React from "react";
import { cn } from "@/lib/utils";

type OverlayScrollbarProps = {
  containerRef: React.RefObject<HTMLElement | null>;
  minThumbSize?: number;
  hideDelayMs?: number;
  className?: string;
  disableHorizontal?: boolean;
  observeMutations?: boolean;
  suppressVisibility?: boolean;
  userIntentOnly?: boolean;
};

type ThumbMetrics = {
  length: number;
  offset: number;
};

const USER_SCROLL_INTENT_WINDOW_MS = 1000;

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
  const [visible, setVisible] = React.useState(false);
  const [vertical, setVertical] = React.useState<ThumbMetrics>({ length: 0, offset: 0 });
  const [horizontal, setHorizontal] = React.useState<ThumbMetrics>({ length: 0, offset: 0 });
  const hideTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = React.useRef<number | null>(null);
  const isDraggingRef = React.useRef(false);
  const lastUserIntentAtRef = React.useRef(0);
  const dragStartRef = React.useRef<{
    pointerX: number;
    pointerY: number;
    scrollTop: number;
    scrollLeft: number;
  }>({ pointerX: 0, pointerY: 0, scrollTop: 0, scrollLeft: 0 });
  const dragAxisRef = React.useRef<"vertical" | "horizontal" | null>(null);

  const updateMetrics = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollHeight, clientHeight, scrollTop, scrollWidth, clientWidth, scrollLeft } = container;
    const trackInset = 8;

    if (scrollHeight > clientHeight) {
      const trackLength = Math.max(clientHeight - trackInset * 2, 0);
      const rawThumb = (clientHeight / scrollHeight) * trackLength;
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb));
      const maxOffset = Math.max(trackLength - length, 0);
      const maxScroll = Math.max(scrollHeight - clientHeight, 1);
      const offset = (scrollTop / maxScroll) * maxOffset;
      setVertical({ length, offset });
    } else {
      setVertical({ length: 0, offset: 0 });
    }

    if (!disableHorizontal && scrollWidth > clientWidth) {
      const trackLength = Math.max(clientWidth - trackInset * 2, 0);
      const rawThumb = (clientWidth / scrollWidth) * trackLength;
      const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb));
      const maxOffset = Math.max(trackLength - length, 0);
      const maxScroll = Math.max(scrollWidth - clientWidth, 1);
      const offset = (scrollLeft / maxScroll) * maxOffset;
      setHorizontal({ length, offset });
    } else {
      setHorizontal({ length: 0, offset: 0 });
    }
  }, [containerRef, minThumbSize, disableHorizontal]);

  const scheduleHide = React.useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }
    hideTimeoutRef.current = setTimeout(() => setVisible(false), hideDelayMs);
  }, [hideDelayMs]);

  const markUserIntent = React.useCallback(() => {
    lastUserIntentAtRef.current = Date.now();
  }, []);

  const handleScroll = React.useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
    }
    frameRef.current = requestAnimationFrame(() => {
      updateMetrics();
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
  }, [scheduleHide, suppressVisibility, updateMetrics, userIntentOnly]);

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
    if (userIntentOnly) {
      container.addEventListener("wheel", markUserIntent, { passive: true });
      container.addEventListener("touchstart", markUserIntent, { passive: true });
      container.addEventListener("touchmove", markUserIntent, { passive: true });
      container.addEventListener("keydown", onKeyDown);
    }

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => updateMetrics())
        : null;
    resizeObserver?.observe(container);

    const mutationObserver =
      observeMutations && typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => updateMetrics())
        : null;
    mutationObserver?.observe(container, { childList: true, subtree: true, characterData: true });

    return () => {
      container.removeEventListener("scroll", onScroll);
      if (userIntentOnly) {
        container.removeEventListener("wheel", markUserIntent);
        container.removeEventListener("touchstart", markUserIntent);
        container.removeEventListener("touchmove", markUserIntent);
        container.removeEventListener("keydown", onKeyDown);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [containerRef, handleScroll, markUserIntent, observeMutations, updateMetrics, userIntentOnly]);

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

    const axis = dragAxisRef.current;
    if (axis === "vertical") {
      const { pointerY, scrollTop } = dragStartRef.current;
      const delta = event.clientY - pointerY;
      const trackLength = container.clientHeight;
      const thumbTravel = Math.max(trackLength - vertical.length, 1);
      const maxScroll = Math.max(container.scrollHeight - container.clientHeight, 1);
      const scrollDelta = (delta / thumbTravel) * maxScroll;
      container.scrollTop = scrollTop + scrollDelta;
    } else if (axis === "horizontal") {
      const { pointerX, scrollLeft } = dragStartRef.current;
      const delta = event.clientX - pointerX;
      const trackLength = container.clientWidth;
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

  const showVertical = vertical.length > 0;
  const showHorizontal = horizontal.length > 0;
  if (!showVertical && !showHorizontal) return null;

  const trackInset = 8;

  return (
    <div
      className={cn("overlay-scrollbar", className)}
      aria-hidden="true"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {showVertical && (
        <div
          className="overlay-scrollbar__thumb overlay-scrollbar__thumb--vertical"
          style={{
            height: `${vertical.length}px`,
            top: `${trackInset + vertical.offset}px`,
            right: `${trackInset / 2}px`,
          }}
          onPointerDown={(e) => handlePointerDown(e, "vertical")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      )}
      {showHorizontal && (
        <div
          className="overlay-scrollbar__thumb overlay-scrollbar__thumb--horizontal"
          style={{
            width: `${horizontal.length}px`,
            left: `${trackInset + horizontal.offset}px`,
            bottom: `${trackInset / 2}px`,
          }}
          onPointerDown={(e) => handlePointerDown(e, "horizontal")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      )}
    </div>
  );
};
