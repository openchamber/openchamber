import React from 'react';
import { cancelWhenLayoutSettled, isLayoutAnimating, onLayoutAnimationStart, runWhenLayoutSettled } from '@/lib/layoutAnimation';

/**
 * How far past the stage the page is laid out when the stage outgrows it
 * mid-animation, so the next frames of growth fit without another resize.
 */
const GROW_STEP = 240;

/**
 * The width the page keeps while its stage is being animated or dragged:
 * what it held (`pinned`, else the width it had when the stage last rested)
 * for as long as the stage fits inside that, else the stage's width and a
 * step more.
 */
export const pinnedPageWidth = (pinned: number | null, settled: number, stage: number): number => {
  const held = pinned ?? settled;
  return stage <= held ? held : Math.ceil(stage) + GROW_STEP;
};

/**
 * The width the page takes as an animation starts: the one the stage will
 * have at its end when the zone is growing and says how far (`zoneFrom` to
 * `zoneTo`, its size before and its target), so the page is resized once,
 * before anything moves. Otherwise the width it has.
 */
export const pageWidthAtStart = (settled: number, zoneFrom: number | null, zoneTo: number | null): number => {
  const growth = zoneFrom !== null && zoneTo !== null ? zoneTo - zoneFrom : 0;
  return growth > 0 ? settled + growth : settled;
};

type StageSize = { width: number; height: number };

/**
 * The browser stage's size, and a page that is not resized on every frame
 * its stage moves.
 *
 * A `<webview>` page lives in another process. Each new size waits for that
 * process to draw a frame at it, and the app's own frame waits with it: a
 * panel that expanded or was dragged with a site open resized the page on
 * every frame, and the app drew 3 to 5 frames of an animation's 15. So while
 * a side column animates or is dragged (`lib/layoutAnimation`), the page
 * holds a fixed width at the stage's start edge and the stage clips it:
 * unchanged while the stage shrinks, one step wider when the stage outgrows
 * it. It is pinned from the animation's start, before the first frame moves
 * the stage: at the stage's final width when the zone grows to a size it
 * already knows (an expand), so the page is resized once and nothing snaps
 * at the end. A drag has no final size, so there the step applies. It takes the stage's width again once the layout settles, which is
 * also when the size is published as state, so the pane does not re-render
 * per frame either.
 *
 * `sized` is a viewport of a chosen size: its page has its own fixed width
 * and only its scale follows the stage, so it is never pinned.
 */
export const useSteadyStage = (
  stageRef: React.RefObject<HTMLElement | null>,
  pageRef: React.RefObject<HTMLElement | null>,
  sized: boolean,
): StageSize => {
  const [stageSize, setStageSize] = React.useState<StageSize>({ width: 0, height: 0 });
  const sizedRef = React.useRef(sized);
  sizedRef.current = sized;

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !globalThis.ResizeObserver) return undefined;
    let latest: StageSize | null = null;
    let settledWidth = 0;
    let pinned: number | null = null;
    // The side zone the stage sits in publishes the size it is at or
    // animating to (`data-zone-size`, ContextPanel). The bottom zone's size
    // is a height, which the page's width does not follow.
    const zoneSize = (): number | null => {
      const zone = stage.closest<HTMLElement>('[data-context-panel]');
      if (!zone || zone.dataset.contextZone === 'bottom') return null;
      const size = Number(zone.dataset.zoneSize);
      return size > 0 ? size : null;
    };
    let settledZoneSize = zoneSize();

    const settle = () => {
      if (pinned !== null) {
        pinned = null;
        if (pageRef.current && !sizedRef.current) pageRef.current.style.width = '100%';
      }
      settledZoneSize = zoneSize();
      if (!latest) return;
      const next = latest;
      settledWidth = next.width;
      setStageSize((current) => (current.width === next.width && current.height === next.height ? current : next));
    };

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      latest = { width: rect.width, height: rect.height };
      if (settledWidth === 0) settledWidth = rect.width;
      const page = pageRef.current;
      if (isLayoutAnimating() && page && !sizedRef.current) {
        const next = pinnedPageWidth(pinned, settledWidth, rect.width);
        if (next !== pinned) {
          pinned = next;
          page.style.width = `${next}px`;
        }
      }
      runWhenLayoutSettled(settle);
    });
    observer.observe(stage);
    // Pinned before the animation's first frame, at the width the page has:
    // left at 100% until the observer's first callback, it followed the
    // stage for that one frame, which is one resize more.
    const stopListening = onLayoutAnimationStart(() => {
      const page = pageRef.current;
      if (!page || sizedRef.current || settledWidth === 0 || pinned !== null) return;
      pinned = pageWidthAtStart(settledWidth, settledZoneSize, zoneSize());
      page.style.width = `${pinned}px`;
      runWhenLayoutSettled(settle);
    });
    return () => {
      stopListening();
      observer.disconnect();
      cancelWhenLayoutSettled(settle);
    };
  }, [pageRef, stageRef]);

  return stageSize;
};
