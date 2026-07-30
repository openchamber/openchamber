import React from 'react';

type Args = {
  enabled?: boolean;
  isDesktopShellRuntime: boolean;
  projectSections: unknown[];
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
};

type StickyHeaderArgs = {
  enabled: boolean;
  isDesktopShellRuntime: boolean;
};

export const useStickyHeader = (args: StickyHeaderArgs) => {
  const { enabled, isDesktopShellRuntime } = args;
  const [sentinel, setSentinel] = React.useState<HTMLDivElement | null>(null);
  const [isStuck, setIsStuck] = React.useState(false);

  const sentinelRef = React.useCallback((node: HTMLDivElement | null) => {
    setSentinel(node);
  }, []);

  React.useEffect(() => {
    if (!enabled || !isDesktopShellRuntime || !sentinel) {
      setIsStuck(false);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIsStuck(entry.intersectionRatio < 1);
    }, { threshold: 1 });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, isDesktopShellRuntime, sentinel]);

  return { isStuck, sentinelRef };
};

export const useStickyProjectHeaders = (args: Args): Set<string> => {
  const { enabled = true, isDesktopShellRuntime, projectSections, projectHeaderSentinelRefs } = args;
  const [stuckProjectHeaders, setStuckProjectHeaders] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (enabled && isDesktopShellRuntime) {
      return;
    }

    setStuckProjectHeaders((prev) => (prev.size === 0 ? prev : new Set()));
  }, [enabled, isDesktopShellRuntime]);

  React.useEffect(() => {
    if (!enabled || !isDesktopShellRuntime) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const projectId = (entry.target as HTMLElement).dataset.projectId;
          if (!projectId) {
            return;
          }

          setStuckProjectHeaders((prev) => {
            if (!entry.isIntersecting) {
              if (prev.has(projectId)) return prev;
              const next = new Set(prev);
              next.add(projectId);
              return next;
            }

            if (!prev.has(projectId)) return prev;
            const next = new Set(prev);
            next.delete(projectId);
            return next;
          });
        });
      },
      { threshold: 0 },
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
