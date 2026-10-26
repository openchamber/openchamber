import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { bindStickyScrollbar } from './stickyScrollbarBinding';

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];

  private readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  disconnect(): void {
    this.observed.clear();
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  trigger(): void {
    this.callback([], this);
  }
}

const setWidths = (column: HTMLElement, clientWidth: number, scrollWidth: number) => {
  Object.defineProperty(column, 'clientWidth', { configurable: true, get: () => clientWidth });
  Object.defineProperty(column, 'scrollWidth', { configurable: true, get: () => scrollWidth });
};

const makeColumn = (side: 'deletions' | 'additions' | 'unified', clientWidth: number, scrollWidth: number) => {
  const column = document.createElement('code');
  column.setAttribute('data-code', '');
  column.setAttribute(`data-${side}`, '');
  const content = document.createElement('div');
  content.setAttribute('data-content', '');
  column.append(document.createElement('div'), content);
  setWidths(column, clientWidth, scrollWidth);
  return column;
};

const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('bindStickyScrollbar', () => {
  let browser: Window;
  let container: HTMLDivElement;
  let bar: HTMLDivElement;
  let pre: HTMLPreElement;

  const tracks = () => Array.from(bar.children).filter((child): child is HTMLDivElement => child instanceof HTMLDivElement);
  const measure = () => TestResizeObserver.instances[0]?.trigger();

  // Pierre's module reads `customElements` whenever `HTMLElement` exists, so
  // a leaked `HTMLElement` breaks later test files in the run that import it.
  const globalNames = ['window', 'document', 'HTMLElement', 'HTMLDivElement', 'Event', 'MutationObserver', 'ResizeObserver'];
  let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

  beforeEach(() => {
    browser = new Window({ url: 'http://localhost/' });
    TestResizeObserver.instances = [];
    savedGlobals = globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.assign(globalThis, {
      window: browser,
      document: browser.document,
      HTMLElement: browser.HTMLElement,
      HTMLDivElement: browser.HTMLDivElement,
      Event: browser.Event,
      MutationObserver: browser.MutationObserver,
      ResizeObserver: TestResizeObserver,
    });
    container = document.createElement('div');
    const host = document.createElement('diffs-container');
    pre = document.createElement('pre');
    host.attachShadow({ mode: 'open' }).append(pre);
    container.append(host);
    bar = document.createElement('div');
    bar.hidden = true;
    document.body.append(container, bar);
  });

  afterEach(() => {
    browser.close();
    for (const [name, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });

  test('shows one track per overflowing column of a split diff', () => {
    pre.append(makeColumn('deletions', 500, 2000), makeColumn('additions', 500, 2100));
    const unbind = bindStickyScrollbar(container, bar);
    measure();

    expect(bar.hidden).toBe(false);
    expect(tracks().map((track) => [track.hidden, track.style.width, track.firstElementChild?.getAttribute('style')]))
      .toEqual([
        [false, '500px', 'width: 2000px;'],
        [false, '500px', 'width: 2100px;'],
      ]);
    unbind();
  });

  test('stays hidden while no column overflows', () => {
    pre.append(makeColumn('unified', 800, 800));
    const unbind = bindStickyScrollbar(container, bar);
    measure();

    expect(bar.hidden).toBe(true);
    expect(tracks().map((track) => track.hidden)).toEqual([true]);
    unbind();
  });

  test('moves the column with its track and the track with its column', () => {
    const column = makeColumn('unified', 500, 2000);
    pre.append(column);
    const unbind = bindStickyScrollbar(container, bar);
    measure();
    const [track] = tracks();

    track.scrollLeft = 300;
    track.dispatchEvent(new Event('scroll'));
    expect(column.scrollLeft).toBe(300);

    column.scrollLeft = 120;
    column.dispatchEvent(new Event('scroll'));
    expect(track.scrollLeft).toBe(120);
    unbind();
  });

  test('follows a rebuilt diff and observes the new content boxes', async () => {
    const before = makeColumn('unified', 500, 2000);
    pre.append(before);
    const unbind = bindStickyScrollbar(container, bar);
    measure();
    const [oldTrack] = tracks();

    const left = makeColumn('deletions', 400, 900);
    const right = makeColumn('additions', 400, 900);
    pre.replaceChildren(left, right);
    await flushMutations();
    measure();

    expect(oldTrack.isConnected).toBe(false);
    expect(tracks()).toHaveLength(2);
    const observed = TestResizeObserver.instances[0]?.observed;
    expect(observed?.has(before)).toBe(false);
    expect([...(observed ?? [])].filter((target) => target.hasAttribute('data-content') && left.contains(target))).toHaveLength(1);

    // The old column no longer drives anything.
    before.scrollLeft = 50;
    before.dispatchEvent(new Event('scroll'));
    expect(tracks().map((track) => track.scrollLeft)).toEqual([0, 0]);
    unbind();
  });

  test('unbinding removes the tracks and hides the bar', () => {
    pre.append(makeColumn('unified', 500, 2000));
    const unbind = bindStickyScrollbar(container, bar);
    measure();

    unbind();

    expect(tracks()).toHaveLength(0);
    expect(bar.hidden).toBe(true);
    expect(TestResizeObserver.instances[0]?.observed.size).toBe(0);
  });
});
