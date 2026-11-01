import React from 'react';
import { flushSync } from 'react-dom';

/**
 * Renders a long Markdown document a block at a time: only the blocks within
 * a viewport of the visible part are mounted, the rest stand as empty boxes
 * of the height and edge margins they had (an estimate until first drawn).
 * A 340 KB changelog parsed and mounted whole cost 470 ms to open, and its
 * thousands of nodes were laid out and, with an accessibility client on,
 * serialized again on every frame of a panel resize.
 *
 * Whatever reads the whole rendered document holds every block mounted while
 * it does (`holdMarkdownBlocks`): the find bar, heading links. A selection
 * keeps the blocks it reached mounted, so its ends never leave the DOM, and
 * one over blocks not mounted (select-all, a shift-click far away) mounts
 * them all until it collapses. A block the reader opened or plays stays.
 */

const INITIAL_BLOCKS = 24;
export const BLOCK_INDEX = 'data-oc-block-index';
export const BLOCK_KEY = 'data-oc-block-key';

export type BlockSize = { height: number; start: number; end: number };

const scrollerOf = (element: HTMLElement): HTMLElement | null => {
  const view = element.ownerDocument.defaultView;
  for (let node = element.parentElement; node && view; node = node.parentElement) {
    if (/auto|scroll/.test(view.getComputedStyle(node).overflowY)) return node;
  }
  return null;
};

const marginOf = (element: Element | null, side: 'marginBlockStart' | 'marginBlockEnd'): number => {
  if (!element) return 0;
  const value = Number.parseFloat(element.ownerDocument.defaultView?.getComputedStyle(element)[side] ?? '');
  return Number.isFinite(value) ? value : 0;
};

const playing = (wrapper: HTMLElement): boolean => Array.from(wrapper.querySelectorAll('video, audio'))
  .some((media) => media instanceof HTMLMediaElement && !media.paused);

/** Identifies a block's content at its place, for its measured size and kept state. */
export const blockKey = (index: number, content: string): string => {
  let hash = 5381;
  for (let position = 0; position < content.length; position += 1) hash = ((hash << 5) + hash + content.charCodeAt(position)) | 0;
  return `${index}:${content.length}:${hash >>> 0}`;
};

const windows = new WeakMap<Element, MarkdownWindow>();

export class MarkdownWindow {
  private container: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  // Before it is attached, the first blocks render: the top of the document
  // paints in the first frame.
  private attached = false;
  private near = new Set<number>();
  private pins = new Map<number, number>();
  private holds = 0;
  private selecting = false;
  private selectionRelease: (() => void) | null = null;
  private sizes = new Map<string, BlockSize>();
  // Blocks whose disclosure the reader toggled.
  private kept = new Set<string>();
  private listeners = new Set<() => void>();
  private stop: (() => void) | null = null;
  charsPerLine = 80;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  isRendered(index: number): boolean {
    if (!this.attached) return index < INITIAL_BLOCKS;
    return !this.scroller || this.holds > 0 || this.near.has(index) || this.pins.has(index);
  }

  size(key: string): BlockSize | undefined {
    return this.sizes.get(key);
  }

  attach(container: HTMLElement) {
    this.detach();
    this.container = container;
    this.scroller = scrollerOf(container);
    this.attached = true;
    windows.set(container, this);
    const scroller = this.scroller;
    if (!scroller) {
      this.notify();
      return;
    }
    const doc = container.ownerDocument;
    const update = () => this.update();
    const resize = globalThis.ResizeObserver ? new ResizeObserver(() => {
      this.charsPerLine = Math.max(20, Math.round(scroller.clientWidth / 7.5));
      this.update();
    }) : null;
    resize?.observe(scroller);
    this.charsPerLine = Math.max(20, Math.round(scroller.clientWidth / 7.5));
    const selectionChange = () => {
      const selection = doc.getSelection();
      const range = selection && !selection.isCollapsed && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const selecting = Boolean(range && (container.contains(range.commonAncestorContainer) || range.intersectsNode(container)));
      // A selection over blocks still unmounted (select-all, a shift-click
      // far away) would copy their empty boxes: every block mounts, into the
      // same wrappers, until it collapses.
      if (range && selecting && !this.selectionRelease && this.spansUnmounted(range)) {
        this.selectionRelease = this.hold(undefined);
      } else if (!selecting && this.selectionRelease) {
        this.selectionRelease();
        this.selectionRelease = null;
      }
      if (selecting === this.selecting) return;
      this.selecting = selecting;
      if (!selecting) this.update();
    };
    // A click on a summary (a key press on one clicks it too) is the reader
    // toggling it; `toggle` also fires for a disclosure inserted open.
    const click = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('summary')) return;
      const key = event.target.closest(`[${BLOCK_INDEX}]`)?.getAttribute(BLOCK_KEY);
      if (key) this.kept.add(key);
    };
    scroller.addEventListener('scroll', update, { passive: true });
    container.addEventListener('click', click, true);
    doc.addEventListener('selectionchange', selectionChange);
    this.stop = () => {
      resize?.disconnect();
      scroller.removeEventListener('scroll', update);
      container.removeEventListener('click', click, true);
      doc.removeEventListener('selectionchange', selectionChange);
    };
  }

  detach() {
    this.stop?.();
    this.stop = null;
    if (this.container) windows.delete(this.container);
    this.container = null;
    this.scroller = null;
    this.selectionRelease = null;
    this.selecting = false;
  }

  /** Keeps one block (`index`) or, without one, every block mounted until released. */
  hold(index: number | undefined, sync = false): () => void {
    if (index === undefined) this.holds += 1;
    else this.pins.set(index, (this.pins.get(index) ?? 0) + 1);
    this.notify(sync);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (index === undefined) this.holds -= 1;
      else {
        const count = (this.pins.get(index) ?? 1) - 1;
        if (count > 0) this.pins.set(index, count);
        else this.pins.delete(index);
      }
      this.update();
      this.notify();
    };
  }

  /** Mounts the blocks within a viewport of the visible part and lets the rest go. */
  update() {
    const container = this.container;
    const scroller = this.scroller;
    const root = container?.querySelector('[data-oc-streamdown]');
    if (!container || !scroller || !root) return;
    const wrappers = Array.from(root.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute(BLOCK_INDEX));
    const view = scroller.getBoundingClientRect();
    const from = view.top - view.height;
    const to = view.bottom + view.height;
    let low = 0;
    let high = wrappers.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (wrappers[middle].getBoundingClientRect().bottom < from) low = middle + 1;
      else high = middle;
    }
    const next = new Set<number>();
    for (let index = low; index < wrappers.length; index += 1) {
      if (wrappers[index].getBoundingClientRect().top > to) break;
      next.add(Number(wrappers[index].getAttribute(BLOCK_INDEX)));
    }
    if (this.selecting) for (const index of this.near) next.add(index);
    // A block about to unmount is measured as it leaves, so its empty box
    // keeps its place exactly.
    // One whose disclosure the reader toggled, or that plays a video, stays:
    // mounted again, it would come back as its source has it, or from the
    // start.
    if (this.holds === 0) {
      for (const wrapper of wrappers) {
        const index = Number(wrapper.getAttribute(BLOCK_INDEX));
        if (next.has(index) || this.pins.has(index)) continue;
        if (this.isLive(wrapper)) next.add(index);
        else this.measure(wrapper);
      }
    }
    const changed = next.size !== this.near.size || [...next].some((index) => !this.near.has(index));
    this.near = next;
    if (changed) this.notify();
  }

  private isLive(wrapper: HTMLElement): boolean {
    if (wrapper.hasAttribute('data-oc-block-placeholder')) return false;
    const key = wrapper.getAttribute(BLOCK_KEY);
    return (key !== null && this.kept.has(key)) || playing(wrapper);
  }

  // Whether a selection between its ends crosses a block not mounted.
  private spansUnmounted(range: Range): boolean {
    const indexOf = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement;
      const wrapper = element?.closest(`[${BLOCK_INDEX}]`);
      return wrapper && this.container?.contains(wrapper) ? Number(wrapper.getAttribute(BLOCK_INDEX)) : null;
    };
    const start = indexOf(range.startContainer);
    const end = indexOf(range.endContainer);
    if (start === null || end === null) {
      return Boolean(this.container?.querySelector('[data-oc-block-placeholder]'));
    }
    for (let index = start; index <= end; index += 1) if (!this.isRendered(index)) return true;
    return false;
  }

  private measure(wrapper: HTMLElement) {
    const key = wrapper.getAttribute(BLOCK_KEY);
    if (!key || wrapper.hasAttribute('data-oc-block-placeholder')) return;
    // Its content's edge margins collapse through the wrapper; the empty box
    // carries them itself, so it collapses with its neighbours the same way.
    this.sizes.set(key, {
      height: wrapper.getBoundingClientRect().height,
      start: marginOf(wrapper.firstElementChild, 'marginBlockStart'),
      end: marginOf(wrapper.lastElementChild, 'marginBlockEnd'),
    });
  }

  private notify(sync = false) {
    const run = () => { for (const listener of this.listeners) listener(); };
    if (sync) flushSync(run);
    else run();
  }
}

/**
 * Keeps every block of the windowed document holding `element` mounted, or
 * only `block` (one of its blocks), until the returned release. `sync` mounts
 * them before returning; only from an event handler.
 */
export const holdMarkdownBlocks = (element: Element, options: { block?: Element; sync?: boolean } = {}): (() => void) => {
  const container = element.closest('[data-markdown-content]') ?? element.querySelector('[data-markdown-content]');
  const owner = container ? windows.get(container) : undefined;
  if (!owner) return () => {};
  const index = options.block?.getAttribute(BLOCK_INDEX);
  return owner.hold(index === null || index === undefined ? undefined : Number(index), options.sync);
};

export const MarkdownWindowContext = React.createContext<MarkdownWindow | null>(null);
