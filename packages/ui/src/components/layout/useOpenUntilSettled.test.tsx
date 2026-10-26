import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const dom = new Window();
const frames: FrameRequestCallback[] = [];
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  matchMedia: () => ({ matches: false }),
  requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  cancelAnimationFrame: () => { frames.length = 0; },
});

const { beginLayoutAnimation, LAYOUT_ANIMATION_MS } = await import('@/lib/layoutAnimation');
const { useOpenUntilSettled, useOpenWhenSettled } = await import('./useOpenUntilSettled');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What ContextPanel does: begin the animation on a toggle, then read the hook.
const Probe = ({ isOpen, onValue, hook }: { isOpen: boolean; onValue: (value: boolean) => void; hook: (isOpen: boolean) => boolean }) => {
  const previous = React.useRef(isOpen);
  React.useLayoutEffect(() => {
    if (previous.current === isOpen) return;
    previous.current = isOpen;
    beginLayoutAnimation(LAYOUT_ANIMATION_MS);
  }, [isOpen]);
  onValue(hook(isOpen));
  return null;
};

let root: Root;
let values: boolean[];
let hook: (isOpen: boolean) => boolean;
const render = async (isOpen: boolean) => {
  await act(async () => {
    root.render(<Probe isOpen={isOpen} hook={hook} onValue={(value) => values.push(value)} />);
  });
};
const last = () => values[values.length - 1];
const runFrames = () => { for (const frame of frames.splice(0)) frame(0); };
const settle = async () => {
  await act(async () => {
    runFrames();
    await wait(LAYOUT_ANIMATION_MS + 10);
    runFrames();
  });
};

beforeEach(() => {
  values = [];
  frames.length = 0;
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  await settle();
});
afterAll(() => dom.happyDOM.close());

describe('useOpenUntilSettled', () => {
  beforeEach(() => { hook = useOpenUntilSettled; });

  test('starts from the initial state without an animation', async () => {
    await render(false);
    expect(last()).toBe(false);
  });

  test('is shown at once on open, in the same render', async () => {
    await render(false);
    values = [];
    await render(true);
    expect(values[0]).toBe(true);
  });

  test('stays shown through the closing animation and hides when it ends', async () => {
    await render(true);
    await render(false);
    expect(last()).toBe(true);
    await settle();
    expect(last()).toBe(false);
  });

  test('a reopen during the closing animation never hides', async () => {
    await render(true);
    await render(false);
    await render(true);
    await settle();
    expect(values.includes(false)).toBe(false);
    expect(last()).toBe(true);
  });
});

describe('useOpenWhenSettled', () => {
  beforeEach(() => { hook = useOpenWhenSettled; });

  test('starts from the initial state without an animation', async () => {
    await render(true);
    expect(last()).toBe(true);
  });

  test('opens only once the opening animation ends', async () => {
    await render(false);
    await render(true);
    expect(last()).toBe(false);
    await settle();
    expect(last()).toBe(true);
  });

  test('closes only once the closing animation ends', async () => {
    await render(true);
    await render(false);
    expect(last()).toBe(true);
    await settle();
    expect(last()).toBe(false);
  });

  test('a close during the opening animation never opens', async () => {
    await render(false);
    await render(true);
    await render(false);
    await settle();
    expect(values.includes(true)).toBe(false);
  });
});
