/**
 * Regression tests for the panel resize hook (issue: drag never started).
 *
 * The P0 bug was that handlePointerDown initialized the pointer, width and
 * transaction but never set isResizing=true, so the window-level
 * pointermove/pointerup effect bailed out early and NO panel could be
 * dragged. The fix installs the window listeners synchronously in
 * pointerdown and keeps isResizing purely visual.
 *
 * These tests mount a real component using usePanelResize via createRoot
 * against a minimal DOM/window stub (Bun provides no DOM by default) and
 * drive the returned handlers directly, firing synthetic window pointer
 * events to exercise the real listener closures.
 *
 * Round 10 additions: the hook is the ONLY width writer (React re-renders
 * never clobber the CSS variable), `width === 0` is a legal close target
 * (never min-clamped), programmatic open/close/mode/parent-layout NEVER call
 * onUserCommitWidth, a semantic target mid-drag hands over in the SAME
 * global transaction, parent-layout follows re-resolve per frame without
 * restarting the animation clock, and both panels share one transaction.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { usePanelResize, type ProgrammaticPanelTarget } from "./usePanelResize";
import {
  beginResizeInteraction,
  getCurrentResizeTransactionId,
  getResizeInteractionPhase,
  registerResizeFrameParticipant,
  registerResizeTransactionStartParticipant,
  resetResizeFrameParticipantsForTests,
  resetResizeInteractionForTests,
  setResizeSchedulerForTests,
  type ResizeScheduler,
} from "@/lib/resizeInteraction";

// --- Minimal DOM stub (window listeners + rAF controllable) --------------

class FakeStyle {
  private readonly values = new Map<string, string>();
  setProperty(key: string, value: string): void { this.values.set(key, String(value)); }
  getPropertyValue(key: string): string { return this.values.get(key) ?? ""; }
  get(key: string): string | undefined { return this.values.get(key); }
}

interface FakeElement {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeElement | null;
  parentNode: FakeElement | null;
  childNodes: FakeElement[];
  style: FakeStyle;
  setAttribute(): void;
  removeAttribute(): void;
  hasAttribute(): boolean;
  getAttribute(): string | null;
  setPointerCapture(): void;
  releasePointerCapture(): void;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(c: FakeElement): FakeElement;
  insertBefore(c: FakeElement, ref: FakeElement): FakeElement;
  removeChild(c: FakeElement): FakeElement;
  contains(): boolean;
  cloneNode(): FakeElement;
  textContent: string;
  innerHTML: string;
}

function makeElement(tag: string, ownerDocument: FakeElement | null = null): FakeElement {
  const el: FakeElement = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument,
    parentNode: null,
    childNodes: [],
    style: new FakeStyle(),
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    getAttribute() { return null; },
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      const i = this.childNodes.indexOf(ref);
      if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    contains() { return false; },
    cloneNode() { return el; },
    textContent: "",
    innerHTML: "",
  };
  (el as unknown as { __uid?: number }).__uid = ++makeElement.uidCounter;
  return el;
}
makeElement.uidCounter = 0;

type Handler = (event: Record<string, unknown>) => void;

function installDomStub() {
  const windowListeners = new Map<string, Handler[]>();
  const documentListeners = new Map<string, Handler[]>();
  // rAF queue entries carry their id so cancelAnimationFrame can remove a
  // pending frame (the programmatic animation's stop path relies on it).
  const rafQueue: Array<{ id: number; fn: () => void }> = [];
  let rafId = 1;

  const documentElement = makeElement("html", null);
  const body = makeElement("body", null);
  const documentObj = {
    nodeType: 9,
    nodeName: "#document",
    tagName: "#document",
    parentNode: null,
    childNodes: [],
    style: new FakeStyle(),
    body,
    documentElement,
    visibilityState: "visible",
    createElement(tag: string) { return makeElement(tag, documentObj as unknown as FakeElement); },
    createElementNS(_ns: string, tag: string) { return makeElement(tag, documentObj as unknown as FakeElement); },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: "#text", textContent: text, parentNode: null, ownerDocument: documentObj } as unknown as FakeElement;
    },
    getElementById() { return null; },
    addEventListener(type: string, fn: Handler) {
      const list = documentListeners.get(type) ?? [];
      list.push(fn);
      documentListeners.set(type, list);
    },
    removeEventListener(type: string, fn: Handler) {
      documentListeners.set(type, (documentListeners.get(type) ?? []).filter((h) => h !== fn));
    },
    activeElement: null,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  };
  documentObj.body = makeElement("body", documentObj as unknown as FakeElement);
  documentObj.documentElement = makeElement("html", documentObj as unknown as FakeElement);

  const windowObj = {
    document: documentObj,
    navigator: { userAgent: "test", platform: "test", maxTouchPoints: 0 },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener(type: string, fn: Handler) {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    removeEventListener(type: string, fn: Handler) {
      windowListeners.set(type, (windowListeners.get(type) ?? []).filter((h) => h !== fn));
    },
    requestAnimationFrame(fn: () => void) { rafQueue.push({ id: rafId, fn }); return rafId++; },
    cancelAnimationFrame(id: number) {
      const idx = rafQueue.findIndex((entry) => entry.id === id);
      if (idx >= 0) rafQueue.splice(idx, 1);
    },
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  };

  // Another test file's stub may have left a global as a READ-ONLY
  // (defineProperty'd) property, where plain assignment throws
  // "Attempted to assign to readonly property" and kills every test in this
  // file depending on file order. (Re)define instead, keeping each ORIGINAL
  // descriptor so restore() puts back exactly what was there before.
  const savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
  const setGlobal = (name: string, value: unknown) => {
    savedGlobals.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setGlobal("document", documentObj);
  setGlobal("window", windowObj);
  setGlobal("navigator", windowObj.navigator);

  return {
    windowObj,
    documentObj,
    fireWindow(type: string, event: Record<string, unknown>) {
      for (const fn of windowListeners.get(type) ?? []) fn(event);
    },
    fireDocument(type: string, event: Record<string, unknown>) {
      for (const fn of documentListeners.get(type) ?? []) fn(event);
    },
    flushRaf() {
      const pending = rafQueue.splice(0, rafQueue.length);
      for (const entry of pending) entry.fn();
    },
    restore() {
      for (const [name, descriptor] of savedGlobals.reverse()) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

type HarnessApi = {
  isResizing: () => boolean;
  container: () => FakeElement | null;
  handlePointerDown: (event: Record<string, unknown>) => void;
  handlePointerUp: (event: Record<string, unknown>) => void;
  handlePointerAbort: (event: Record<string, unknown>) => void;
  notifyAvailableWidthChange: () => void;
};

// Deterministic scheduler for the resize state machine (no global timers).
const fakeScheduler: ResizeScheduler = {
  setTimeout: () => 1,
  clearTimeout: () => undefined,
  requestAnimationFrame: (fn: () => void) => { queueMicrotask(fn); return 1; },
  cancelAnimationFrame: () => undefined,
};

const Harness: React.FC<{
  id?: string;
  reverse?: boolean;
  initial?: number;
  onUserCommit?: (width: number) => void;
  transactionSource?: "left-sidebar" | "context-panel";
  programmaticTarget?: ProgrammaticPanelTarget | null;
  resolveFollowWidth?: () => number | null;
  programmaticDurationMs?: number;
  /** A React-managed style prop: proves re-renders never clobber --w. */
  styleProp?: React.CSSProperties;
}> = ({
  id = "default",
  reverse = false,
  initial = 200,
  onUserCommit = () => {},
  transactionSource = "left-sidebar",
  programmaticTarget = null,
  resolveFollowWidth,
  programmaticDurationMs,
  styleProp,
}) => {
  const { isResizing, containerRef, handlePointerDown, handlePointerUp, handlePointerAbort, notifyAvailableWidthChange } = usePanelResize({
    minWidth: 100,
    maxWidth: 500,
    onUserCommitWidth: onUserCommit,
    transactionSource,
    widthCssVariable: "--w",
    reverse,
    getCurrentWidth: () => initial,
    programmaticTarget,
    resolveFollowWidth,
    programmaticDurationMs,
  });
  React.useEffect(() => {
    const g = globalThis as unknown as { __resizeHarnessMap?: Record<string, HarnessApi> };
    g.__resizeHarnessMap = g.__resizeHarnessMap ?? {};
    g.__resizeHarnessMap[id] = {
      isResizing: () => isResizing,
      container: () => containerRef.current as unknown as FakeElement | null,
      handlePointerDown: handlePointerDown as unknown as HarnessApi["handlePointerDown"],
      handlePointerUp: handlePointerUp as unknown as HarnessApi["handlePointerUp"],
      handlePointerAbort: handlePointerAbort as unknown as HarnessApi["handlePointerAbort"],
      notifyAvailableWidthChange,
    };
  });
  return React.createElement("div", { ref: containerRef as React.Ref<HTMLDivElement>, style: styleProp });
};

const makePointerEvent = (overrides: Record<string, unknown>) => ({
  pointerId: 1,
  button: 0,
  isPrimary: true,
  clientX: 100,
  currentTarget: makeElement("div"),
  preventDefault() {},
  ...overrides,
});

let stub: ReturnType<typeof installDomStub> | null = null;
let root: Root | null = null;
let root2: Root | null = null;
let onCommitCalls: number[] = [];

const apiFor = (id: string): HarnessApi => {
  const g = globalThis as unknown as { __resizeHarnessMap?: Record<string, HarnessApi> };
  return g.__resizeHarnessMap![id];
};

beforeEach(() => {
  stub = installDomStub();
  setResizeSchedulerForTests(fakeScheduler);
  resetResizeInteractionForTests();
  resetResizeFrameParticipantsForTests();
  onCommitCalls = [];
});

afterEach(async () => {
  // Unmount inside act: the hook's unmount cleanups may flip isResizing and
  // must not produce "update not wrapped in act" warnings.
  await act(async () => {
    root?.unmount();
    root = null;
    root2?.unmount();
    root2 = null;
  });
  // Let React's scheduler flush any deferred (macrotask) work BEFORE the DOM
  // stub is removed — otherwise that work runs with window=undefined.
  await new Promise((resolve) => setTimeout(resolve, 10));
  stub?.restore();
  stub = null;
  delete (globalThis as unknown as { __resizeHarnessMap?: Record<string, HarnessApi> }).__resizeHarnessMap;
});

const renderHarness = (host: { root: Root | null; container: FakeElement | null }, id: string, props: React.ComponentProps<typeof Harness>) => {
  const container = host.container ?? stub!.documentObj.createElement("div");
  if (!host.container) {
    stub!.documentObj.body.appendChild(container);
    host.container = container;
  }
  host.root = createRoot(container as unknown as HTMLElement);
  return act(async () => {
    host.root!.render(React.createElement(Harness, { id, ...props }));
  });
};

// The harness re-exposes itself on every render (its useEffect replaces the
// map entry), so hand back a proxy that always reads the LATEST one.
const proxyApi = (id: string): HarnessApi => ({
  isResizing: () => apiFor(id).isResizing(),
  container: () => apiFor(id).container(),
  handlePointerDown: (e: Record<string, unknown>) => apiFor(id).handlePointerDown(e),
  handlePointerUp: (e: Record<string, unknown>) => apiFor(id).handlePointerUp(e),
  handlePointerAbort: (e: Record<string, unknown>) => apiFor(id).handlePointerAbort(e),
  notifyAvailableWidthChange: () => apiFor(id).notifyAvailableWidthChange(),
});

const mount = async (props: React.ComponentProps<typeof Harness>) => {
  // A second mount in the same test must not leak the previous root: the
  // leaked harness's effects (rAF/animation) would keep running against the
  // NEXT test's fresh DOM stub and pollute its assertions.
  await act(async () => {
    root?.unmount();
    root = null;
  });
  const host = { root: null as Root | null, container: null as FakeElement | null };
  await renderHarness(host, "default", props);
  root = host.root;
  return proxyApi("default");
};

const mountSecond = async (props: React.ComponentProps<typeof Harness>) => {
  await act(async () => {
    root2?.unmount();
    root2 = null;
  });
  const host = { root: null as Root | null, container: null as FakeElement | null };
  await renderHarness(host, "second", props);
  root2 = host.root;
  return proxyApi("second");
};
const startDrag = async (api: HarnessApi, clientX: number) => {
  const handle = makeElement("div");
  await act(async () => {
    api.handlePointerDown(makePointerEvent({ clientX, currentTarget: handle }));
  });
  return handle;
};

describe("usePanelResize drag lifecycle", () => {
  test("pointerdown flips isResizing to true (P0 regression)", async () => {
    const api = await mount({});
    expect(api.isResizing()).toBe(false);
    await startDrag(api, 100);
    expect(api.isResizing()).toBe(true);
  });

  test("pointermove 100px changes the CSS width by 100±1 before pointerup", async () => {
    const api = await mount({ initial: 200 });
    await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 200 });
    stub!.flushRaf();
    const width = Number.parseFloat(api.container()!.style.get("--w") ?? "");
    expect(Math.abs(width - 300) <= 1).toBe(true);
  });

  test("left handle (default direction) widens when dragging right", async () => {
    const api = await mount({ initial: 200 });
    await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 250 });
    stub!.flushRaf();
    const width = Number.parseFloat(api.container()!.style.get("--w") ?? "");
    expect(width).toBeGreaterThan(200);
  });

  test("reverse handle widens when dragging left", async () => {
    const api = await mount({ initial: 200, reverse: true });
    await startDrag(api, 300);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 200 });
    stub!.flushRaf();
    const width = Number.parseFloat(api.container()!.style.get("--w") ?? "");
    expect(width).toBeGreaterThan(200);
  });

  test("pointerup persists exactly once", async () => {
    const api = await mount({ initial: 200, onUserCommit: (w) => onCommitCalls.push(w) });
    const handle = await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 250 });
    stub!.flushRaf();
    await act(async () => {
      api.handlePointerUp(makePointerEvent({ clientX: 250, currentTarget: handle }));
    });
    expect(onCommitCalls).toHaveLength(1);
    expect(api.isResizing()).toBe(false);
  });

  test("pointercancel does not persist and ends the drag", async () => {
    const api = await mount({ initial: 200, onUserCommit: (w) => onCommitCalls.push(w) });
    await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 250 });
    stub!.flushRaf();
    await act(async () => {
      api.handlePointerAbort(makePointerEvent({ pointerId: 1 }));
    });
    expect(onCommitCalls).toHaveLength(0);
    expect(api.isResizing()).toBe(false);
  });

  test("window blur does not persist", async () => {
    const api = await mount({ initial: 200, onUserCommit: (w) => onCommitCalls.push(w) });
    await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 250 });
    stub!.flushRaf();
    await act(async () => {
      stub!.fireWindow("blur", {});
    });
    expect(onCommitCalls).toHaveLength(0);
    expect(api.isResizing()).toBe(false);
  });

  test("visibilitychange hidden does not persist; visible is a no-op", async () => {
    const api = await mount({ initial: 200, onUserCommit: (w) => onCommitCalls.push(w) });
    await startDrag(api, 100);
    // visible -> nothing
    stub!.documentObj.visibilityState = "visible";
    await act(async () => {
      stub!.fireDocument("visibilitychange", {});
    });
    expect(onCommitCalls).toHaveLength(0);
    // hidden -> cancel
    stub!.documentObj.visibilityState = "hidden";
    await act(async () => {
      stub!.fireDocument("visibilitychange", {});
    });
    expect(onCommitCalls).toHaveLength(0);
    expect(api.isResizing()).toBe(false);
  });

  test("a second consecutive drag still works after pointerup", async () => {
    const api = await mount({ initial: 200, onUserCommit: (w) => onCommitCalls.push(w) });
    // First drag
    let handle = await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 220 });
    stub!.flushRaf();
    await act(async () => {
      api.handlePointerUp(makePointerEvent({ clientX: 220, currentTarget: handle }));
    });
    // Second drag with a fresh pointer id
    handle = makeElement("div");
    await act(async () => {
      api.handlePointerDown(makePointerEvent({ pointerId: 2, clientX: 220, currentTarget: handle }));
    });
    expect(api.isResizing()).toBe(true);
    stub!.fireWindow("pointermove", { pointerId: 2, clientX: 320 });
    stub!.flushRaf();
    await act(async () => {
      api.handlePointerUp(makePointerEvent({ pointerId: 2, clientX: 320, currentTarget: handle }));
    });
    expect(onCommitCalls).toHaveLength(2);
  });

  test("root phase transitions dragging -> finalizing -> idle (transaction)", async () => {
    const txId = beginResizeInteraction("left-sidebar");
    void txId;
    const api = await mount({});
    await startDrag(api, 100);
    expect(api.isResizing()).toBe(true);
    const handle = makeElement("div");
    await act(async () => {
      api.handlePointerUp(makePointerEvent({ currentTarget: handle }));
    });
    expect(api.isResizing()).toBe(false);
  });

  test("live width frames notify resize frame participants with transactionId/width/kind", async () => {
    const seen: Array<{ transactionId: number; width: number; kind: string }> = [];
    const unsubscribe = registerResizeFrameParticipant((frame) => { seen.push({ ...frame }); });
    const api = await mount({ initial: 200 });
    await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 200 });
    stub!.flushRaf();
    expect(seen.length).toBe(1);
    expect(seen[0].width).toBe(300);
    expect(seen[0].kind).toBe("drag");
    expect(typeof seen[0].transactionId).toBe("number");
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 250 });
    stub!.flushRaf();
    expect(seen.length).toBe(2);
    expect(seen[1].width).toBe(350);
    expect(seen[1].kind).toBe("drag");
    unsubscribe();
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 300 });
    stub!.flushRaf();
    expect(seen.length).toBe(2);
  });
});

// --- Programmatic width animation (quick open/close toggles, mode switches) --
describe("programmatic resize targets", () => {
  const realNow = performance.now.bind(performance);
  let fakeTime = 0;
  let realMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    fakeTime = 0;
    realMatchMedia = window.matchMedia;
    // Replace ONLY the now() method — spreading performance would drop the
    // prototype methods (mark/measure) React's render timing relies on.
    (globalThis as unknown as { performance: typeof performance }).performance.now = () => fakeTime;
  });

  afterEach(() => {
    (globalThis as unknown as { performance: typeof performance }).performance.now = realNow;
    if (realMatchMedia) window.matchMedia = realMatchMedia;
  });

  const width = (api: HarnessApi) => Number.parseFloat(api.container()!.style.get("--w") ?? "");

  test("animates monotonically to the target, commits once, and ends the transaction", async () => {
    const onUserCommit: number[] = [];
    // Initial mount: the first target writes the final width WITHOUT a
    // transaction (component bootstrap).
    const api = await mount({
      initial: 200,
      programmaticTarget: { key: "open", width: 200, cause: "visibility" },
      onUserCommit: (w) => onUserCommit.push(w),
    });
    expect(width(api)).toBe(200);
    expect(getResizeInteractionPhase()).toBe("idle");
    // Target change: animate 200 -> 300 over 200ms.
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 300, cause: "visibility" },
        onUserCommit: (w) => onUserCommit.push(w),
      }));
    });
    expect(getResizeInteractionPhase()).toBe("dragging");
    // Intermediate frames: monotonic increase toward 300.
    let last = 200;
    for (let i = 0; i < 12; i += 1) {
      fakeTime += 20;
      await act(async () => { stub!.flushRaf(); });
      const w = width(api);
      expect(w).toBeGreaterThanOrEqual(last);
      expect(w <= 300).toBe(true);
      last = w;
    }
    // After the duration has elapsed the final frame commits exactly once.
    fakeTime += 100;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(300);
    // Programmatic animation NEVER persists the width (user intent only).
    expect(onUserCommit).toEqual([]);
    expect(api.isResizing()).toBe(false);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("same key and near-identical width start NO transaction", async () => {
    const api = await mount({ initial: 200, programmaticTarget: { key: "open", width: 200, cause: "visibility" } });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 200, cause: "visibility" },
      }));
    });
    expect(getResizeInteractionPhase()).toBe("idle");
    expect(api.isResizing()).toBe(false);
  });

  test("a target change mid-animation re-directs from the CURRENT width (no jump back)", async () => {
    const api = await mount({ initial: 200, programmaticTarget: { key: "open", width: 200, cause: "visibility" } });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 300, cause: "visibility" },
      }));
    });
    fakeTime += 60; // ~1/3 of the way
    await act(async () => { stub!.flushRaf(); });
    const mid = width(api);
    expect(mid).toBeGreaterThan(200);
    expect(mid).toBeLessThan(300);
    // Re-direct to 400 from the CURRENT width.
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open2", width: 400, cause: "visibility" },
      }));
    });
    expect(width(api)).toBe(mid); // No jump back to 200.
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(400);
  });

  test("expand/collapse (mode cause, key change) animates from the current width", async () => {
    const api = await mount({ initial: 300, programmaticTarget: { key: "open:file", width: 300, cause: "mode" } });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 300,
        programmaticTarget: { key: "expand:file", width: 450, cause: "mode" },
      }));
    });
    // Re-direct from the current (300) width; the first frame must be between.
    fakeTime += 60;
    await act(async () => { stub!.flushRaf(); });
    const mid = width(api);
    expect(mid).toBeGreaterThan(300);
    expect(mid).toBeLessThan(450);
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(450);
  });

  test("a pointerdown mid-animation hands over from the current width", async () => {
    const api = await mount({ initial: 200, programmaticTarget: { key: "open", width: 200, cause: "visibility" } });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 300, cause: "visibility" },
      }));
    });
    fakeTime += 60;
    await act(async () => { stub!.flushRaf(); });
    const mid = width(api);
    // Pointer takes over.
    const handle = makeElement("div");
    await act(async () => {
      api.handlePointerDown(makePointerEvent({ clientX: 100, currentTarget: handle }));
    });
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 160 });
    await act(async () => { stub!.flushRaf(); });
    // The width now follows the pointer from the mid-animation value.
    expect(width(api)).toBe(mid + 60);
  });

  test("unmounting mid-animation cancels the transaction", async () => {
    const api = await mount({ initial: 200, programmaticTarget: { key: "open", width: 200, cause: "visibility" } });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 300, cause: "visibility" },
      }));
    });
    fakeTime += 40;
    await act(async () => { stub!.flushRaf(); });
    expect(getResizeInteractionPhase()).toBe("dragging");
    await act(async () => {
      root!.unmount();
      root = null;
    });
    // Unmount cancels the transaction; the finalizing -> idle edge is
    // microtask-flushed by the fake scheduler.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(getResizeInteractionPhase()).toBe("idle");
    void api;
  });
});

// --- Round 10: single writer, legal 0 target, no programmatic persistence ---
describe("round 10: single width writer and legal close target", () => {
  const realNow = performance.now.bind(performance);
  let fakeTime = 0;

  beforeEach(() => {
    fakeTime = 0;
    (globalThis as unknown as { performance: typeof performance }).performance.now = () => fakeTime;
  });

  afterEach(() => {
    (globalThis as unknown as { performance: typeof performance }).performance.now = realNow;
  });

  const width = (api: HarnessApi) => Number.parseFloat(api.container()!.style.get("--w") ?? "");

  test("close target 0 is legal and animates to 0 below minWidth", async () => {
    // minWidth is 100 — a closed panel must reach exactly 0, not 100.
    const api = await mount({ initial: 300, programmaticTarget: { key: "open", width: 300, cause: "visibility" } });
    expect(width(api)).toBe(300);
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 300,
        programmaticTarget: { key: "close", width: 0, cause: "visibility" },
      }));
    });
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(0);
  });

  test("programmatic open and close never call onUserCommitWidth", async () => {
    const onUserCommit: number[] = [];
    const api = await mount({
      initial: 200,
      programmaticTarget: { key: "close", width: 0, cause: "visibility" },
      onUserCommit: (w) => onUserCommit.push(w),
    });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 300, cause: "visibility" },
        onUserCommit: (w) => onUserCommit.push(w),
      }));
    });
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(300);
    // Close again.
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "close", width: 0, cause: "visibility" },
        onUserCommit: (w) => onUserCommit.push(w),
      }));
    });
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(0);
    expect(onUserCommit).toEqual([]);
  });

  test("a React re-render cannot overwrite the hook-written CSS variable", async () => {
    const styleProp = { backgroundColor: "red" as const };
    const api = await mount({
      initial: 200,
      programmaticTarget: { key: "open", width: 200, cause: "visibility" },
      styleProp,
    });
    // Hook animates the width to 340.
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 340, cause: "visibility" },
        styleProp,
      }));
    });
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(340);
    // React-managed style changes (re-render) must not clobber --w.
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 340, cause: "visibility" },
        styleProp: { backgroundColor: "blue" },
      }));
    });
    expect(width(api)).toBe(340);
  });

  test("a close target mid-drag hands over in the SAME transaction and never persists", async () => {
    const onUserCommit: number[] = [];
    const api = await mount({ initial: 300, onUserCommit: (w) => onUserCommit.push(w) });
    // Pointer drag moves the panel to ~380.
    await startDrag(api, 100);
    stub!.fireWindow("pointermove", { pointerId: 1, clientX: 180 });
    stub!.flushRaf();
    expect(width(api)).toBe(380);
    const txDuringDrag = getCurrentResizeTransactionId();
    expect(txDuringDrag).not.toBeNull();
    // Semantic close arrives mid-drag: the SAME transaction continues the
    // animation 380 -> 0 (no release, no new transaction, no persistence).
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 300,
        programmaticTarget: { key: "close", width: 0, cause: "visibility" },
        onUserCommit: (w) => onUserCommit.push(w),
      }));
    });
    expect(getCurrentResizeTransactionId()).toBe(txDuringDrag);
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(0);
    expect(onUserCommit).toEqual([]);
    expect(api.isResizing()).toBe(false);
    expect(getResizeInteractionPhase()).toBe("idle");
    // Re-open from 0 (drag already handed over; no user persistence).
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 300,
        programmaticTarget: { key: "open", width: 300, cause: "visibility" },
        onUserCommit: (w) => onUserCommit.push(w),
      }));
    });
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(300);
    expect(onUserCommit).toEqual([]);
  });
});

// --- Round 10: parent-layout follow + shared transaction -------------------
describe("round 10: parent-layout follow and shared transaction", () => {
  const realNow = performance.now.bind(performance);
  let fakeTime = 0;

  beforeEach(() => {
    fakeTime = 0;
    (globalThis as unknown as { performance: typeof performance }).performance.now = () => fakeTime;
  });

  afterEach(() => {
    (globalThis as unknown as { performance: typeof performance }).performance.now = realNow;
  });

  const width = (api: HarnessApi) => Number.parseFloat(api.container()!.style.get("--w") ?? "");

  test("a parent-layout width change opens a short transaction and follows the new width", async () => {
    let parentWidth = 600;
    const api = await mount({
      initial: 300,
      programmaticTarget: { key: "open:mode", width: 300, cause: "parent-layout" },
      resolveFollowWidth: () => Math.round(0.5 * parentWidth),
    });
    expect(width(api)).toBe(300);
    expect(getResizeInteractionPhase()).toBe("idle");
    // ResizeObserver-style wake-up: parent grows -> follow re-resolves to 350.
    parentWidth = 700;
    await act(async () => {
      api.notifyAvailableWidthChange();
      stub!.flushRaf();
    });
    expect(width(api)).toBe(350);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("parent width changes during an open animation re-resolve the goal without restarting the clock", async () => {
    let parentWidth = 600; // 0.5 * 600 = 300
    const api = await mount({
      initial: 0,
      programmaticTarget: { key: "close", width: 0, cause: "visibility" },
      resolveFollowWidth: () => Math.round(0.5 * parentWidth),
    });
    // Open toward 300 (parent-layout cause, key change -> animate).
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 0,
        programmaticTarget: { key: "open:mode", width: 300, cause: "parent-layout" },
        resolveFollowWidth: () => Math.round(0.5 * parentWidth),
      }));
    });
    fakeTime += 60;
    await act(async () => { stub!.flushRaf(); });
    const mid = width(api);
    expect(mid).toBeGreaterThan(0);
    // Parent changes mid-animation: the goal must move 300 -> 350 WITHOUT
    // restarting (the animation never jumps back to the start width).
    parentWidth = 700;
    fakeTime += 60;
    await act(async () => { stub!.flushRaf(); });
    const mid2 = width(api);
    expect(mid2).toBeGreaterThanOrEqual(mid);
    fakeTime += 200;
    await act(async () => { stub!.flushRaf(); });
    // Lands on the FINAL parent-derived goal.
    expect(width(api)).toBe(350);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("a closed panel ignores parent-layout changes (no follow, no transaction)", async () => {
    let parentWidth = 600;
    const api = await mount({
      initial: 0,
      programmaticTarget: { key: "close:mode", width: 0, cause: "visibility" },
      resolveFollowWidth: () => (parentWidth === 600 ? null : Math.round(0.5 * parentWidth)),
    });
    expect(width(api)).toBe(0);
    parentWidth = 800;
    await act(async () => {
      api.notifyAvailableWidthChange();
      stub!.flushRaf();
    });
    // resolveFollowWidth returns null while closed -> nothing happens.
    expect(width(api)).toBe(0);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("left and right panels changing together share ONE global transaction", async () => {
    const left = await mount({
      initial: 200,
      programmaticTarget: { key: "open", width: 200, cause: "visibility" },
    });
    // Left animates 200 -> 300, opening transaction T.
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 200,
        programmaticTarget: { key: "open", width: 300, cause: "visibility" },
      }));
    });
    const txId = getCurrentResizeTransactionId();
    expect(txId).not.toBeNull();
    // Right panel starts its own animation mid-left-transition: it must JOIN T
    // (no second transaction, no re-capture).
    const right = await mountSecond({
      transactionSource: "context-panel",
      initial: 200,
      programmaticTarget: { key: "open:mode", width: 200, cause: "visibility" },
    });
    await act(async () => {
      root2!.render(React.createElement(Harness, {
        id: "second",
        transactionSource: "context-panel",
        initial: 200,
        programmaticTarget: { key: "open:mode", width: 260, cause: "visibility" },
      }));
    });
    expect(getCurrentResizeTransactionId()).toBe(txId);
    // Let both finish; the transaction finalizes exactly once.
    fakeTime += 300;
    await act(async () => { stub!.flushRaf(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(getResizeInteractionPhase()).toBe("idle");
    expect(width(left)).toBe(300);
    expect(width(right)).toBe(260);
  });
});

// --- Round 11: motion profiles (standard 200ms / reduced 120ms) -----------
describe("round 11: motion profiles (standard 200ms / reduced 120ms)", () => {
  const realNow = performance.now.bind(performance);
  let realMatchMedia: typeof window.matchMedia;
  let fakeTime = 0;
  let reducedMotion = false;
  let mediaListeners: Array<(matches: boolean) => void> = [];

  const setReducedMotion = (reduced: boolean) => {
    reducedMotion = reduced;
    for (const listener of [...mediaListeners]) listener(reduced);
  };

  const installControllableMedia = () => {
    reducedMotion = false;
    mediaListeners = [];
    const stubMedia = () => ({
      get matches() { return reducedMotion; },
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      dispatchEvent: () => false,
      addEventListener(_type: string, fn: (event: { matches: boolean }) => void) {
        mediaListeners.push((matches) => fn({ matches }));
      },
      removeEventListener(_type: string, fn: (event: { matches: boolean }) => void) {
        const index = mediaListeners.findIndex((candidate) => candidate.toString() === ((m: boolean) => fn({ matches: m })).toString());
        if (index >= 0) mediaListeners.splice(index, 1);
      },
      addListener(fn: (event: { matches: boolean }) => void) {
        mediaListeners.push((matches) => fn({ matches }));
      },
      removeListener(fn: (event: { matches: boolean }) => void) {
        const index = mediaListeners.findIndex((candidate) => candidate.toString() === ((m: boolean) => fn({ matches: m })).toString());
        if (index >= 0) mediaListeners.splice(index, 1);
      },
    }) as unknown as MediaQueryList;
    window.matchMedia = stubMedia as unknown as typeof window.matchMedia;
  };

  beforeEach(() => {
    fakeTime = 0;
    realMatchMedia = window.matchMedia;
    installControllableMedia();
    (globalThis as unknown as { performance: typeof performance }).performance.now = () => fakeTime;
  });

  afterEach(() => {
    (globalThis as unknown as { performance: typeof performance }).performance.now = realNow;
    if (realMatchMedia) window.matchMedia = realMatchMedia;
  });

  const width = (api: HarnessApi) => Number.parseFloat(api.container()!.style.get("--w") ?? "");

  const driveToTarget = async (api: HarnessApi, target: number, steps: number, stepMs = 20): Promise<number[]> => {
    const widths: number[] = [];
    for (let i = 0; i < steps; i += 1) {
      fakeTime += stepMs;
      await act(async () => { stub!.flushRaf(); });
      widths.push(width(api));
      if (widths[widths.length - 1] === target) break;
    }
    return widths;
  };

  const renderTarget = (target: { key: string; width: number; cause: "visibility" | "mode" }, extra: React.ComponentProps<typeof Harness> = {}) => act(async () => {
    root!.render(React.createElement(Harness, {
      initial: 0,
      programmaticTarget: target,
      ...extra,
    }));
  });

  test("standard mode animates 0→280 over ~200ms with strictly increasing widths (open)", async () => {
    const api = await mount({ initial: 0, programmaticTarget: { key: "close", width: 0, cause: "visibility" } });
    await renderTarget({ key: "open", width: 280, cause: "visibility" });
    const widths = await driveToTarget(api, 280, 20);
    expect(width(api)).toBe(280);
    // First applied frame is NOT the target (no instant jump).
    expect(widths[0]).not.toBe(280);
    // Multiple strictly increasing intermediate widths (no jumps back).
    const distinct = new Set(widths).size;
    expect(distinct).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
    // Completed at ~200ms (10 steps of 20ms), not later.
    expect(widths.length <= 11).toBe(true);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("standard mode animates 280→0 over ~200ms (close)", async () => {
    const api = await mount({ initial: 0, programmaticTarget: { key: "open", width: 280, cause: "visibility" } });
    await renderTarget({ key: "close", width: 0, cause: "visibility" });
    const widths = await driveToTarget(api, 0, 20);
    expect(width(api)).toBe(0);
    expect(widths[0]).not.toBe(0);
    expect(new Set(widths).size).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i] <= widths[i - 1]).toBe(true);
    }
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("reduced mode animates 0→280 over ~120ms with >= 4 distinct widths (open)", async () => {
    setReducedMotion(true);
    const api = await mount({ initial: 0, programmaticTarget: { key: "close", width: 0, cause: "visibility" } });
    await renderTarget({ key: "open", width: 280, cause: "visibility" });
    const widths = await driveToTarget(api, 280, 12);
    expect(width(api)).toBe(280);
    // No single-frame 0→280 jump.
    expect(widths[0]).not.toBe(280);
    expect(new Set(widths).size).toBeGreaterThanOrEqual(4);
    // Completed at ~120ms (6 steps of 20ms), not at 200ms.
    expect(widths.length <= 7).toBe(true);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("reduced mode animates 280→0 over ~120ms (close)", async () => {
    setReducedMotion(true);
    const api = await mount({ initial: 0, programmaticTarget: { key: "open", width: 280, cause: "visibility" } });
    await renderTarget({ key: "close", width: 0, cause: "visibility" });
    const widths = await driveToTarget(api, 0, 12);
    expect(width(api)).toBe(0);
    expect(widths[0]).not.toBe(0);
    expect(new Set(widths).size).toBeGreaterThanOrEqual(4);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("neither mode ever calls onUserCommitWidth", async () => {
    const onUserCommit: number[] = [];
    // Standard open+close.
    let api = await mount({
      initial: 0,
      programmaticTarget: { key: "close", width: 0, cause: "visibility" },
      onUserCommit: (w) => onUserCommit.push(w),
    });
    await renderTarget({ key: "open", width: 280, cause: "visibility" }, { onUserCommit: (w) => onUserCommit.push(w) });
    await driveToTarget(api, 280, 20);
    await renderTarget({ key: "close", width: 0, cause: "visibility" }, { onUserCommit: (w) => onUserCommit.push(w) });
    await driveToTarget(api, 0, 20);
    // Reduced open+close.
    setReducedMotion(true);
    api = await mount({
      initial: 0,
      programmaticTarget: { key: "close", width: 0, cause: "visibility" },
      onUserCommit: (w) => onUserCommit.push(w),
    });
    await renderTarget({ key: "open", width: 280, cause: "visibility" }, { onUserCommit: (w) => onUserCommit.push(w) });
    await driveToTarget(api, 280, 12);
    await renderTarget({ key: "close", width: 0, cause: "visibility" }, { onUserCommit: (w) => onUserCommit.push(w) });
    await driveToTarget(api, 0, 12);
    expect(onUserCommit).toEqual([]);
    void api;
  });

  test("a motion-preference change mid-animation affects only the NEXT animation", async () => {
    const api = await mount({ initial: 0, programmaticTarget: { key: "close", width: 0, cause: "visibility" } });
    // Standard open (200ms profile snapshotted at start).
    await renderTarget({ key: "open", width: 280, cause: "visibility" });
    fakeTime += 60;
    await act(async () => { stub!.flushRaf(); });
    const mid = width(api);
    expect(mid).toBeGreaterThan(0);
    // System preference flips to reduce MID-animation.
    setReducedMotion(true);
    // The running animation must stay on the 200ms schedule: at 120ms total
    // (t=0.6) it is still short of the target. A live profile switch to 120ms
    // would have finished it here.
    fakeTime += 60;
    await act(async () => { stub!.flushRaf(); });
    const mid2 = width(api);
    expect(mid2).toBeLessThan(280);
    // Complete the current animation.
    fakeTime += 100;
    await act(async () => { stub!.flushRaf(); });
    expect(width(api)).toBe(280);
    // The NEXT animation uses the reduced 120ms profile.
    await renderTarget({ key: "close", width: 0, cause: "visibility" });
    const closeWidths = await driveToTarget(api, 0, 12);
    expect(width(api)).toBe(0);
    expect(new Set(closeWidths).size).toBeGreaterThanOrEqual(4);
  });

  test("programmaticDurationMs 0 is the ONLY single-frame path (explicit test config)", async () => {
    const api = await mount({
      initial: 0,
      programmaticTarget: { key: "close", width: 0, cause: "visibility" },
      programmaticDurationMs: 0,
    });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 0,
        programmaticTarget: { key: "open", width: 280, cause: "visibility" },
        programmaticDurationMs: 0,
      }));
    });
    // True single-frame jump only when explicitly configured.
    expect(width(api)).toBe(280);
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("first mount still writes the initial width silently (no animation, no transaction)", async () => {
    const api = await mount({ initial: 0, programmaticTarget: { key: "open", width: 280, cause: "visibility" } });
    expect(width(api)).toBe(280);
    expect(getResizeInteractionPhase()).toBe("idle");
    expect(api.isResizing()).toBe(false);
  });

  test("unchanged target keeps zero transactions and zero width writes", async () => {
    const api = await mount({ initial: 0, programmaticTarget: { key: "open", width: 280, cause: "visibility" } });
    await act(async () => {
      root!.render(React.createElement(Harness, {
        initial: 0,
        programmaticTarget: { key: "open", width: 280, cause: "visibility" },
      }));
    });
    expect(getResizeInteractionPhase()).toBe("idle");
    expect(width(api)).toBe(280);
  });
});

// --- Review follow-up: follow-during-drag joins the shared transaction ----
describe("follow-during-drag joins the shared transaction", () => {
  const widthOf = (api: HarnessApi) => Number.parseFloat(api.container()!.style.get("--w") ?? "");

  test("a parent-layout follow riding a pointer drag JOINS the transaction: its frames carry the drag's transactionId and no re-capture fires", async () => {
    const frames: Array<{ transactionId: number; kind: string; origin: string; source: string }> = [];
    const starts: Array<{ transactionId: number; source: string; origin: string }> = [];
    registerResizeFrameParticipant((frame) => frames.push({ ...frame }));
    registerResizeTransactionStartParticipant((start) => starts.push({ ...start }));

    // Left sidebar pointer drag opens transaction T.
    const left = await mount({ initial: 200 });
    let followWidth: number | null = 300;
    const right = await mountSecond({
      transactionSource: "context-panel",
      initial: 300,
      programmaticTarget: { key: "open:mode", width: 300, cause: "parent-layout" },
      resolveFollowWidth: () => followWidth,
    });
    await startDrag(left, 100);
    const txId = getCurrentResizeTransactionId();
    expect(txId).not.toBeNull();

    // Parent layout changes mid-drag: the right panel wakes up and follows.
    followWidth = 340;
    await act(async () => {
      right.notifyAvailableWidthChange();
      stub!.flushRaf();
    });
    // The follow frame was written WHILE RIDING, and it carries the drag's
    // transactionId — not 0 (a dropped frame would delay the anchor by one).
    const followFrames = frames.filter((f) => f.source === "context-panel");
    expect(followFrames.length).toBe(1);
    expect(followFrames[0]!.transactionId).toBe(txId);
    expect(followFrames[0]!.origin).toBe("programmatic");
    expect(widthOf(right)).toBe(340);

    // Joining must NOT re-fire the transaction-start capture: the anchor
    // baseline stays the left drag's ORIGINAL capture (no re-anchor).
    expect(starts.length).toBe(1);
    expect(starts[0]!.source).toBe("left-sidebar");

    // The follow width stabilizes: the right panel finalizes ITS part while
    // the transaction stays open for the still-dragging left panel.
    await act(async () => { stub!.flushRaf(); });
    const rightFrames = frames.filter((f) => f.source === "context-panel");
    expect(rightFrames[rightFrames.length - 1]!.kind).toBe("final");
    expect(rightFrames.every((f) => f.transactionId === txId)).toBe(true);
    expect(getResizeInteractionPhase()).toBe("dragging");

    // Pointerup: the left drag releases and the transaction finalizes once.
    await act(async () => {
      left.handlePointerUp(makePointerEvent({ clientX: 100 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getResizeInteractionPhase()).toBe("idle");
  });

  test("a follow that detaches mid-drag releases its part; the other drag still owns and finalizes the transaction", async () => {
    const left = await mount({ initial: 200 });
    let followWidth: number | null = 300;
    const right = await mountSecond({
      transactionSource: "context-panel",
      initial: 300,
      programmaticTarget: { key: "open:mode", width: 300, cause: "parent-layout" },
      resolveFollowWidth: () => followWidth,
    });
    await startDrag(left, 100);
    const txId = getCurrentResizeTransactionId();
    expect(txId).not.toBeNull();
    followWidth = 340;
    await act(async () => {
      right.notifyAvailableWidthChange();
      stub!.flushRaf();
    });
    // The follow detaches mid-drag (resolveFollowWidth -> null): it must
    // release its registration so the shared transaction is not held open
    // by a ghost source.
    followWidth = null;
    await act(async () => {
      right.notifyAvailableWidthChange();
      stub!.flushRaf();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getResizeInteractionPhase()).toBe("dragging");
    expect(getCurrentResizeTransactionId()).toBe(txId);
    // The left drag can still finalize the shared transaction.
    await act(async () => {
      left.handlePointerUp(makePointerEvent({ clientX: 100 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(getResizeInteractionPhase()).toBe("idle");
  });
});

