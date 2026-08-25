import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { create } from 'zustand';
import type { GitHubAPI, GitHubPullRequestStatus, RuntimeAPIs } from '@/lib/api/types';

// Issue 3131: the PR merge flow used to pre-select `squash` without any user
// choice, so the merge button next to the method selector merged on a single
// click. The fix makes the method start unselected (`undefined`, never
// `squash`) and adds a defensive guard in mergePr so an accidental click
// without a chosen method does nothing. These tests pin that behavior: the
// rendered panel starts with no method selected, and clicking the merge
// button without a selection never reaches the GitHub API.

const DIRECTORY = '/tmp/repro-repo';
const BRANCH = 'feature-branch';

// The PR status store is mocked so the seeded mergeable PR is visible to the
// server render. renderToString reads zustand's initial state snapshot, which
// the real persisted store can never reflect after seeding; the mock shares
// the entry map by reference so the snapshot sees the seeded entries. See the
// issue-2039 reproduction for the same technique.
type MockPrStatusEntry = {
  status: GitHubPullRequestStatus | null;
  isLoading: boolean;
  error: string | null;
  isInitialStatusResolved: boolean;
  lastRefreshAt: number;
  lastDiscoveryPollAt: number;
  watchers: number;
  params: null;
  identity: null;
  resolvedRemoteName: string | null;
  paramsRevision: number;
};

const mockEntryState: Record<string, MockPrStatusEntry> = {};

mock.module('@/stores/useGitHubPrStatusStore', () => {
  const createEntry = (): MockPrStatusEntry => ({
    status: null,
    isLoading: false,
    error: null,
    isInitialStatusResolved: false,
    lastRefreshAt: 0,
    lastDiscoveryPollAt: 0,
    watchers: 0,
    params: null,
    identity: null,
    resolvedRemoteName: null,
    paramsRevision: 0,
  });

  const useGitHubPrStatusStore = create<{
    entries: Record<string, MockPrStatusEntry>;
    ensureEntry: (key: string) => void;
    updateStatus: (key: string, updater: (prev: GitHubPullRequestStatus | null) => GitHubPullRequestStatus | null) => void;
    resetForRuntimeSwitch: () => void;
    setParams: (key: string, params: unknown) => void;
    startWatching: (key: string) => void;
    stopWatching: (key: string) => void;
    refresh: (key: string) => Promise<void>;
  }>()(() => ({
    entries: mockEntryState,
    ensureEntry: (key) => {
      if (!mockEntryState[key]) {
        mockEntryState[key] = createEntry();
      }
    },
    updateStatus: (key, updater) => {
      const current = mockEntryState[key] ?? createEntry();
      mockEntryState[key] = { ...current, status: updater(current.status) };
    },
    resetForRuntimeSwitch: () => {
      for (const key of Object.keys(mockEntryState)) {
        mockEntryState[key] = { ...mockEntryState[key], watchers: 0, isLoading: false, params: null };
      }
    },
    setParams: () => {},
    startWatching: () => {},
    stopWatching: () => {},
    refresh: async () => {},
  }));

  return {
    getGitHubPrStatusKey: (directory: string, branch: string, remoteName?: string | null): string =>
      JSON.stringify(['url:default', directory, branch, remoteName ?? 'auto']),
    useGitHubPrStatusStore,
  };
});

// Mock the device module to return a stable non-mobile DeviceInfo so the
// panel takes the desktop branch, matching the number-input test pattern.
mock.module('@/lib/device', () => ({
  useDeviceInfo: () => ({
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    deviceType: 'desktop' as const,
    screenWidth: 1024,
    breakpoint: 'lg' as const,
    hasTouchInput: false,
    hasTouchOnlyPointer: false,
  }),
  DEFAULT_DEVICE_INFO: {
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    deviceType: 'desktop' as const,
    screenWidth: 1024,
    breakpoint: 'lg' as const,
    hasTouchInput: false,
    hasTouchOnlyPointer: false,
  },
  isMobileDeviceViaCSS: () => false,
  useTabletStandalonePwaRuntime: () => false,
}));

const { PullRequestSection } = await import('../PullRequestSection');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { getGitHubPrStatusKey, useGitHubPrStatusStore } = await import('@/stores/useGitHubPrStatusStore');

// The sortable tabs strip measures its scroll extent against a real layout;
// the minimal DOM stub has none, so its ResizeObserver effect loops. The
// panel's merge controls do not depend on it, so it is stubbed as a passthrough.
mock.module('@/components/ui/sortable-tabs-strip', () => ({
  SortableTabsStrip: (props: { children?: React.ReactNode }) =>
    React.createElement('div', null, props.children),
}));

// The markdown renderer is not involved in the merge flow; stub it so the
// PR body section renders without pulling in its dependencies.
mock.module('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: (props: { content?: string }) =>
    React.createElement('div', null, props.content ?? ''),
}));

// --- Minimal DOM stub (same pattern as number-input.test.tsx) ------------

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
  toString(): string { return [...this.classes].join(' '); }
}

function makeNode(tag: string, owner: FakeDocument): FakeNode {
  const style: Record<string, unknown> = {
    setProperty() { /* noop */ },
    getPropertyValue() { return ''; },
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
    textContent: '',
    innerHTML: '',
  };
  return node;
}

function installDomStub(): { document: FakeDocument; restore: () => void } {
  const HTMLElementCtor = class {};
  const document = {
    nodeType: 9,
    nodeName: '#document',
    tagName: '#document',
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
      return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null } as unknown as FakeNode;
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
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    HTMLElement: HTMLElementCtor,
    Element: HTMLElementCtor,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as unknown as FakeWindow;
  (document.defaultView as unknown as FakeWindow).document = document as unknown as FakeDocument;

  document.body = makeNode('body', document as unknown as FakeDocument);
  document.documentElement = makeNode('html', document as unknown as FakeDocument);

  const g = globalThis as unknown as {
    document?: FakeDocument;
    window?: FakeWindow;
    navigator?: FakeWindow['navigator'];
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    HTMLElement?: unknown;
    Element?: unknown;
    ResizeObserver?: unknown;
  };
  const previous = {
    document: g.document,
    window: g.window,
    navigator: g.navigator,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    HTMLElement: g.HTMLElement,
    Element: g.Element,
    ResizeObserver: g.ResizeObserver,
  };

  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.document = document;
  g.window = document.defaultView;
  g.navigator = document.defaultView.navigator;
  g.HTMLElement = HTMLElementCtor;
  g.Element = HTMLElementCtor;
  g.ResizeObserver = class { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } };

  return {
    document,
    restore() {
      g.document = previous.document;
      g.window = previous.window;
      g.navigator = previous.navigator;
      g.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
      g.HTMLElement = previous.HTMLElement;
      g.Element = previous.Element;
      g.ResizeObserver = previous.ResizeObserver;
    },
  };
}

// --- RuntimeAPI stubs -----------------------------------------------------

// Every property access on the stub returns a resolving async function, so
// the effects and callbacks that reach github.* (or any other API) never
// throw; only `prMerge` is observable so the test can assert it stays
// uncalled while no merge method is selected.
const createApiStub = <T,>(): T => new Proxy({}, { get: () => async () => undefined }) as T;

const prMergeCalls: Array<{ directory: string; number: number; method: string }> = [];
// Records every prMerge invocation so the test can assert the API stays
// uncalled while no merge method is selected (same pattern as issue-2039).
const prMerge = (async (payload: GitHubAPI['prMerge'] extends (p: infer P) => Promise<unknown> ? P : never) => {
  prMergeCalls.push(payload);
  return { merged: true, message: 'merged' };
}) as GitHubAPI['prMerge'];

// SAFETY: every property access returns a resolving async function so the
// effects that reach github.* never throw; prMerge is the only method that is
// observable, and it is provided directly.
const githubStub = new Proxy(
  { prMerge } as Record<string | symbol, unknown>,
  { get: (target, prop) => (prop in target ? target[prop] : async () => undefined) },
) as unknown as GitHubAPI;

const stubApis: RuntimeAPIs = {
  runtime: { platform: 'desktop', isDesktop: true, isVSCode: false },
  terminal: createApiStub(),
  git: createApiStub(),
  files: createApiStub(),
  settings: createApiStub(),
  permissions: createApiStub(),
  notifications: createApiStub(),
  github: githubStub,
  tools: createApiStub(),
};

const mergeableStatus = (): GitHubPullRequestStatus => ({
  connected: true,
  canMerge: true,
  repo: { owner: 'acme', repo: 'widgets', url: 'https://github.com/acme/widgets' },
  branch: BRANCH,
  defaultBranch: 'main',
  resolvedRemoteName: 'origin',
  pr: {
    number: 42,
    title: 'Add the frobnicator',
    url: 'https://github.com/acme/widgets/pull/42',
    state: 'open',
    draft: false,
    base: 'main',
    head: BRANCH,
    mergeable: true,
    mergeableState: 'clean',
  },
});

const seedMergeableStatus = () => {
  const key = getGitHubPrStatusKey(DIRECTORY, BRANCH, null);
  const store = useGitHubPrStatusStore.getState();
  store.ensureEntry(key);
  store.updateStatus(key, () => mergeableStatus());
};

const renderPanel = () =>
  renderToString(
    <I18nProvider>
      <RuntimeAPIProvider apis={stubApis}>
        <PullRequestSection directory={DIRECTORY} branch={BRANCH} baseBranch="main" />
      </RuntimeAPIProvider>
    </I18nProvider>
  );

// Mount the panel for real (createRoot against the DOM stub) so the merge
// button's actual onClick handler can be invoked, exactly like the
// number-input test drives its stepper buttons.
interface PanelHandle {
  clickMerge(): void;
  unmount(): void;
}

function mountPanel(): PanelHandle {
  // SAFETY: installDomStub always assigns the stub document to globalThis
  // before mountPanel is reached, so the cast only narrows the known global.
  const doc = (globalThis as unknown as { document: FakeDocument }).document;
  const container = doc.createElement('div');
  // SAFETY: the stub document's createElement returns FakeNode, which is the
  // element shape createRoot requires.
  const root: Root = createRoot(container as unknown as Element);

  act(() => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(
          RuntimeAPIProvider,
          {
            apis: stubApis,
            children: React.createElement(PullRequestSection, {
              directory: DIRECTORY,
              branch: BRANCH,
              baseBranch: 'main',
            }),
          },
        ),
      ),
    );
  });

  // React stores its synthetic event props on DOM nodes under a `__reactProps$`
  // internal key. The merge button is the only node whose props carry the
  // merge aria-label plus an onClick handler; walking the mounted tree for
  // that pair is the same technique the number-input test uses for its
  // stepper buttons.
  interface MergeButtonProps {
    'aria-label'?: string;
    onClick?: (event: { preventDefault(): void; stopPropagation(): void }) => void;
  }

  function findMergeButton(): FakeNode {
    function visit(node: FakeNode): FakeNode | null {
      if (!node || !Array.isArray(node.childNodes)) {
        return null;
      }
      const propsKey = Object.keys(node).find((k) => k.startsWith('__reactProps'));
      if (propsKey) {
        // SAFETY: FakeNode is typed with a string index of `unknown`; the
        // props object under the React key is the component's own props.
        const p = node[propsKey] as MergeButtonProps;
        if (p && p['aria-label'] === 'Merge pull request' && p.onClick) {
          return node;
        }
      }
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    }
    const node = visit(container);
    if (!node) throw new Error('Merge button not found in mounted panel');
    return node;
  }

  function mountPanelHandle(): PanelHandle {
    return {
      clickMerge() {
        const btn = findMergeButton();
        const propsKey = Object.keys(btn).find((k) => k.startsWith('__reactProps'));
        if (!propsKey) throw new Error('Merge button has no __reactProps');
        // SAFETY: same invariant as findMergeButton: the props object under
        // the React key is the button's own props, which include onClick.
        const props = btn[propsKey] as MergeButtonProps;
        if (!props.onClick) throw new Error('Merge button has no onClick');
        act(() => {
          props.onClick!({ preventDefault() { /* noop */ }, stopPropagation() { /* noop */ } });
        });
      },
      unmount() {
        act(() => {
          root.unmount();
        });
      },
    };
  }

  return mountPanelHandle();
}

const uiSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const pullRequestSectionSource = readFileSync(
  path.join(uiSrc, 'components/views/git/PullRequestSection.tsx'),
  'utf8'
);
const webServerRoot = path.resolve(uiSrc, '../..');
const routesSource = readFileSync(
  path.join(webServerRoot, 'web/server/lib/github/routes.js'),
  'utf8'
);

describe('issue 3131 regression: PR merge requires an explicit method choice', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockEntryState)) {
      delete mockEntryState[key];
    }
    prMergeCalls.length = 0;
  });

  test('opens the panel with no merge method pre-selected', () => {
    seedMergeableStatus();

    const html = renderPanel();

    // The method selector is not pre-filled with squash (or any other value)
    // before the user has touched anything.
    expect(html).not.toContain('value="squash"');
    expect(html).not.toContain('value="merge"');
    expect(html).not.toContain('value="rebase"');
  });

  test('traces the source: mergeMethod defaults to undefined, not squash', () => {
    expect(pullRequestSectionSource).toContain(
      'const [mergeMethod, setMergeMethod] = React.useState<MergeMethod | undefined>(undefined);'
    );
    expect(pullRequestSectionSource).not.toContain(
      "const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>('squash');"
    );
  });

  test('clicking merge with no method selected never calls the GitHub API', () => {
    seedMergeableStatus();

    const stub = installDomStub();
    const panel = mountPanel();
    try {
      panel.clickMerge();

      // The guard in mergePr must return before any API call. If the
      // pre-select regression returns, this becomes 1 and the test fails.
      expect(prMergeCalls).toEqual([]);
    } finally {
      try { panel.unmount(); } catch { /* ignore */ }
      stub.restore();
    }
  });

  test('traces the source: mergePr refuses to merge without a chosen method', () => {
    expect(pullRequestSectionSource).toContain('if (!mergeMethod) {');
  });

  test('traces the source: the client never sends squash without an explicit choice', () => {
    // The client no longer hard-codes squash. The server still falls back to
    // merge when the method is absent, but the UI now guarantees the method is
    // present whenever a merge request is sent.
    expect(routesSource).toContain(
      "const method = typeof req.body?.method === 'string' ? req.body.method : 'merge';"
    );
    expect(pullRequestSectionSource).toContain(
      'const result = await github.prMerge({ directory, number: pr.number, method: mergeMethod });'
    );
  });
});
