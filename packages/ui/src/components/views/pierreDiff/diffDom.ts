const isScrollable = (value: string): boolean =>
  value === 'auto' || value === 'scroll' || value === 'overlay';

const findScrollParent = (node: HTMLElement | null): HTMLElement | null => {
  let current = node?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isScrollable(style.overflowY)) return current;
    current = current.parentElement;
  }
  return null;
};

export const preserveScrollPosition = (wrapper: HTMLElement | null, container: HTMLElement | null): (() => void) => {
  if (!wrapper || !container || typeof window === 'undefined') return () => {};

  const scrollParent = findScrollParent(wrapper);
  if (!scrollParent) return () => {};

  const height = container.getBoundingClientRect().height;
  if (!height) return () => {};

  const top = wrapper.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top;
  const previousMinHeight = container.style.minHeight;
  container.style.minHeight = `${Math.ceil(height)}px`;

  let done = false;
  return () => {
    if (done) return;
    done = true;
    container.style.minHeight = previousMinHeight;

    const nextTop = wrapper.getBoundingClientRect().top - scrollParent.getBoundingClientRect().top;
    const delta = nextTop - top;
    if (delta) {
      scrollParent.scrollTop += delta;
    }
  };
};

export const waitForDiffReady = (
  container: HTMLElement,
  onReady: () => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => {};

  let frameId: number | null = null;
  let observer: MutationObserver | null = null;
  let cancelled = false;

  const finish = () => {
    if (cancelled) return;
    observer?.disconnect();
    observer = null;
    frameId = window.requestAnimationFrame(() => {
      frameId = window.requestAnimationFrame(() => {
        if (!cancelled) onReady();
      });
    });
  };

  const getRoot = (): ShadowRoot | undefined => {
    const host = container.querySelector('diffs-container');
    return host?.shadowRoot ?? undefined;
  };

  const isReady = (root = getRoot()) => {
    return Boolean(root?.querySelector('[data-line]'));
  };

  if (isReady()) {
    finish();
  } else if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      const root = getRoot();
      if (!root) return;
      if (isReady(root)) {
        finish();
        return;
      }
      observer?.disconnect();
      observer = new MutationObserver(() => {
        if (isReady(root)) {
          finish();
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    });
    observer.observe(container, { childList: true, subtree: true });
  } else {
    frameId = window.requestAnimationFrame(finish);
  }

  return () => {
    cancelled = true;
    observer?.disconnect();
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
    }
  };
};

export const getDiffShadowRoot = (container: HTMLElement | null): ShadowRoot | null => {
  const host = container?.querySelector('diffs-container');
  return host?.shadowRoot ?? null;
};
