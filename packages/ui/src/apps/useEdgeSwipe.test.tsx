import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEdgeSwipe } from './useEdgeSwipe';

describe('edge swipe selection isolation', () => {
  let root: Root;
  let text: HTMLParagraphElement;
  let scroller: HTMLElement;
  let cell: HTMLElement;
  let opened: string[];
  let restoreGlobals: () => void;
  let render: (enabled?: boolean) => Promise<void>;

  beforeEach(async () => {
    const dom = new Window();
    const globals = {
      window: dom,
      document: dom.document,
      Event: dom.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    restoreGlobals = () => {
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };

    opened = [];
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const Harness = ({ enabled }: { enabled?: boolean }) => {
      const ref = React.useRef<HTMLElement>(null);
      useEdgeSwipe(ref, {
        enabled,
        onLeftEdgeSwipe: () => opened.push('left'),
        onRightEdgeSwipe: () => opened.push('right'),
      });
      return (
        <main ref={ref}>
          <p>Selectable rendered message text</p>
          <div data-scroller style={{ overflowX: 'auto' }}><table><tbody><tr><td>Wide cell</td></tr></tbody></table></div>
        </main>
      );
    };
    render = async (enabled) => {
      await act(async () => root.render(<Harness enabled={enabled} />));
    };
    await render();
    const main = host.querySelector('main');
    const paragraph = host.querySelector('p');
    const wide = host.querySelector<HTMLElement>('[data-scroller]');
    const wideCell = host.querySelector<HTMLElement>('td');
    if (!main || !paragraph || !wide || !wideCell) throw new Error('Missing chat harness');
    Object.defineProperty(main, 'clientWidth', { value: 390 });
    Object.defineProperty(wide, 'clientWidth', { value: 390 });
    Object.defineProperty(wide, 'scrollWidth', { value: 900 });
    text = paragraph;
    scroller = wide;
    cell = wideCell;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreGlobals();
  });

  const touch = (type: string, x: number, y = 100, target: HTMLElement = text) => {
    const point = { clientX: x, clientY: y };
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: type === 'touchstart' ? [point] : [],
      changedTouches: [point],
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  };

  const selectText = () => {
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  };

  test('disabling and reopening a drawer discards pending gestures and restores selection guards', async () => {
    touch('touchstart', 20);
    await render(false);
    touch('touchend', 140);
    touch('touchstart', 20);
    touch('touchend', 140);
    expect(opened).toEqual([]);

    await render(true);
    touch('touchend', 140);
    touch('touchstart', 20);
    selectText();
    document.getSelection()?.removeAllRanges();
    touch('touchend', 140);
    expect(opened).toEqual([]);

    touch('touchstart', 20);
    touch('touchend', 140);
    expect(opened).toEqual(['left']);
  });

  for (const side of ['left', 'right']) {
    const startX = side === 'left' ? 20 : 370;
    const endX = side === 'left' ? 140 : 250;

    test(`${side}: ordinary edge swipes still open the drawer`, () => {
      touch('touchstart', startX);
      touch('touchend', endX);
      expect(opened).toEqual([side]);
    });

    test(`${side}: an existing selection blocks the entire gesture`, () => {
      selectText();
      touch('touchstart', startX);
      document.getSelection()?.removeAllRanges();
      touch('touchend', endX);
      expect(opened).toEqual([]);
    });

    test(`${side}: selecting text during a swipe cancels it even if the selection clears`, () => {
      touch('touchstart', startX);
      selectText();
      document.getSelection()?.removeAllRanges();
      touch('touchend', endX);
      expect(opened).toEqual([]);

      touch('touchstart', startX);
      touch('touchend', endX);
      expect(opened).toEqual([side]);
    });

    test(`${side}: selection start cancels before the browser creates a range`, () => {
      touch('touchstart', startX);
      const event = new Event('selectstart', { bubbles: true, cancelable: true });
      text.dispatchEvent(event);
      touch('touchend', endX);
      expect(event.defaultPrevented).toBe(false);
      expect(opened).toEqual([]);
    });

    test(`${side}: touchend checks the range even before selectionchange is delivered`, () => {
      const delayNotification = (event: Event) => event.stopImmediatePropagation();
      document.addEventListener('selectionchange', delayNotification, true);
      try {
        touch('touchstart', startX);
        selectText();
        touch('touchend', endX);
        expect(opened).toEqual([]);
      } finally {
        document.removeEventListener('selectionchange', delayNotification, true);
      }
    });

    test(`${side}: a collapsed caret does not block swiping`, () => {
      const range = document.createRange();
      range.selectNodeContents(text);
      range.collapse(true);
      document.getSelection()?.addRange(range);
      touch('touchstart', startX);
      document.dispatchEvent(new Event('selectionchange'));
      touch('touchend', endX);
      expect(opened).toEqual([side]);
    });

    test(`${side}: browser cancellation abandons the gesture`, () => {
      touch('touchstart', startX);
      touch('touchcancel', startX);
      touch('touchend', endX);
      expect(opened).toEqual([]);
    });

    test(`${side}: wide content owns the gesture until it reaches its end`, () => {
      // Right-edge swipes pull content in from the right, left-edge ones from the left.
      const scrollable = side === 'left' ? 510 : 0;
      scroller.scrollLeft = scrollable;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([]);
    });

    test(`${side}: a normal swipe at the end of wide content does not open the drawer`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([]);
    });

    test(`${side}: a diagonal swipe at the end of wide content stays with the content`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      touch('touchstart', startX, 100, cell);
      // 120px across but 60px down: inside the normal axis tolerance, past the strict one.
      touch('touchend', endX, 160, cell);
      expect(opened).toEqual([]);
    });

    test(`${side}: at the end of wide content the strict angle bar decides`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      const longEndX = side === 'left' ? startX + 160 : startX - 160;
      // 160px across: 60px down (0.375) is flat enough; 70px down (0.4375) is not.
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 170, cell);
      expect(opened).toEqual([]);
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 160, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: a long deliberate swipe at the end of wide content opens the drawer`, () => {
      scroller.scrollLeft = side === 'left' ? 0 : 510;
      const longEndX = side === 'left' ? startX + 160 : startX - 160;
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 100, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: right-to-left content scrolls from its own start`, () => {
      scroller.style.direction = 'rtl';
      // RTL scrollLeft runs from -510 (left end) to 0 (right end, the start).
      scroller.scrollLeft = side === 'left' ? 0 : -510;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([]);

      scroller.scrollLeft = side === 'left' ? -510 : 0;
      const longEndX = side === 'left' ? startX + 160 : startX - 160;
      touch('touchstart', startX, 100, cell);
      touch('touchend', longEndX, 100, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: wide content that cannot scroll does not block the drawer`, () => {
      scroller.style.overflowX = 'hidden';
      scroller.scrollLeft = side === 'left' ? 510 : 0;
      touch('touchstart', startX, 100, cell);
      touch('touchend', endX, 100, cell);
      expect(opened).toEqual([side]);
    });

    test(`${side}: vertical, short and non-edge gestures remain ignored`, () => {
      touch('touchstart', startX);
      touch('touchend', endX, 300);
      touch('touchstart', startX);
      touch('touchend', startX + 10);
      touch('touchstart', 195);
      touch('touchend', endX);
      expect(opened).toEqual([]);
    });
  }
});
