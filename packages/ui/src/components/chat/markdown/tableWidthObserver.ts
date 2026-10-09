// One ResizeObserver serves every rendered message that contains a table, so
// a long transcript does not create an observer per message.

type Watch = { width: number | null; onWidthChange: () => void };

const watches = new Map<Element, Watch>();
let sharedObserver: ResizeObserver | null = null;

const ensureObserver = (): ResizeObserver | null => {
  if (sharedObserver) return sharedObserver;
  const ResizeObserverConstructor = globalThis.ResizeObserver;
  if (!ResizeObserverConstructor) return null;
  sharedObserver = new ResizeObserverConstructor((entries) => {
    for (const entry of entries) {
      const watch = watches.get(entry.target);
      if (!watch) continue;
      const { width } = entry.contentRect;
      if (width === watch.width) continue;
      // The first entry reports the width the tables were just laid out in.
      const initial = watch.width === null;
      watch.width = width;
      if (!initial) watch.onWidthChange();
    }
  });
  return sharedObserver;
};

/** Calls onWidthChange whenever the target's width changes; height changes are ignored. */
export const observeMarkdownTableWidth = (target: HTMLElement, onWidthChange: () => void): (() => void) => {
  const observer = ensureObserver();
  if (!observer) return () => {};
  watches.set(target, { width: null, onWidthChange });
  observer.observe(target);
  return () => {
    if (!watches.delete(target)) return;
    observer.unobserve(target);
    if (watches.size > 0) return;
    observer.disconnect();
    sharedObserver = null;
  };
};
