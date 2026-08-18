/**
 * Regression test for issue #2053: stale-closure bug in NumberInput's
 * stepper buttons when clicked in rapid succession.
 *
 * The desktop stepper buttons (`+` / `-`) read their base value from a
 * closure captured at render time. When the user clicks `-` and `+` in rapid
 * succession, the parent state round-trip (click → onValueChange → parent
 * store update → re-render with new value) hasn't completed yet, so both
 * closures read the same stale value. The fix routes the stepper math
 * through a ref that is updated synchronously inside `commitValue`, so
 * back-to-back clicks within the same render cycle operate on the most
 * recent committed value.
 *
 * The test mounts the real `NumberInput` via `createRoot` against a minimal
 * `document`/`window` stub (Bun's test runner does not provide a DOM by
 * default) and drives the stepper buttons by invoking the React-internal
 * `__reactProps$*` onClick handlers directly. This lets us call the exact
 * closure that the production code binds to the button — which is the
 * only way to exercise the closure-staleness bug deterministically.
 */

import { describe, expect, mock, test } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n";
import { NumberInput } from "./number-input";

// --- Minimal DOM stub ----------------------------------------------------

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  classList: FakeClassList;
  [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  createElement(tag: string): FakeNode;
  createElementNS(_: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  getElementById(_: string): FakeNode | null;
  activeElement: FakeNode | null;
  HTMLIFrameElement: unknown;
  HTMLFrameSetElement: unknown;
  HTMLInputElement: unknown;
  HTMLTextAreaElement: unknown;
  HTMLSelectElement: unknown;
  HTMLOptionElement: unknown;
  HTMLAnchorElement: unknown;
}

interface FakeWindow {
  document: FakeDocument;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  matchMedia(query: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
  addEventListener(): void;
  removeEventListener(): void;
  HTMLIFrameElement: unknown;
  HTMLFrameSetElement: unknown;
  HTMLInputElement: unknown;
  HTMLTextAreaElement: unknown;
  HTMLSelectElement: unknown;
  HTMLOptionElement: unknown;
  HTMLAnchorElement: unknown;
}

class FakeClassList {
  private readonly classes = new Set<string>();
  add(...c: string[]): void { c.forEach((x) => this.classes.add(x)); }
  remove(...c: string[]): void { c.forEach((x) => this.classes.delete(x)); }
  contains(c: string): boolean { return this.classes.has(c); }
  toString(): string { return [...this.classes].join(" "); }
}

function makeNode(tag: string, owner: FakeDocument): FakeNode {
  const style: Record<string, unknown> = {
    setProperty() { /* noop */ },
    getPropertyValue() { return ""; },
  };
  const node: FakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    style,
    classList: new FakeClassList(),
    setAttribute() { /* noop */ },
    removeAttribute() { /* noop */ },
    hasAttribute() { return false; },
    getAttribute() { return null; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    appendChild(c: FakeNode) { this.childNodes.push(c); c.parentNode = this; return c; },
    insertBefore(c: FakeNode, ref: FakeNode) {
      const i = this.childNodes.indexOf(ref);
      if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      return c;
    },
    removeChild(c: FakeNode) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    contains() { return false; },
    cloneNode() { return node; },
    compareDocumentPosition() { return 0; },
    focus() { /* noop */ },
    blur() { /* noop */ },
    click() { /* noop */ },
    textContent: "",
    innerHTML: "",
  };
  return node;
}

function installDomStub(): { document: FakeDocument; restore: () => void } {
  const document = {
    nodeType: 9,
    nodeName: "#document",
    tagName: "#document",
    parentNode: null,
    childNodes: [],
    style: {},
    classList: new FakeClassList(),
    setAttribute() { /* noop */ },
    getAttribute() { return null; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    appendChild() { return undefined; },
    insertBefore() { return undefined; },
    removeChild() { return undefined; },
    getElementById() { return null; },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: "#text", textContent: text, parentNode: null } as unknown as FakeNode;
    },
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    activeElement: null,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as unknown as FakeDocument;

  document.defaultView = {
    document: document as unknown as FakeDocument,
    navigator: { userAgent: "test", platform: "test", maxTouchPoints: 0 },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as unknown as FakeWindow;
  (document.defaultView as unknown as FakeWindow).document = document as unknown as FakeDocument;

  document.body = makeNode("body", document as unknown as FakeDocument);
  document.documentElement = makeNode("html", document as unknown as FakeDocument);

  // Capture previous globals so the test process is left untouched after
  // each test runs. Bun's test runner shares globalThis across all tests in
  // a file, so a leaked DOM stub (or a sticky IS_REACT_ACT_ENVIRONMENT) would
  // bleed into unrelated tests.
  const g = globalThis as unknown as {
    document?: FakeDocument;
    window?: FakeWindow;
    navigator?: FakeWindow["navigator"];
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previous = {
    document: g.document,
    window: g.window,
    navigator: g.navigator,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  };

  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.document = document;
  g.window = document.defaultView;
  g.navigator = document.defaultView.navigator;

  return {
    document,
    restore() {
      g.document = previous.document;
      g.window = previous.window;
      g.navigator = previous.navigator;
      g.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

// --- Module mocks --------------------------------------------------------

// Mock the device module to return a stable non-mobile DeviceInfo so the
// SUT takes the desktop branch (which contains the bug). The mock must be
// registered before the SUT is imported.
mock.module("@/lib/device", () => ({
  useDeviceInfo: () => ({
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    deviceType: "desktop" as const,
    screenWidth: 1024,
    breakpoint: "lg" as const,
    hasTouchInput: false,
    hasTouchOnlyPointer: false,
  }),
  DEFAULT_DEVICE_INFO: {
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    deviceType: "desktop" as const,
    screenWidth: 1024,
    breakpoint: "lg" as const,
    hasTouchInput: false,
    hasTouchOnlyPointer: false,
  },
  isMobileDeviceViaCSS: () => false,
  useTabletStandalonePwaRuntime: () => false,
}));

// --- Test harness --------------------------------------------------------

interface ControlledProps {
  initialValue: number;
  min?: number;
  max?: number;
  step?: number;
}

interface ControlledHandle {
  recorded: number[];
  clickDecrease(): void;
  clickIncrease(): void;
  rerenderWith(value: number): void;
  getButton(label: string): FakeNode | null;
  getButtonDisabled(label: string): boolean;
  typeInput(value: string): void;
  blurInput(): void;
  unmount(): void;
}

function mountControlled(props: ControlledProps): ControlledHandle {
  const doc = (globalThis as unknown as { document: FakeDocument }).document;
  const container = doc.createElement("div");
  const root: Root = createRoot(container as unknown as Element);

  // The current value the controlled parent renders with. The parent
  // deliberately DOES NOT update this synchronously inside onValueChange
  // to simulate the rapid-click scenario where the prop round-trip hasn't
  // completed yet. Tests that need a "re-render between clicks" must call
  // `rerenderWith` explicitly.
  let currentValue = props.initialValue;
  const recorded: number[] = [];

  const Controlled = () =>
    React.createElement(
      I18nProvider,
      null,
      React.createElement(NumberInput, {
        value: currentValue,
        min: props.min,
        max: props.max,
        step: props.step,
        onValueChange: (v: number) => recorded.push(v),
      }),
    );

  act(() => {
    root.render(React.createElement(Controlled));
  });

  function findButtonByAriaLabel(label: string): FakeNode | null {
    function visit(node: FakeNode): FakeNode | null {
      const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps"));
      if (propsKey) {
        const p = (node as unknown as Record<string, { [k: string]: unknown }>)[propsKey];
        if (p && p["aria-label"] === label) return node;
      }
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    }
    return visit(container);
  }

  function clickButton(label: string): void {
    const btn = findButtonByAriaLabel(label);
    if (!btn) throw new Error(`Button with aria-label "${label}" not found`);
    const propsKey = Object.keys(btn).find((k) => k.startsWith("__reactProps"));
    if (!propsKey) throw new Error("Button has no __reactProps");
    const props = (btn as unknown as Record<string, { onClick: (e: unknown) => void }>)[propsKey];
    props.onClick({ preventDefault() { /* noop */ }, stopPropagation() { /* noop */ } });
  }

  // The <input> is the only node in the subtree that has an `onChange` handler
  // attached. Walk the container to find it.
  function findInputNode(): FakeNode {
    function visit(node: FakeNode): FakeNode | null {
      const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps"));
      if (propsKey) {
        const p = (node as unknown as Record<string, { onChange?: unknown }>)[propsKey];
        if (p && typeof p.onChange === "function") return node;
      }
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    }
    const node = visit(container);
    if (!node) throw new Error("Input not found in container");
    return node;
  }

  function readInputProps(): {
    onChange: (e: unknown) => void;
    onBlur: (e: unknown) => void;
  } {
    const input = findInputNode();
    const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps"));
    if (!propsKey) throw new Error("Input has no __reactProps");
    return (input as unknown as Record<string, {
      onChange: (e: unknown) => void;
      onBlur: (e: unknown) => void;
    }>)[propsKey];
  }

  return {
    recorded,
    clickDecrease() { clickButton("Decrease value"); },
    clickIncrease() { clickButton("Increase value"); },
    rerenderWith(value: number) {
      currentValue = value;
      act(() => {
        root.render(React.createElement(Controlled));
      });
    },
    getButton(label: string) {
      return findButtonByAriaLabel(label);
    },
    getButtonDisabled(label: string) {
      const btn = findButtonByAriaLabel(label);
      if (!btn) throw new Error(`Button with aria-label "${label}" not found`);
      const propsKey = Object.keys(btn).find((k) => k.startsWith("__reactProps"));
      if (!propsKey) throw new Error("Button has no __reactProps");
      const props = (btn as unknown as Record<string, { disabled?: boolean }>)[propsKey];
      return Boolean(props.disabled);
    },
    typeInput(value: string) {
      // Look the input up fresh each time so we always invoke the handler
      // currently bound by the most recent render.
      const props = readInputProps();
      act(() => {
        props.onChange({ target: { value } });
      });
    },
    blurInput() {
      // Re-lookup: a re-render between the last user event and blur replaces
      // the props object, and we want the handler bound to the latest draft.
      const props = readInputProps();
      act(() => {
        props.onBlur({});
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
    },
  };
}

// Helper: returns the most recent recorded value, or throws if the parent
// never produced a commit. Replaces the old `recorded[len-1]!` non-null
// assertions so a regression that drops the first commit fails loudly
// instead of being silently coerced to `undefined`.
function lastCommit(handle: ControlledHandle): number {
  const value = handle.recorded[handle.recorded.length - 1];
  if (value === undefined) {
    throw new Error("expected a recorded commit before the next step");
  }
  return value;
}

// Helper: mount, run body, unmount — avoids leaking roots between tests.
// Also restores the global DOM/window/navigator/IS_REACT_ACT_ENVIRONMENT
// globals to their pre-test values so the test process stays clean.
function withHandle<T>(props: ControlledProps, body: (h: ControlledHandle) => T): T {
  const stub = installDomStub();
  const handle = mountControlled(props);
  try {
    return body(handle);
  } finally {
    try { handle.unmount(); } catch { /* ignore */ }
    stub.restore();
  }
}

// --- Tests ---------------------------------------------------------------

describe("NumberInput rapid-click stepper", () => {
  test("markup: decrease and increase buttons render with correct aria-labels", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(NumberInput, {
          value: 100,
          min: 0,
          max: 200,
          step: 5,
          onValueChange: () => {},
        }),
      ),
    );
    expect(markup).toContain('aria-label="Decrease value"');
    expect(markup).toContain('aria-label="Increase value"');
  });

  test("rapid `-` then `+` settles to the start value (post-fix contract)", () => {
    withHandle({ initialValue: 100, min: 0, max: 200, step: 5 }, (handle) => {
      handle.clickDecrease();
      handle.clickIncrease();

      // Pre-fix behavior would record [95, 105] (both clicks read the stale
      // value 100). Post-fix the second click reads the committed value 95
      // from the ref, so the sequence nets to the start value 100.
      expect(handle.recorded).toEqual([95, 100]);
    });
  });

  test("rapid `+` then `-` settles to the start value (post-fix contract)", () => {
    withHandle({ initialValue: 100, min: 0, max: 200, step: 5 }, (handle) => {
      handle.clickIncrease();
      handle.clickDecrease();

      expect(handle.recorded).toEqual([105, 100]);
    });
  });

  test("sustained 6-click alternation settles to the start value (no drift)", () => {
    withHandle({ initialValue: 100, min: 0, max: 200, step: 5 }, (handle) => {
      handle.clickDecrease();
      handle.clickIncrease();
      handle.clickDecrease();
      handle.clickIncrease();
      handle.clickDecrease();
      handle.clickIncrease();

      // Each `-` should land on a value 5 below the previous, each `+` on a
      // value 5 above the previous, with the ref catching up after every
      // commit. The 6 clicks net to start (100), not drift to 70 or 130.
      expect(handle.recorded).toEqual([95, 100, 95, 100, 95, 100]);
    });
  });

  test("sequential clicks with a re-render between them settle correctly", () => {
    withHandle({ initialValue: 100, min: 0, max: 200, step: 5 }, (handle) => {
      handle.clickDecrease();
      // Simulate the real-world prop round-trip: parent re-renders with the
      // latest committed value.
      handle.rerenderWith(lastCommit(handle));
      handle.clickIncrease();
      handle.rerenderWith(lastCommit(handle));
      handle.clickIncrease();

      expect(handle.recorded).toEqual([95, 100, 105]);
    });
  });

  test("clamp at min: decrease button is rendered as disabled at the lower bound", () => {
    withHandle({ initialValue: 50, min: 50, max: 200, step: 5 }, (handle) => {
      // The desktop stepper relies on the `disabled` attribute (browser-level
      // gating) to prevent the click from firing when at the bound. The mobile
      // path additionally guards inside the handler. Either way, the user
      // cannot push the value below `min` through the stepper UI.
      expect(handle.getButton("Decrease value")).not.toBeNull();
      expect(handle.getButtonDisabled("Decrease value")).toBe(true);

      // Sanity check: the increase button at the lower bound is enabled.
      expect(handle.getButtonDisabled("Increase value")).toBe(false);
    });
  });

  test("typed-then-stepper uses the typed base (post-fix contract)", () => {
    // Regression: handleBlur used to call onValueChange directly without
    // updating committedValueRef, so a typed value followed by a stepper
    // click would compute from the stale pre-typed ref and drift.
    withHandle({ initialValue: 100, min: 0, max: 200, step: 5 }, (handle) => {
      // 1) User types "110" into the input. handleChange parses a finite
      //    number and commits via commitValue (which writes the ref).
      handle.typeInput("110");
      // 2) The parent re-renders with the latest committed value, mirroring
      //    a real React parent's setState round-trip. This is what makes
      //    `value` and `ref` agree before blur runs.
      handle.rerenderWith(lastCommit(handle));
      // 3) User blurs. handleBlur sees the typed draft, the ref is already
      //    at 110, and `normalized !== value` is false — no duplicate commit.
      handle.blurInput();
      // 4) User clicks the increase button. The stepper must read the
      //    ref (110) and produce 115, not 105 (which is what the pre-fix
      //    behavior would have produced using the stale ref=100).
      handle.clickIncrease();

      // The exact recorded sequence after a full prop round-trip: one
      // commit from the typed change, none from the blur (suppressed by
      // the `normalized !== value` gate), and one from the stepper.
      expect(handle.recorded).toEqual([110, 115]);
    });
  });

  test("typed value below min is clamped on blur and the stepper respects the clamped base", () => {
    withHandle({ initialValue: 100, min: 50, max: 200, step: 5 }, (handle) => {
      // 1) User types "20" (below min). handleChange commits 20, which
      //    commitValue clamps to 50 before emitting onValueChange.
      handle.typeInput("20");
      // 2) Parent re-renders with the clamped value 50.
      handle.rerenderWith(lastCommit(handle));
      // 3) Blur: the draft "20" parses to 20, clamps to 50, normalizes to 50.
      //    `50 !== value(50)` is false — no duplicate commit.
      handle.blurInput();
      // 4) Click increase: stepper reads the ref (50) and produces 55.
      handle.clickIncrease();

      expect(handle.recorded).toEqual([50, 55]);

      // At the lower bound, the decrease button must be disabled.
      expect(handle.getButtonDisabled("Decrease value")).toBe(true);
      // And the increase button must remain enabled.
      expect(handle.getButtonDisabled("Increase value")).toBe(false);
    });
  });
});
