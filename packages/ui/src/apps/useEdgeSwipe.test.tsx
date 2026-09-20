import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEdgeSwipe } from './useEdgeSwipe';

describe('edge swipe selection isolation', () => {
  let root: Root;
  let text: HTMLParagraphElement;
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
      return <main ref={ref}><p>Selectable rendered message text</p></main>;
    };
    render = async (enabled) => {
      await act(async () => root.render(<Harness enabled={enabled} />));
    };
    await render();
    const main = host.querySelector('main');
    const paragraph = host.querySelector('p');
    if (!main || !paragraph) throw new Error('Missing chat harness');
    Object.defineProperty(main, 'clientWidth', { value: 390 });
    text = paragraph;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreGlobals();
  });

  const touch = (type: string, x: number, y = 100) => {
    const point = { clientX: x, clientY: y };
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches: type === 'touchstart' ? [point] : [],
      changedTouches: [point],
    });
    text.dispatchEvent(event);
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
