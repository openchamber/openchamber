import React from "react";
import { OverlayScrollbar, type OverlayScrollbarProps } from "./OverlayScrollbar";

type AttachedOverlayScrollbarProps = Omit<OverlayScrollbarProps, "containerRef"> & {
  scroller: HTMLElement | null;
};

export function AttachedOverlayScrollbar({ scroller, ...props }: AttachedOverlayScrollbarProps) {
  const containerRef = React.useMemo(() => ({ current: scroller }), [scroller]);

  React.useLayoutEffect(() => {
    if (!scroller) return;
    scroller.classList.add("overlay-scrollbar-target");
    return () => scroller.classList.remove("overlay-scrollbar-target");
  }, [scroller]);

  return <OverlayScrollbar containerRef={containerRef} {...props} />;
}

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
