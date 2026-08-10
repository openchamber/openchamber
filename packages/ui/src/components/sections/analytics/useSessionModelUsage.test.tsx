/**
 * Tests for useSessionModelUsage:
 *  1. Per-session model-usage grouping and token/cost/reasoning breakdown.
 *  2. Progressive model-usage map updates every BATCH_UPDATE_SIZE (15) sessions.
 *  3. Module-scoped cache: re-opening the page serves cached breakdowns without
 *     refetching.
 *
 * The hook is mounted via createRoot against a minimal DOM stub (Bun's test
 * runner does not provide a DOM by default) — same pattern as
 * number-input.test.tsx. The opencode client is mocked with per-session
 * deferreds so tests can resolve fetches in a controlled order and assert
 * intermediate state between batch flushes.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Session } from "@opencode-ai/sdk/v2";
import { clearSessionModelUsageCache } from "@/lib/analytics/session-model-usage-cache";

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

  // Capture previous property descriptors (not values) so the globals can be
  // restored exactly, including their writability/configurability. Other test
  // files redefine these globals via defineProperty with writable: false, so
  // a plain assignment here would throw; defineProperty with a writable
  // descriptor is the only reliable way to take them over.
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    IS_REACT_ACT_ENVIRONMENT: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };

  const defineGlobal = <T,>(name: "document" | "window" | "navigator" | "IS_REACT_ACT_ENVIRONMENT", value: T) => {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  defineGlobal("document", document);
  defineGlobal("window", document.defaultView);
  defineGlobal("navigator", document.defaultView.navigator);

  return {
    document,
    restore() {
      const restoreOne = (name: keyof typeof previous) => {
        const descriptor = previous[name];
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      };
      restoreOne("IS_REACT_ACT_ENVIRONMENT");
      restoreOne("document");
      restoreOne("window");
      restoreOne("navigator");
    },
  };
}

// --- Mock opencode client -------------------------------------------------

type AssistantMessageInfo = {
  role: string;
  providerID: string;
  modelID: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
};

type MockMessagesResponse = {
  data?: Array<{ info: AssistantMessageInfo }>;
  error?: unknown;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const deferredBySession = new Map<string, Deferred<MockMessagesResponse>>();
let messagesCallCount = 0;
const failingSessions = new Set<string>();

const messagesMock = mock((args: { sessionID: string }) => {
  messagesCallCount++;
  if (failingSessions.has(args.sessionID)) {
    return Promise.reject(new Error("fetch failed"));
  }
  const d = createDeferred<MockMessagesResponse>();
  deferredBySession.set(args.sessionID, d);
  return d.promise;
});

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getSdkClient: () => ({ session: { messages: messagesMock } }),
  },
}));

const { useSessionModelUsage } = await import("./useSessionModelUsage");

// --- Test helpers ---------------------------------------------------------

type HookValue = ReturnType<typeof useSessionModelUsage>;

let captured: HookValue | null = null;

function Driver({ sessions }: { sessions: readonly Session[] }) {
  captured = useSessionModelUsage(sessions);
  return null;
}

interface HookHandle {
  readonly value: HookValue;
  rerender(sessions: readonly Session[]): void;
  unmount(): void;
}

function mountHook(sessions: readonly Session[]): HookHandle {
  captured = null;
  const stub = installDomStub();
  const doc = (globalThis as unknown as { document: FakeDocument }).document;
  const container = doc.createElement("div");
  const root: Root = createRoot(container as unknown as Element);
  act(() => {
    root.render(React.createElement(Driver, { sessions }));
  });
  return {
    get value(): HookValue {
      if (!captured) throw new Error("Driver has not rendered yet");
      return captured;
    },
    rerender(s: readonly Session[]) {
      act(() => {
        root.render(React.createElement(Driver, { sessions: s }));
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      stub.restore();
    },
  };
}

function makeSession(id: string, updated = 0): Session {
  return { id, time: { updated } } as unknown as Session;
}

function makeAssistantMessage(
  providerID: string,
  modelID: string,
  tokens: AssistantMessageInfo["tokens"],
  cost: number,
): { info: AssistantMessageInfo } {
  return { info: { role: "assistant", providerID, modelID, tokens, cost } };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function resolveSession(id: string, response: MockMessagesResponse): Promise<void> {
  const d = deferredBySession.get(id);
  if (!d) throw new Error(`No deferred for session ${id}`);
  await act(async () => {
    d.resolve(response);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const ZERO_TOKENS: AssistantMessageInfo["tokens"] = {
  input: 1,
  output: 1,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};

// --- Tests ----------------------------------------------------------------

describe("useSessionModelUsage", () => {
  beforeEach(() => {
    deferredBySession.clear();
    failingSessions.clear();
    messagesCallCount = 0;
    clearSessionModelUsageCache();
  });

  test("groups model usage by sessionId with correct per-model breakdown", async () => {
    const sessions = [makeSession("s-a"), makeSession("s-b")];
    const handle = mountHook(sessions);

    expect(handle.value.modelUsage.size).toBe(0);

    await resolveSession("s-a", {
      data: [
        makeAssistantMessage("zai", "glm-5.2", { input: 100, output: 200, reasoning: 50, cache: { read: 10, write: 5 } }, 0.01),
        makeAssistantMessage("opencode", "deepseek-v4", { input: 50, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }, 0.02),
      ],
    });
    await resolveSession("s-b", {
      data: [
        makeAssistantMessage("kimi", "k3", { input: 80, output: 120, reasoning: 20, cache: { read: 0, write: 0 } }, 0.03),
      ],
    });
    await flush();

    const { modelUsage } = handle.value;
    expect(modelUsage.size).toBe(2);

    const breakdownA = modelUsage.get("s-a");
    expect(breakdownA).toBeDefined();
    expect(breakdownA!.size).toBe(2);

    // tokens = input + output + reasoning + cache.read + cache.write
    // = 100 + 200 + 50 + 10 + 5 = 365
    const glmEntry = breakdownA!.get("zai/glm-5.2");
    expect(glmEntry).toBeDefined();
    expect(glmEntry!.tokens).toBe(365);
    expect(glmEntry!.cost).toBe(0.01);
    expect(glmEntry!.reasoning).toBe(50);

    const deepseekEntry = breakdownA!.get("opencode/deepseek-v4");
    expect(deepseekEntry).toBeDefined();
    expect(deepseekEntry!.tokens).toBe(150);
    expect(deepseekEntry!.cost).toBe(0.02);

    const breakdownB = modelUsage.get("s-b");
    expect(breakdownB).toBeDefined();
    expect(breakdownB!.size).toBe(1);
    const k3Entry = breakdownB!.get("kimi/k3");
    expect(k3Entry).toBeDefined();
    expect(k3Entry!.tokens).toBe(220);
    expect(k3Entry!.cost).toBe(0.03);

    handle.unmount();
  });

  test("emits progressive model-usage updates every 15 sessions", async () => {
    const sessions: Session[] = Array.from({ length: 30 }, (_, i) => makeSession(`s-${i}`));
    const handle = mountHook(sessions);

    expect(handle.value.modelUsage.size).toBe(0);

    // Resolve the first 15 sessions. At loaded % 15 === 0 the hook flushes
    // a batch, so modelUsage should contain exactly 15 entries.
    for (let i = 0; i < 15; i++) {
      await resolveSession(`s-${i}`, {
        data: [makeAssistantMessage("mock", `m-${i}`, ZERO_TOKENS, 0)],
      });
    }

    expect(handle.value.modelUsage.size).toBe(15);

    // Resolve the remaining 15 sessions.
    for (let i = 15; i < 30; i++) {
      await resolveSession(`s-${i}`, {
        data: [makeAssistantMessage("mock", `m-${i}`, ZERO_TOKENS, 0)],
      });
    }
    await flush();

    expect(handle.value.modelUsage.size).toBe(30);

    handle.unmount();
  });

  test("serves cached breakdowns on re-open without refetching", async () => {
    const sessions = [makeSession("s-a"), makeSession("s-b")];

    // --- First visit: fetch and cache. ---
    const handle = mountHook(sessions);

    await resolveSession("s-a", {
      data: [makeAssistantMessage("zai", "glm-5.2", { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, 0.01)],
    });
    await resolveSession("s-b", {
      data: [makeAssistantMessage("kimi", "k3", { input: 30, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }, 0.02)],
    });
    await flush();

    expect(handle.value.modelUsage.size).toBe(2);
    expect(messagesCallCount).toBe(2);

    // Navigate away from the analytics page.
    handle.unmount();

    // --- Re-open: same sessions, module cache should serve without refetch. ---
    const reopened = mountHook(sessions);
    await flush();

    expect(reopened.value.modelUsage.size).toBe(2);
    // No additional fetches — the module cache served the cached breakdowns.
    expect(messagesCallCount).toBe(2);

    // Cached breakdowns are intact.
    const breakdownA = reopened.value.modelUsage.get("s-a");
    expect(breakdownA).toBeDefined();
    // tokens = 10 + 20 + 0 + 0 + 0 = 30
    expect(breakdownA!.get("zai/glm-5.2")!.tokens).toBe(30);

    reopened.unmount();
  });

  test("retries a session whose fetch failed on the next mount", async () => {
    failingSessions.add("s-fail");
    const sessions = [makeSession("s-fail")];

    // First open: the fetch rejects, so nothing is cached and the session is
    // NOT recorded as processed.
    const handle = mountHook(sessions);
    await flush();
    expect(handle.value.modelUsage.size).toBe(0);
    expect(messagesCallCount).toBe(1);
    handle.unmount();

    // Recover: the fetch succeeds on the next open because the failed attempt
    // was not recorded as processed.
    failingSessions.delete("s-fail");
    const reopened = mountHook(sessions);
    await resolveSession("s-fail", {
      data: [makeAssistantMessage("zai", "glm-5.2", { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, 0)],
    });
    await flush();
    expect(messagesCallCount).toBe(2);
    expect(reopened.value.modelUsage.size).toBe(1);
    reopened.unmount();
  });

  test("retries a session whose SDK response is error-shaped on the next mount", async () => {
    // The SDK resolves failures as `{ error }` rather than rejecting. This is
    // the actual failure shape (mirrors unwrapSdkData's "empty response" mode)
    // and must NOT be recorded as processed, or the session silently degrades
    // to session-level attribution and is never retried.
    const sessions = [makeSession("s-err")];

    // First open: the SDK resolves with an error-shaped response.
    const handle = mountHook(sessions);
    await resolveSession("s-err", { error: { message: "upstream unavailable" } });
    await flush();
    expect(handle.value.modelUsage.size).toBe(0);
    expect(messagesCallCount).toBe(1);
    handle.unmount();

    // Recover: a successful response on the next open is attributed now,
    // because the error-shaped attempt was not recorded as processed.
    const reopened = mountHook(sessions);
    await resolveSession("s-err", {
      data: [makeAssistantMessage("zai", "glm-5.2", { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, 0)],
    });
    await flush();
    expect(messagesCallCount).toBe(2);
    expect(reopened.value.modelUsage.size).toBe(1);
    reopened.unmount();
  });
});
