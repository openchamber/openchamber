import {
  Virtualizer,
  type FileDiff as PierreFileDiff,
  type VirtualFileMetrics,
} from '@pierre/diffs';
import type { DiffAnnotation } from './types';

export type SharedVirtualizer = {
  virtualizer: Virtualizer;
  root: Document | HTMLElement;
  release: () => void;
};

type VirtualizerTarget = {
  key: Document | HTMLElement;
  root: Document | HTMLElement;
  content: HTMLElement | undefined;
};

type VirtualizerEntry = {
  virtualizer: Virtualizer;
  refs: number;
};

const virtualizerCache = new WeakMap<Document | HTMLElement, VirtualizerEntry>();

export const DEFAULT_DIFF_LINE_HEIGHT = 24;

export function diffVirtualMetrics(lineHeight: number): Partial<VirtualFileMetrics> {
  return {
    lineHeight,
    hunkSeparatorHeight: 24,
    spacing: 0,
  };
}

function resolveVirtualizerTarget(container: HTMLElement): VirtualizerTarget {
  const root = container.closest('[data-diff-virtual-root]');
  if (root instanceof HTMLElement) {
    const content = root.querySelector('[data-diff-virtual-content]');
    return {
      key: root,
      root,
      content: content instanceof HTMLElement ? content : undefined,
    };
  }

  return {
    key: document,
    root: document,
    content: undefined,
  };
}

export function acquireSharedVirtualizer(container: HTMLElement): SharedVirtualizer | null {
  if (typeof document === 'undefined') return null;

  const target = resolveVirtualizerTarget(container);
  let entry = virtualizerCache.get(target.key);

  if (!entry) {
    const virtualizer = new Virtualizer();
    virtualizer.setup(target.root, target.content);
    entry = { virtualizer, refs: 0 };
    virtualizerCache.set(target.key, entry);
  }

  entry.refs += 1;
  let released = false;

  return {
    virtualizer: entry.virtualizer,
    root: target.root,
    release: () => {
      if (released) return;
      released = true;

      const current = virtualizerCache.get(target.key);
      if (!current) return;

      current.refs -= 1;
      if (current.refs > 0) return;

      current.virtualizer.cleanUp();
      virtualizerCache.delete(target.key);
    },
  };
}

export const wakeVirtualizer = (
  instance: PierreFileDiff<DiffAnnotation>,
  sharedVirtualizer: SharedVirtualizer | null,
  forceUpdate: () => void,
): (() => void) => {
  if (typeof window === 'undefined') return () => {};

  const frameIds: number[] = [];
  const run = () => {
    try {
      instance.rerender();
    } catch {
      // ignored
    }

    const root = sharedVirtualizer?.root;
    if (root instanceof HTMLElement) {
      root.dispatchEvent(new Event('scroll', { bubbles: false }));
    } else {
      document.dispatchEvent(new Event('scroll', { bubbles: false }));
    }

    window.dispatchEvent(new Event('resize'));
    forceUpdate();
  };

  frameIds.push(window.requestAnimationFrame(run));
  frameIds.push(window.requestAnimationFrame(() => {
    frameIds.push(window.requestAnimationFrame(run));
  }));

  return () => {
    for (const frameId of frameIds) {
      window.cancelAnimationFrame(frameId);
    }
  };
};
