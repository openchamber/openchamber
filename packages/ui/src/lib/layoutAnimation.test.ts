import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const attributes = new Set<string>();
const frames: FrameRequestCallback[] = [];
const descriptors = new Map<string, PropertyDescriptor | undefined>();

type RootStub = { documentElement: { setAttribute: (name: string) => void; removeAttribute: (name: string) => void } };
type GlobalStub = typeof globalThis | RootStub | ((callback: FrameRequestCallback) => number) | (() => void) | (() => { matches: boolean });

let reducedMotion = false;

const setGlobal = (name: string, value: GlobalStub) => {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};

const runFrame = () => {
  const due = frames.splice(0);
  for (const frame of due) frame(0);
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  attributes.clear();
  frames.length = 0;
  setGlobal('window', globalThis);
  setGlobal('document', {
    documentElement: {
      setAttribute: (name: string) => attributes.add(name),
      removeAttribute: (name: string) => attributes.delete(name),
    },
  });
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  reducedMotion = false;
  setGlobal('matchMedia', () => ({ matches: reducedMotion }));
  setGlobal('cancelAnimationFrame', () => { frames.length = 0; });
});

afterEach(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  descriptors.clear();
});

const { beginLayoutAnimation, cancelWhenLayoutSettled, isLayoutAnimating, onLayoutAnimationStart, runWhenLayoutSettled } = await import('./layoutAnimation');

describe('layoutAnimation', () => {
  test('runs a task at once when nothing animates', () => {
    let runs = 0;
    runWhenLayoutSettled(() => { runs += 1; });
    expect(runs).toBe(1);
    expect(isLayoutAnimating()).toBe(false);
  });

  test('holds tasks until one frame after the duration, then runs each once', async () => {
    let pins = 0;
    const pin = () => { pins += 1; };
    beginLayoutAnimation(5);
    expect(isLayoutAnimating()).toBe(true);
    expect(attributes.has('data-panel-animating')).toBe(true);

    // The same task queued on every frame of the animation runs once.
    runWhenLayoutSettled(pin);
    runWhenLayoutSettled(pin);
    runWhenLayoutSettled(pin);
    runFrame();
    await wait(10);
    expect(pins).toBe(0);
    expect(isLayoutAnimating()).toBe(true);

    runFrame();
    expect(pins).toBe(1);
    expect(isLayoutAnimating()).toBe(false);
    expect(attributes.has('data-panel-animating')).toBe(false);
  });

  test('the duration counts from the next frame, when the transition starts', async () => {
    let runs = 0;
    beginLayoutAnimation(5);
    runWhenLayoutSettled(() => { runs += 1; });
    // A slow toggle frame: the duration has passed, the transition has not run.
    await wait(10);
    runFrame();
    expect(runs).toBe(0);
    await wait(10);
    runFrame();
    expect(runs).toBe(1);
  });

  test('a second animation extends the first instead of settling in between', async () => {
    let runs = 0;
    beginLayoutAnimation(5);
    runWhenLayoutSettled(() => { runs += 1; });
    runFrame();
    await wait(3);
    beginLayoutAnimation(15);
    runFrame();
    await wait(8);
    runFrame();
    expect(runs).toBe(0);
    await wait(12);
    runFrame();
    expect(runs).toBe(1);
  });

  test('with reduced motion the animation ends a frame after it starts', async () => {
    reducedMotion = true;
    let runs = 0;
    beginLayoutAnimation(500);
    runWhenLayoutSettled(() => { runs += 1; });
    runFrame();
    await wait(2);
    runFrame();
    expect(runs).toBe(1);
  });

  test('start listeners hear an animation start once, not its extension', async () => {
    let starts = 0;
    const release = onLayoutAnimationStart(() => { starts += 1; });
    beginLayoutAnimation(2);
    beginLayoutAnimation(2);
    expect(starts).toBe(1);
    runFrame();
    await wait(5);
    runFrame();
    beginLayoutAnimation(2);
    expect(starts).toBe(2);
    release();
    runFrame();
    await wait(5);
    runFrame();
  });

  test('a cancelled task does not run', async () => {
    let runs = 0;
    const task = () => { runs += 1; };
    beginLayoutAnimation(1);
    runWhenLayoutSettled(task);
    cancelWhenLayoutSettled(task);
    runFrame();
    await wait(5);
    runFrame();
    expect(runs).toBe(0);
  });
});
