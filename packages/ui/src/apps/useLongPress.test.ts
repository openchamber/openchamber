import { describe, expect, test } from 'bun:test';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { createLongPressController } from './useLongPress';

const flush = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Plain call recorder rather than bun's mock: the repo's expect typings do not
// expose `toHaveBeenCalled*`, and a local counter keeps this test self-contained.
const recorder = () => {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    fn: fn as () => void,
    count: () => calls.length,
  };
};

const pointerEvent = (x = 0, y = 0): ReactPointerEvent =>
  ({ pointerType: 'touch', button: 0, clientX: x, clientY: y } as unknown as ReactPointerEvent);

const mouseEvent = () => {
  const preventDefault = recorder();
  const stopPropagation = recorder();
  return {
    event: { preventDefault: preventDefault.fn, stopPropagation: stopPropagation.fn } as unknown as ReactMouseEvent,
    preventDefault,
    stopPropagation,
  };
};

describe('createLongPressController', () => {
  test('fires once after the delay elapses', async () => {
    const onLongPress = recorder();
    const controller = createLongPressController(onLongPress.fn, { delayMs: 5 });

    controller.handlers.onPointerDown(pointerEvent());
    expect(onLongPress.count()).toBe(0);

    await flush(20);
    expect(onLongPress.count()).toBe(1);
  });

  test('cancels when the pointer moves past the tolerance', async () => {
    const onLongPress = recorder();
    const controller = createLongPressController(onLongPress.fn, { delayMs: 5, moveTolerancePx: 10 });

    controller.handlers.onPointerDown(pointerEvent(0, 0));
    controller.handlers.onPointerMove(pointerEvent(50, 0));

    await flush(20);
    expect(onLongPress.count()).toBe(0);
  });

  test('survives movement inside the tolerance and cancels on pointer up', async () => {
    const onLongPress = recorder();
    const controller = createLongPressController(onLongPress.fn, { delayMs: 5, moveTolerancePx: 10 });
    controller.handlers.onPointerDown(pointerEvent(0, 0));
    controller.handlers.onPointerMove(pointerEvent(3, 2));
    await flush(20);
    expect(onLongPress.count()).toBe(1);

    const onSecond = recorder();
    const second = createLongPressController(onSecond.fn, { delayMs: 5 });
    second.handlers.onPointerDown(pointerEvent(0, 0));
    second.handlers.onPointerUp();
    await flush(20);
    expect(onSecond.count()).toBe(0);
  });

  test('fires immediately from the context menu without waiting for the timer', () => {
    const onLongPress = recorder();
    const controller = createLongPressController(onLongPress.fn, { delayMs: 1000 });
    const { event, preventDefault } = mouseEvent();

    controller.handlers.onContextMenu(event);

    expect(preventDefault.count()).toBe(1);
    expect(onLongPress.count()).toBe(1);
  });

  test('swallows the click that follows a long press, exactly once', async () => {
    const onLongPress = recorder();
    const controller = createLongPressController(onLongPress.fn, { delayMs: 5 });
    controller.handlers.onPointerDown(pointerEvent());
    await flush(20);

    const first = mouseEvent();
    controller.handlers.onClickCapture(first.event);
    expect(first.preventDefault.count()).toBe(1);
    expect(first.stopPropagation.count()).toBe(1);

    const second = mouseEvent();
    controller.handlers.onClickCapture(second.event);
    expect(second.preventDefault.count()).toBe(0);
  });

  test('ignores non-primary mouse buttons', async () => {
    const onLongPress = recorder();
    const controller = createLongPressController(onLongPress.fn, { delayMs: 5 });

    controller.handlers.onPointerDown({
      pointerType: 'mouse',
      button: 2,
      clientX: 0,
      clientY: 0,
    } as unknown as ReactPointerEvent);

    await flush(20);
    expect(onLongPress.count()).toBe(0);
  });
});