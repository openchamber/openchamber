import React from 'react';
import { cancelWhenLayoutSettled, isLayoutAnimating, onLayoutAnimationStart, onWidthDragStart, runWhenLayoutSettled } from '@/lib/layoutAnimation';

const GROW_STEP = 240;

export const pinnedPageWidth = (pinned: number | null, settled: number, stage: number): number => {
  const held = pinned ?? settled;
  return stage <= held ? held : Math.ceil(stage) + GROW_STEP;
};

export const pageWidthAtStart = (settled: number, zoneFrom: number | null, zoneTo: number | null): number => {
  const growth = zoneFrom !== null && zoneTo !== null ? zoneTo - zoneFrom : 0;
  return growth > 0 ? settled + growth : settled;
};

const DRAG_REST_MS = 90;

type StageSize = { width: number; height: number };

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
    const zoneSize = (): number | null => {
      const zone = stage.closest<HTMLElement>('[data-context-panel]');
      if (!zone || zone.dataset.contextZone === 'bottom') return null;
      const size = Number(zone.dataset.zoneSize);
      return size > 0 ? size : null;
    };
    let settledZoneSize = zoneSize();
    let dragging = false;
    let restTimer: ReturnType<typeof setTimeout> | null = null;
    const fitAtRest = () => {
      restTimer = null;
      const page = pageRef.current;
      if (!page || sizedRef.current || !latest) return;
      pinned = latest.width;
      page.style.width = `${pinned}px`;
    };

    const settle = () => {
      dragging = false;
      if (restTimer !== null) clearTimeout(restTimer);
      restTimer = null;
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
      if (dragging) {
        if (restTimer !== null) clearTimeout(restTimer);
        restTimer = setTimeout(fitAtRest, DRAG_REST_MS);
      } else if (isLayoutAnimating() && page && !sizedRef.current) {
        const final = pageWidthAtStart(settledWidth, settledZoneSize, zoneSize());
        const next = pinnedPageWidth(Math.max(pinned ?? settledWidth, final), settledWidth, rect.width);
        if (next !== pinned) {
          pinned = next;
          page.style.width = `${next}px`;
        }
      }
      runWhenLayoutSettled(settle);
    });
    observer.observe(stage);
    const stopListening = onLayoutAnimationStart(() => {
      const page = pageRef.current;
      if (!page || sizedRef.current || settledWidth === 0 || pinned !== null) return;
      pinned = pageWidthAtStart(settledWidth, settledZoneSize, zoneSize());
      page.style.width = `${pinned}px`;
      runWhenLayoutSettled(settle);
    });
    const stopListeningToDrags = onWidthDragStart(() => {
      dragging = true;
    });
    return () => {
      stopListening();
      stopListeningToDrags();
      if (restTimer !== null) clearTimeout(restTimer);
      observer.disconnect();
      cancelWhenLayoutSettled(settle);
    };
  }, [pageRef, stageRef]);

  return stageSize;
};
