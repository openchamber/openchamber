import React from "react";
import { OverlayScrollbar, type OverlayScrollbarProps } from "./OverlayScrollbar";

type AttachedOverlayScrollbarProps = Omit<OverlayScrollbarProps, "containerRef"> & {
  /** The scrolling element, once its owner has created it. */
  scroller: HTMLElement | null;
};

/**
 * The app's overlay scrollbar for a scroller a library creates and owns, such
 * as CodeMirror's `.cm-scroller`, which `ScrollableOverlay` cannot wrap. It
 * hides the scroller's native bar and draws the thumb over the nearest
 * positioned ancestor, which must share the scroller's top and right edges.
 */
export function AttachedOverlayScrollbar({ scroller, ...props }: AttachedOverlayScrollbarProps) {
  const containerRef = React.useMemo(() => ({ current: scroller }), [scroller]);

  React.useLayoutEffect(() => {
    if (!scroller) return;
    scroller.classList.add("overlay-scrollbar-target");
    return () => scroller.classList.remove("overlay-scrollbar-target");
  }, [scroller]);

  return <OverlayScrollbar containerRef={containerRef} {...props} />;
}

/**
 * The overlay scrollbar for a popup that scrolls itself, such as a dialog
 * window or a menu: content inside it would scroll along. Rendered as the
 * popup's sibling in the same positioned parent, it keeps a frame on the
 * popup's box. Offsets, unlike client rects, ignore the popup's open and
 * close scale, so the frame lands where the popup comes to rest.
 */
export function PopupOverlayScrollbar({ scroller, ...props }: AttachedOverlayScrollbarProps) {
  const frameRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!scroller || !frame) return;
    const follow = () => {
      frame.style.top = `${scroller.offsetTop}px`;
      frame.style.left = `${scroller.offsetLeft}px`;
      frame.style.width = `${scroller.offsetWidth}px`;
      frame.style.height = `${scroller.offsetHeight}px`;
    };
    follow();
    // The popup's own size, and the parent's, which re-centres or re-places it.
    const observer = globalThis.ResizeObserver ? new ResizeObserver(follow) : null;
    observer?.observe(scroller);
    if (scroller.offsetParent) observer?.observe(scroller.offsetParent);
    return () => observer?.disconnect();
  }, [scroller]);

  return (
    <div ref={frameRef} aria-hidden="true" className="pointer-events-none absolute">
      <AttachedOverlayScrollbar scroller={scroller} {...props} />
    </div>
  );
}
