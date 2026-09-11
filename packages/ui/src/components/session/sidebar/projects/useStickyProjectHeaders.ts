import React from 'react';

type Args = {
  enabled?: boolean;
  isDesktopShellRuntime: boolean;
  projectSections: unknown[];
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
};

export const useStickyProjectHeaders = (args: Args): Set<string> => {
  const { enabled = true, isDesktopShellRuntime, projectSections, projectHeaderSentinelRefs } = args;
  const [stuckProjectHeaders, setStuckProjectHeaders] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!enabled || !isDesktopShellRuntime) {
      setStuckProjectHeaders((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    const firstSentinel = Array.from(projectHeaderSentinelRefs.current.values()).find((el) => el !== null);
    const root = firstSentinel?.closest<HTMLElement>('.oc-sidebar-scroller') ?? null;
    if (!root) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setStuckProjectHeaders((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const projectId = (entry.target as HTMLElement).dataset.projectId;
            if (!projectId) continue;

            const rootTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top;
            const isAboveScroller = !entry.isIntersecting && entry.boundingClientRect.top < rootTop;
            if (next.has(projectId) === isAboveScroller) continue;

            changed = true;
            if (isAboveScroller) next.add(projectId);
            else next.delete(projectId);
          }
          return changed ? next : prev;
        });
      },
      { root, threshold: 0 },
    );

    projectHeaderSentinelRefs.current.forEach((el) => {
      if (el) {
        observer.observe(el);
      }
    });

    return () => observer.disconnect();
  }, [enabled, isDesktopShellRuntime, projectHeaderSentinelRefs, projectSections]);

  return stuckProjectHeaders;
};
