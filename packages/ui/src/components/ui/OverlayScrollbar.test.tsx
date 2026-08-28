import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { OverlayScrollbar } from './OverlayScrollbar';

class TestResizeObserver implements ResizeObserver {
  static instances: TestResizeObserver[] = [];

  private readonly callback: ResizeObserverCallback;
  disconnectCount = 0;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }

  observe(): void {}
  unobserve(): void {}

  trigger(): void {
    this.callback([], this);
  }
}

describe('OverlayScrollbar', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let scroller: HTMLDivElement;
  let root: Root;
  let containerRef: React.RefObject<HTMLElement | null>;
  let scrollTop: number;
  let scrollbarCommits: number;
  let verticalLayoutReads: number;
  let horizontalLayoutReads: number;
  let nextFrameId: number;
  let pendingFrames: Map<number, FrameRequestCallback>;

  const flushFrames = async () => {
    await act(async () => {
      const frames = Array.from(pendingFrames.values());
      pendingFrames.clear();
      frames.forEach((callback) => callback(0));
    });
  };

  const renderScrollbar = async (props: Partial<React.ComponentProps<typeof OverlayScrollbar>> = {}) => {
    await act(async () => {
      root.render(
        <React.Profiler id="overlay-scrollbar" onRender={() => { scrollbarCommits += 1; }}>
          <OverlayScrollbar
            containerRef={containerRef}
            disableHorizontal
            {...props}
          />
        </React.Profiler>,
      );
    });
    await flushFrames();
  };

  beforeEach(() => {
    windowInstance = new Window();
    pendingFrames = new Map();
    nextFrameId = 1;
    TestResizeObserver.instances = [];

    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      PointerEvent: windowInstance.PointerEvent,
      ResizeObserver: TestResizeObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        const id = nextFrameId++;
        pendingFrames.set(id, callback);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        pendingFrames.delete(id);
      },
    });

    host = document.createElement('div');
    scroller = document.createElement('div');
    document.body.append(host, scroller);
    root = createRoot(host);
    containerRef = { current: scroller };
    scrollTop = 0;
    scrollbarCommits = 0;
    verticalLayoutReads = 0;
    horizontalLayoutReads = 0;

    Object.defineProperties(scroller, {
      clientHeight: {
        configurable: true,
        get: () => {
          verticalLayoutReads += 1;
          return 100;
        },
      },
      scrollHeight: {
        configurable: true,
        get: () => {
          verticalLayoutReads += 1;
          return 500;
        },
      },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
      clientWidth: {
        configurable: true,
        get: () => {
          horizontalLayoutReads += 1;
          return 100;
        },
      },
      scrollWidth: {
        configurable: true,
        get: () => {
          horizontalLayoutReads += 1;
          return 100;
        },
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('moves the thumb without rereading layout during steady scrolling', async () => {
    await renderScrollbar();
    scrollbarCommits = 0;
    verticalLayoutReads = 0;
    horizontalLayoutReads = 0;

    scrollTop = 200;
    scroller.dispatchEvent(new window.Event('scroll'));
    await flushFrames();

    const thumb = host.querySelector<HTMLElement>('[data-overlay-scrollbar-thumb="vertical"]');
    expect(thumb?.style.transform).toBe('translate3d(0, 34px, 0)');
    expect(thumb?.style.top).toBe('');
    expect(verticalLayoutReads).toBe(0);
    expect(horizontalLayoutReads).toBe(0);
    expect(scrollbarCommits).toBe(0);
  });

  test('coalesces scroll and resize updates into one animation frame', async () => {
    await renderScrollbar();

    scroller.dispatchEvent(new window.Event('scroll'));
    TestResizeObserver.instances[0]?.trigger();

    expect(pendingFrames.size).toBe(1);
  });

  test('reads both axes before writing updated thumb sizes', async () => {
    let clientHeight = 100;
    let verticalHeightDuringHorizontalRead = '';
    let captureHorizontalRead = false;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => clientHeight },
      clientWidth: {
        configurable: true,
        get: () => {
          if (captureHorizontalRead) {
            verticalHeightDuringHorizontalRead = host.querySelector<HTMLElement>(
              '[data-overlay-scrollbar-thumb="vertical"]',
            )?.style.height ?? '';
          }
          return 100;
        },
      },
      scrollWidth: { configurable: true, get: () => 300 },
    });
    await renderScrollbar({ disableHorizontal: false });

    clientHeight = 200;
    captureHorizontalRead = true;
    TestResizeObserver.instances[0]?.trigger();
    await flushFrames();

    const verticalThumb = host.querySelector<HTMLElement>('[data-overlay-scrollbar-thumb="vertical"]');
    expect(verticalHeightDuringHorizontalRead).toBe('32px');
    expect(verticalThumb?.style.height).toBe('73.6px');
  });

  test('keeps the resize observer connected when visibility is suppressed', async () => {
    await renderScrollbar({ suppressVisibility: false });
    expect(TestResizeObserver.instances).toHaveLength(1);
    const disconnectCount = TestResizeObserver.instances[0]?.disconnectCount;

    await renderScrollbar({ suppressVisibility: true });

    expect(TestResizeObserver.instances).toHaveLength(1);
    expect(TestResizeObserver.instances[0]?.disconnectCount).toBe(disconnectCount);
  });

  test('uses the rendered thumb travel when dragging', async () => {
    await renderScrollbar();
    const thumb = host.querySelector<HTMLElement>('[data-overlay-scrollbar-thumb="vertical"]');
    if (!thumb) throw new Error('OverlayScrollbar did not render its vertical thumb');

    thumb.setPointerCapture = () => {};
    thumb.releasePointerCapture = () => {};
    thumb.dispatchEvent(new window.PointerEvent('pointerdown', {
      bubbles: true,
      clientY: 0,
      pointerId: 1,
    }));
    thumb.dispatchEvent(new window.PointerEvent('pointermove', {
      bubbles: true,
      clientY: 26,
      pointerId: 1,
    }));

    expect(scrollTop).toBe(200);
    thumb.dispatchEvent(new window.PointerEvent('pointerup', {
      bubbles: true,
      clientY: 26,
      pointerId: 1,
    }));
    thumb.dispatchEvent(new window.PointerEvent('pointermove', {
      bubbles: true,
      clientY: 52,
      pointerId: 1,
    }));
    expect(scrollTop).toBe(200);
  });

  test('keeps the minimum thumb size within a short track', async () => {
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      get: () => 40,
    });

    await renderScrollbar();

    const thumb = host.querySelector<HTMLElement>('[data-overlay-scrollbar-thumb="vertical"]');
    expect(thumb?.style.height).toBe('24px');
  });

  test('applies visibility suppression without reconnecting the scrollbar', async () => {
    await renderScrollbar({ suppressVisibility: false });
    const scrollbar = host.querySelector<HTMLElement>('.overlay-scrollbar');
    if (!scrollbar) throw new Error('OverlayScrollbar did not render its container');

    scroller.dispatchEvent(new window.Event('scroll'));
    expect(scrollbar.dataset.visible).toBe('true');

    await renderScrollbar({ suppressVisibility: true });

    expect(scrollbar.dataset.visible).toBe('false');
  });

  test('shows user-intent-only scrollbars for user scrolling but not programmatic scrolling', async () => {
    await renderScrollbar({ userIntentOnly: true });
    const scrollbar = host.querySelector<HTMLElement>('.overlay-scrollbar');
    if (!scrollbar) throw new Error('OverlayScrollbar did not render its container');

    scroller.dispatchEvent(new window.Event('scroll'));
    expect(scrollbar.dataset.visible).toBe('false');

    scroller.dispatchEvent(new window.WheelEvent('wheel'));
    scroller.dispatchEvent(new window.Event('scroll'));
    expect(scrollbar.dataset.visible).toBe('true');
  });

});
