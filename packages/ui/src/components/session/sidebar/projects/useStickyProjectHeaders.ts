import React from 'react';

type Args = {
  enabled?: boolean;
  isDesktopShellRuntime: boolean;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  refreshKey?: number | string;
};

type StickySentinelResolver = () => ReadonlyMap<string, HTMLElement | null>;

type StickySentinelObserverArgs = {
  enabled: boolean;
  rootRef: React.RefObject<HTMLElement | null>;
  resolveSentinels: StickySentinelResolver;
  refreshKey?: number | string;
};

type StickySentinelObservation = {
  key: string;
  order: number;
  top: number;
  isAboveScroller: boolean;
};

const clearStickyHeaders = (setStuckHeaders: React.Dispatch<React.SetStateAction<Set<string>>>): void => {
  setStuckHeaders((previous) => (previous.size === 0 ? previous : new Set()));
};

const compareStickySentinels = (
  first: StickySentinelObservation,
  second: StickySentinelObservation,
): number => {
  // The current DOM order is authoritative for sentinels rendered in the
  // stable scrolling root. Geometry and key tie-breakers keep selection
  // deterministic for sentinels that need the resolver-order fallback.
  if (first.order !== second.order) return first.order - second.order;
  if (first.top !== second.top) return first.top - second.top;
  if (first.key === second.key) return 0;
  return first.key < second.key ? -1 : 1;
};

const STICKY_SENTINEL_SELECTOR = '[data-project-id], [data-sidebar-activity-start]';

const getCurrentSentinelDomOrder = (root: HTMLElement): ReadonlyMap<Element, number> => {
  const order = new Map<Element, number>();
  root.querySelectorAll<HTMLElement>(STICKY_SENTINEL_SELECTOR).forEach((element, index) => {
    order.set(element, index);
  });
  return order;
};

const selectLatestStuckHeader = (
  observations: ReadonlyMap<Element, StickySentinelObservation>,
): string | null => {
  let latest: StickySentinelObservation | null = null;
  for (const observation of observations.values()) {
    if (!observation.isAboveScroller) continue;
    if (!latest || compareStickySentinels(observation, latest) > 0) latest = observation;
  }
  return latest?.key ?? null;
};

/**
 * Observe temporary virtualized sentinels from the stable scrolling element.
 * The root owns the observer lifecycle; sentinels may appear, disappear, or
 * be replaced as virtualization changes the mounted window.
 */
export const useStickySentinelObserver = (args: StickySentinelObserverArgs): Set<string> => {
  const {
    enabled,
    rootRef,
    resolveSentinels,
    refreshKey = 0,
  } = args;
  const [stuckHeaders, setStuckHeaders] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    clearStickyHeaders(setStuckHeaders);
    if (!enabled) {
      return;
    }

    const root = rootRef.current;
    if (!root) {
      return;
    }

    let disposed = false;
    let selectedKey: string | null = null;
    let observedSentinels = new Map<Element, StickySentinelObservation>();
    let intersectionObserver: IntersectionObserver | null = null;

    const publishSelectedKey = (nextKey: string | null): void => {
      if (selectedKey === nextKey) return;
      selectedKey = nextKey;
      setStuckHeaders(nextKey === null ? new Set() : new Set([nextKey]));
    };

    const findObservedSentinel = (key: string): StickySentinelObservation | null => {
      for (const observation of observedSentinels.values()) {
        if (observation.key === key) return observation;
      }
      return null;
    };

    const resolveCurrentSentinels = (): Map<Element, { key: string; order: number }> => {
      const currentSentinels = new Map<Element, { key: string; order: number }>();
      const currentDomOrder = getCurrentSentinelDomOrder(root);
      let fallbackOrder = currentDomOrder.size;
      for (const [key, element] of resolveSentinels()) {
        if (element && root.contains(element)) {
          const order = currentDomOrder.get(element) ?? fallbackOrder++;
          currentSentinels.set(element, { key, order });
        }
      }
      return currentSentinels;
    };

    const syncObservedSentinels = (): void => {
      if (disposed) return;
      if (rootRef.current !== root) {
        observedSentinels = new Map();
        publishSelectedKey(null);
        return;
      }

      const currentSentinels = resolveCurrentSentinels();
      let currentSelectedElement: Element | null = null;
      if (selectedKey !== null) {
        for (const [element, sentinel] of currentSentinels) {
          if (sentinel.key === selectedKey) {
            currentSelectedElement = element;
            break;
          }
        }
      }
      for (const [element, observation] of observedSentinels) {
        const currentKey = currentSentinels.get(element)?.key;
        if (currentKey === observation.key) continue;
        intersectionObserver?.unobserve(element);
      }

      const nextObservedSentinels = new Map<Element, StickySentinelObservation>();
      let hasNewStuckSentinel = false;
      for (const [element, sentinel] of currentSentinels) {
        const previous = observedSentinels.get(element);
        if (previous?.key === sentinel.key) {
          nextObservedSentinels.set(element, { ...previous, order: sentinel.order });
          continue;
        }

        intersectionObserver?.observe(element);
        const top = element.getBoundingClientRect().top;
        const rootTop = root.getBoundingClientRect().top;
        const observation = {
          key: sentinel.key,
          order: sentinel.order,
          top,
          isAboveScroller: top < rootTop,
        } satisfies StickySentinelObservation;
        nextObservedSentinels.set(element, observation);
        if (observation.isAboveScroller) hasNewStuckSentinel = true;
      }
      observedSentinels = nextObservedSentinels;

      const latestStuckKey = selectLatestStuckHeader(observedSentinels);
      const selectedKeyWasEvicted = selectedKey !== null && currentSelectedElement === null;
      if (latestStuckKey !== null && (!selectedKeyWasEvicted || hasNewStuckSentinel)) {
        publishSelectedKey(latestStuckKey);
        return;
      }

      if (selectedKeyWasEvicted) return;

      const currentSelected = selectedKey === null ? null : findObservedSentinel(selectedKey);
      if (currentSelected && !currentSelected.isAboveScroller) {
        publishSelectedKey(null);
      }
    };

    intersectionObserver = globalThis.IntersectionObserver
      ? new IntersectionObserver((entries) => {
        if (disposed) return;
        syncObservedSentinels();
        if (rootRef.current !== root) return;

        for (const entry of entries) {
          const observation = observedSentinels.get(entry.target);
          if (!observation || !root.contains(entry.target)) continue;

          const rootTop = entry.rootBounds?.top ?? root.getBoundingClientRect().top;
          observation.top = entry.boundingClientRect.top;
          observation.isAboveScroller = !entry.isIntersecting && observation.top < rootTop;
        }

        const latestStuckKey = selectLatestStuckHeader(observedSentinels);
        if (latestStuckKey !== null) {
          publishSelectedKey(latestStuckKey);
          return;
        }

        const currentSelected = selectedKey === null ? null : findObservedSentinel(selectedKey);
        if (currentSelected && !currentSelected.isAboveScroller) publishSelectedKey(null);
      }, { root, threshold: 0 })
      : null;

    syncObservedSentinels();
    const mutationObserver = globalThis.MutationObserver
      ? new MutationObserver(syncObservedSentinels)
      : null;
    mutationObserver?.observe(root, {
      attributes: true,
      attributeFilter: ['data-project-id', 'data-sidebar-activity-start'],
      childList: true,
      subtree: true,
    });

    return () => {
      disposed = true;
      mutationObserver?.disconnect();
      intersectionObserver?.disconnect();
      clearStickyHeaders(setStuckHeaders);
    };
  }, [enabled, refreshKey, resolveSentinels, rootRef]);

  return stuckHeaders;
};

export const useStickyProjectHeaders = (args: Args): Set<string> => {
  const {
    enabled = true,
    isDesktopShellRuntime,
    projectHeaderSentinelRefs,
    scrollContainerRef,
    refreshKey = 0,
  } = args;
  const resolveProjectSentinels = React.useCallback(
    (): ReadonlyMap<string, HTMLElement | null> => projectHeaderSentinelRefs.current,
    [projectHeaderSentinelRefs],
  );

  return useStickySentinelObserver({
    enabled: enabled && isDesktopShellRuntime,
    rootRef: scrollContainerRef,
    resolveSentinels: resolveProjectSentinels,
    refreshKey,
  });
};
