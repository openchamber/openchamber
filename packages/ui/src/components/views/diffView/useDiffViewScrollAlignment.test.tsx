import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useDiffViewScrollAlignment } from './useDiffViewScrollAlignment';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  Event: browser.Event, DOMRect: browser.DOMRect, IS_REACT_ACT_ENVIRONMENT: true,
});

const ROOT_TOP = 100;
const TARGET = 'src/target.ts';

type FrameHandle = ReturnType<typeof setImmediate>;
type QueuedFrame = { id: FrameHandle; callback: FrameRequestCallback };

let frameQueue: QueuedFrame[] = [];

const nextFrameHandle = (): FrameHandle => {
  const handle = setImmediate(() => {});
  clearImmediate(handle);
  return handle;
};

const installFrameQueue = () => {
  frameQueue = [];
  browser.requestAnimationFrame = (callback) => {
    const id = nextFrameHandle();
    frameQueue.push({ id, callback });
    return id;
  };
  browser.cancelAnimationFrame = (id) => {
    frameQueue = frameQueue.filter((frame) => frame.id !== id);
  };
};

const flushFrames = async (rounds = 8) => {
  for (let round = 0; round < rounds; round += 1) {
    const queued = frameQueue;
    if (queued.length === 0) return;
    frameQueue = [];
    await act(async () => {
      for (const frame of queued) frame.callback(round);
    });
  }
};

const rect = (top: number, height = 100): DOMRect => new DOMRect(0, top, 400, height);

class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;
  observing: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe = (target: Element) => { this.observing.push(target); };
  unobserve = () => {};
  disconnect = () => { this.observing = []; };
  emit = () => { this.callback([], this); };
}

const nativeResizeObserver = globalThis.ResizeObserver;

type Scene = {
  sectionTop: number;
  maxScroll: number;
  showSection: boolean;
  showScroller?: boolean;
  scrollTop: number;
};

type ProbeProps = {
  scene: Scene;
  pinTargetToTop?: boolean;
  rootRef?: React.RefObject<HTMLDivElement | null>;
  contextKey?: string;
  comparisonKey?: string | null;
};

const Probe: React.FC<ProbeProps> = ({ scene, pinTargetToTop = false, rootRef, contextKey = 'working', comparisonKey = null }) => {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const targetRef = React.useRef<HTMLDivElement | null>(null);
  const pendingScrollTargetRef = React.useRef<string | null>(TARGET);
  const pendingScrollFrameRef = React.useRef<number | null>(null);
  const shouldPinAfterAlignRef = React.useRef(true);
  const sections = React.useRef(new Map<string, HTMLDivElement | null>());
  const mounted = React.useRef(false);
  const getFileSection = React.useCallback((path: string) => sections.current.get(path), []);
  const [pinnedTarget, setPinnedTarget] = React.useState<string | null>(null);

  React.useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    if (rootRef) rootRef.current = root;
    if (!mounted.current) {
      mounted.current = true;
      Object.defineProperty(root, 'scrollTop', {
        configurable: true,
        get: () => scene.scrollTop,
        set: (value: number) => { scene.scrollTop = value; },
      });
      root.getBoundingClientRect = () => rect(ROOT_TOP, 700);
      Object.defineProperty(root, 'scrollTo', {
        configurable: true,
        value: ({ top = 0 }: ScrollToOptions) => {
          const next = Math.max(0, Math.min(top, scene.maxScroll));
          if (next === scene.scrollTop) return;
          scene.scrollTop = next;
          root.dispatchEvent(new Event('scroll'));
        },
      });
    }
    const section = targetRef.current;
    if (section) {
      sections.current.set(TARGET, section);
      section.getBoundingClientRect = () => rect(ROOT_TOP + scene.sectionTop - scene.scrollTop, 300);
    } else {
      sections.current.delete(TARGET);
    }
  });

  useDiffViewScrollAlignment({
    getFileSection,
    diffScrollRef: scrollRef,
    diffContentRef: contentRef,
    pendingScrollTargetRef,
    shouldPinAfterAlignRef,
    setPinnedStackedTarget: setPinnedTarget,
    pendingScrollFrameRef,
    scrollRequestNonce: 0,
    requestContextKey: contextKey,
    comparisonKey,
    visible: true,
    pinSelectedFileHeaderToTopOnNavigate: pinTargetToTop,
  });

  if (scene.showScroller === false) return <div>Loading</div>;
  return (
    <div ref={scrollRef}>
      <div ref={contentRef}>
        {scene.showSection ? <div ref={targetRef}>{TARGET}</div> : null}
      </div>
      <div data-pinned={pinnedTarget ?? ''} />
    </div>
  );
};

let reactRoot: Root | null = null;
const host = document.createElement('div');
document.body.append(host);

const render = async (props: ProbeProps) => {
  reactRoot ??= createRoot(host);
  await act(async () => reactRoot?.render(<Probe {...props} />));
};

const pinnedTarget = () => document.querySelector('[data-pinned]')?.getAttribute('data-pinned') ?? '';

beforeEach(() => {
  FakeResizeObserver.instances = [];
  globalThis.ResizeObserver = FakeResizeObserver;
  installFrameQueue();
});

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
  globalThis.ResizeObserver = nativeResizeObserver;
});

describe('useDiffViewScrollAlignment', () => {
  test('keeps the target at the top when the entries above grow after the scroll', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 0, showSection: true, scrollTop: 0 };
    await render({ scene });
    await flushFrames();

    expect(scene.scrollTop).toBe(0);
    expect(FakeResizeObserver.instances).toHaveLength(1);

    scene.maxScroll = 5000;
    await act(async () => { FakeResizeObserver.instances[0].emit(); });
    await flushFrames();

    expect(scene.scrollTop).toBe(400);
  });

  test('corrects another writer that moves the target off the top', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: true, scrollTop: 0 };
    const rootRef = React.createRef<HTMLDivElement>();
    await render({ scene, rootRef });
    await flushFrames();
    expect(scene.scrollTop).toBe(400);

    scene.scrollTop = 0;
    await act(async () => { rootRef.current?.dispatchEvent(new Event('scroll')); });
    await flushFrames();

    expect(scene.scrollTop).toBe(400);
  });

  test('stops following the target once the reader scrolls', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: true, scrollTop: 0 };
    const rootRef = React.createRef<HTMLDivElement>();
    await render({ scene, rootRef });
    await flushFrames();
    expect(scene.scrollTop).toBe(400);

    await act(async () => { rootRef.current?.dispatchEvent(new Event('wheel')); });
    scene.scrollTop = 120;
    await act(async () => { rootRef.current?.dispatchEvent(new Event('scroll')); });

    scene.sectionTop = 900;
    await act(async () => { FakeResizeObserver.instances[0].emit(); });
    await flushFrames();

    expect(scene.scrollTop).toBe(120);
  });

  test('stops following the target once focus moves inside the diff', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: true, scrollTop: 0 };
    const rootRef = React.createRef<HTMLDivElement>();
    await render({ scene, rootRef });
    await flushFrames();
    expect(scene.scrollTop).toBe(400);

    await act(async () => { rootRef.current?.dispatchEvent(new Event('focusin', { bubbles: true })); });
    scene.scrollTop = 120;
    await act(async () => { rootRef.current?.dispatchEvent(new Event('scroll')); });

    scene.sectionTop = 900;
    await act(async () => { FakeResizeObserver.instances[0].emit(); });
    await flushFrames();

    expect(scene.scrollTop).toBe(120);
  });

  test('stops following the target when the scope changes', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: true, scrollTop: 0 };
    await render({ scene });
    await flushFrames();
    expect(scene.scrollTop).toBe(400);

    await act(async () => { await reactRoot?.render(<Probe scene={scene} contextKey="branch" />); });
    scene.sectionTop = 900;
    await act(async () => { FakeResizeObserver.instances[0].emit(); });
    await flushFrames();

    expect(scene.scrollTop).toBe(400);
  });

  test('keeps the hold while its comparison resolves and stops when another one is chosen', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: true, scrollTop: 0 };
    const grow = async (top: number) => {
      scene.sectionTop = top;
      await act(async () => { FakeResizeObserver.instances[0].emit(); });
      await flushFrames();
    };
    await render({ scene, contextKey: 'commit' });
    await flushFrames();

    await render({ scene, contextKey: 'commit', comparisonKey: 'first' });
    await grow(600);
    expect(scene.scrollTop).toBe(600);

    await render({ scene, contextKey: 'commit' });
    await render({ scene, contextKey: 'commit', comparisonKey: 'first' });
    await grow(900);
    expect(scene.scrollTop).toBe(900);

    await render({ scene, contextKey: 'commit', comparisonKey: 'second' });
    await grow(1200);
    expect(scene.scrollTop).toBe(900);
  });

  test('waits for the target section to render before aligning', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: false, scrollTop: 0 };
    await render({ scene });
    await flushFrames();
    expect(scene.scrollTop).toBe(0);

    scene.showSection = true;
    await act(async () => { await reactRoot?.render(<Probe scene={scene} />); });
    await flushFrames();

    expect(scene.scrollTop).toBe(400);
  });

  test('follows the target in a scroller that mounts after the request until the reader scrolls', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: true, showScroller: false, scrollTop: 0 };
    const rootRef = React.createRef<HTMLDivElement>();
    await render({ scene, rootRef });
    await flushFrames(200);
    expect(scene.scrollTop).toBe(0);

    scene.showScroller = true;
    await render({ scene, rootRef });
    await flushFrames();
    expect(scene.scrollTop).toBe(400);

    const observer = FakeResizeObserver.instances[0];
    expect(observer.observing).toHaveLength(1);
    scene.sectionTop = 900;
    await act(async () => { observer.emit(); });
    await flushFrames();
    expect(scene.scrollTop).toBe(900);

    await act(async () => { rootRef.current?.dispatchEvent(new Event('wheel')); });
    scene.scrollTop = 120;
    scene.sectionTop = 1400;
    await act(async () => { observer.emit(); });
    await flushFrames();
    expect(scene.scrollTop).toBe(120);
  });

  test('pins the context panel target while the list settles', async () => {
    const scene: Scene = { sectionTop: 400, maxScroll: 5000, showSection: true, scrollTop: 0 };
    await render({ scene, pinTargetToTop: true });
    await flushFrames();

    expect(pinnedTarget()).toBe(TARGET);
  });
});
