import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { dict as enDict } from '@/lib/i18n/messages/en';
import type { GitAPI } from '@/lib/api/types';
import type { GitRepositoryPaneState } from '@/stores/useUIStore';
import {
  groupGraphRefs,
  isGitGraphFilterDisabled,
  resolveGitGraphPanelRenderState,
  resolveMergeBaseComparisonRefIds,
  resolveGraphQuery,
  shouldAutoRefreshGitGraphQuery,
} from './gitGraphPanelModel';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;
type MockHistoryRef = {
  id: string;
  name: string;
  revision: string | null;
  kind: 'head' | 'local' | 'remote' | 'tag';
  category: 'branches' | 'remote-branches' | 'tags';
};
type MockRefsPayload = {
  refs: MockHistoryRef[];
  current: (MockHistoryRef & { kind: 'local'; category: 'branches' }) | null;
  upstream: (MockHistoryRef & { kind: 'remote'; category: 'remote-branches' }) | null;
  base: (MockHistoryRef & { kind: 'remote'; category: 'remote-branches' }) | null;
};
type MockRefsState = {
  refs: MockRefsPayload | null;
  refsError: string | null;
  isLoadingRefs: boolean;
};
type MockHistoryItem = {
  id: string;
  parentIds: string[];
  subject: string;
  message: string;
  author: string;
  authorEmail: string;
  timestamp: string;
  statistics: { files: number; insertions: number; deletions: number };
  references: MockHistoryRef[];
};
type MockQueryState = {
  items: MockHistoryItem[];
  outdated: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refIds: string[];
} | null;
type MockUIStoreState = {
  gitRepositoryPaneStates: Record<string, typeof gitPaneState>;
  setGitRepositoryPaneState: typeof mockSetPaneState;
};
type MockGitStoreState = {
  ensureHistoryRefs: typeof mockEnsureHistoryRefs;
  fetchHistoryPage: typeof mockFetchHistoryPage;
};
type FetchHistoryCall = {
  directory: string;
  git: GitAPI;
  query: { mode: 'auto' | 'all' | 'manual'; refIds?: string[] };
  options?: { append?: boolean; limit?: number };
};
type ObserverInstance = {
  callback: IntersectionObserverCallback;
  elements: ObservedElementStub[];
  options?: IntersectionObserverInit;
  observer: IntersectionObserver;
};

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: MockButtonProps) => React.createElement('button', props, children),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => React.createElement('span'),
}));

const renderedGraphSegmentIds: string[] = [];

mock.module('./GitGraphSegment', () => ({
  GitGraphSegment: ({ viewModel }: { viewModel: { historyItem: { id: string } } }) => {
    renderedGraphSegmentIds.push(viewModel.historyItem.id);
    return React.createElement('span', { 'data-graph-segment-id': viewModel.historyItem.id });
  },
}));

const renderedHistoryRows: Array<{
  id: string;
  compactGraph?: boolean;
  commitDetailsController?: unknown;
  commitComparison?: { directory: string; commitHash: string; parentHash: string | null };
  onCompareWithRemote?: () => void;
  canCompareWithRemote?: boolean;
  onCompareWithMergeBase?: () => void;
  canCompareWithMergeBase?: boolean;
  onCompareWithRef?: () => void;
  activeComparisonLabel?: string | null;
  onClearComparison?: () => void;
}> = [];

mock.module('./HistoryCommitRow', () => ({
  HistoryCommitRow: ({
    entry,
    compactGraph,
    commitDetailsController,
    commitComparison,
    onCompareWithRemote,
    canCompareWithRemote,
    onCompareWithMergeBase,
    canCompareWithMergeBase,
    onCompareWithRef,
    activeComparisonLabel,
    onClearComparison,
  }: {
    entry: { id: string };
    compactGraph?: boolean;
    commitDetailsController?: unknown;
    commitComparison?: { directory: string; commitHash: string; parentHash: string | null };
    onCompareWithRemote?: () => void;
    canCompareWithRemote?: boolean;
    onCompareWithMergeBase?: () => void;
    canCompareWithMergeBase?: boolean;
    onCompareWithRef?: () => void;
    activeComparisonLabel?: string | null;
    onClearComparison?: () => void;
  }) => {
    renderedHistoryRows.push({
      id: entry.id,
      compactGraph,
      commitDetailsController,
      commitComparison,
      onCompareWithRemote,
      canCompareWithRemote,
      onCompareWithMergeBase,
      canCompareWithMergeBase,
      onCompareWithRef,
      activeComparisonLabel,
      onClearComparison,
    });
    return React.createElement('li', { 'data-history-id': entry.id });
  },
}));

let gitPaneState: GitRepositoryPaneState = {
  changesCollapsed: false,
  graphCollapsed: true,
  graphHeight: 280,
  graphFilterMode: 'auto',
  graphManualRefIds: [],
};

const fetchHistoryCalls: FetchHistoryCall[] = [];
const observerInstances: ObserverInstance[] = [];
let mockEnsureHistoryRefs: ReturnType<typeof mock> = mock(async () => null);
let mockFetchHistoryPage: ReturnType<typeof mock> = mock(async () => undefined);
const mockSetPaneState = () => undefined;

let mockRefsState: MockRefsState = {
  refs: null,
  refsError: null,
  isLoadingRefs: false,
};

let mockQueryState: MockQueryState = null;

mock.module('@/stores/useUIStore', () => ({
  DEFAULT_GIT_REPOSITORY_PANE_STATE: gitPaneState,
  gitRepositoryPanePreferenceKey: (directory: string) => directory,
  useUIStore: <T,>(selector: (state: MockUIStoreState) => T) => selector({
    gitRepositoryPaneStates: { '/repo': gitPaneState },
    setGitRepositoryPaneState: mockSetPaneState,
  }),
}));

mock.module('@/stores/useGitStore', () => ({
  useGitStore: <T,>(selector: (state: MockGitStoreState) => T) => selector({
    ensureHistoryRefs: mockEnsureHistoryRefs,
    fetchHistoryPage: mockFetchHistoryPage,
  }),
  useGitHistoryRefsState: () => mockRefsState,
  useGitHistoryQueryState: () => mockQueryState,
}));

const { GitGraphPanel } = await import('./GitGraphPanel');
type ReactContainer = Parameters<typeof createRoot>[0];

interface ElementStub {
  nodeType: number;
  nodeName: string;
  tagName: string;
  id: string;
  attributes: Record<string, string>;
  namespaceURI: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
  childNodes: ElementStub[];
  style: object;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(child: ElementStub): ElementStub;
  insertBefore(child: ElementStub, ref: ElementStub | null): ElementStub;
  removeChild(child: ElementStub): ElementStub;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
}

type ObservedElementStub = Element & ElementStub;

interface DocumentStub {
  nodeType: number;
  defaultView: typeof globalThis;
  activeElement: ElementStub | null;
  body: ElementStub;
  documentElement: ElementStub;
  createElement(tag: string): ElementStub;
  createElementNS(_: string, tag: string): ElementStub;
  createTextNode(text: string): { nodeType: number; nodeValue: string; ownerDocument: DocumentStub; parentNode: ElementStub | null };
  addEventListener(): void;
  removeEventListener(): void;
}

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = <T,>(name: string, value: T) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  const makeElement = (tag: string, owner: DocumentStub): ElementStub => ({
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    id: '',
    attributes: {},
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    style: {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
    insertBefore(child, ref) {
      if (ref === null) {
        return this.appendChild(child);
      }
      const index = this.childNodes.indexOf(ref);
      if (index === -1) {
        return this.appendChild(child);
      }
      this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) {
        this.childNodes.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === 'id') {
        this.id = value;
      }
    },
    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'id') {
        this.id = '';
      }
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
  });

  // SAFETY: The document stub is fully populated immediately below before any consumer can observe it.
  const documentStub = {} as DocumentStub;
  const body = makeElement('body', documentStub);
  const html = makeElement('html', documentStub);
  Object.assign(documentStub, {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    body,
    documentElement: html,
    createElement: (tag: string) => makeElement(tag, documentStub),
    createElementNS: (_: string, tag: string) => makeElement(tag, documentStub),
    createTextNode: (text: string) => ({ nodeType: 3, nodeValue: text, ownerDocument: documentStub, parentNode: null }),
    addEventListener() {},
    removeEventListener() {},
  });

  class GlobalElement {}
  class ControlledIntersectionObserver implements IntersectionObserver {
    readonly #instance: ObserverInstance;
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: ReadonlyArray<number>;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? '0px';
      if (Array.isArray(options?.threshold)) {
        this.thresholds = [...options.threshold];
      } else if (options?.threshold !== undefined) {
        this.thresholds = [options.threshold];
      } else {
        this.thresholds = [0];
      }
      this.#instance = { callback, elements: [], options, observer: this };
      observerInstances.push(this.#instance);
    }

    disconnect() {
      this.#instance.elements.length = 0;
    }

    observe(target: Element) {
      this.#instance.elements.push(getObservedElementStub(target));
    }

    takeRecords() {
      return [];
    }

    unobserve(target: Element) {
      const observedTarget = getObservedElementStub(target);
      const index = this.#instance.elements.indexOf(observedTarget);
      if (index >= 0) {
        this.#instance.elements.splice(index, 1);
      }
    }
  }

  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('navigator', { userAgent: 'bun', platform: 'test', maxTouchPoints: 0 });
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', GlobalElement);
  setGlobal('HTMLElement', GlobalElement);
  setGlobal('HTMLIFrameElement', GlobalElement);
  setGlobal('HTMLButtonElement', GlobalElement);
  setGlobal('HTMLInputElement', GlobalElement);
  setGlobal('SVGElement', GlobalElement);
  setGlobal('Node', GlobalElement);
  setGlobal('MutationObserver', class {
    disconnect() {}
    observe() {}
    takeRecords() { return []; }
  });
  setGlobal('IntersectionObserver', ControlledIntersectionObserver);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const restore = () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };

  const container = makeElement('div', documentStub);
  const isReactContainer = (value: ElementStub): value is ElementStub & ReactContainer => value.nodeType === 1;
  if (!isReactContainer(container)) {
    throw new Error('Expected the React root container to be an element');
  }
  return { container, restore };
};

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createEmptyDomRectReadOnly = (): DOMRectReadOnly => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
});

const isObservedElementStub = (value: Element | Document | null | undefined): value is ObservedElementStub => (
  value !== null
  && value !== undefined
  && 'attributes' in value
  && 'childNodes' in value
  && 'style' in value
  && 'ownerDocument' in value
);

const getObservedElementStubOrThrow = (value: Element | Document | null | undefined, source: string): ObservedElementStub => {
  if (isObservedElementStub(value)) {
    return value;
  }
  throw new Error(`Expected ${source} to be a stubbed element`);
};

const getElementStubOrNull = (value: IntersectionObserverInit['root'] | undefined): ObservedElementStub | null => {
  if (value !== null && value !== undefined) {
    return getObservedElementStubOrThrow(value, 'observer root');
  }
  return null;
};

const getObservedElementStub = (value: Element): ObservedElementStub => getObservedElementStubOrThrow(value, 'observer target');

const createIntersectionEntry = (target: ObservedElementStub): IntersectionObserverEntry => ({
  isIntersecting: true,
  target,
  intersectionRatio: 1,
  boundingClientRect: createEmptyDomRectReadOnly(),
  intersectionRect: createEmptyDomRectReadOnly(),
  rootBounds: null,
  time: 0,
});

const createUnusedGitApi = (): GitAPI => {
  const gitApiSource = {};
  // SAFETY: These regression paths verify rendering and observer wiring only and never invoke GitAPI methods.
  return gitApiSource as GitAPI;
};

const createQueryState = (overrides: Partial<NonNullable<MockQueryState>> = {}): NonNullable<MockQueryState> => ({
  items: [{
    id: 'commit-a',
    parentIds: ['commit-root'],
    subject: 'subject',
    message: 'message',
    author: 'author',
    authorEmail: 'author@example.com',
    timestamp: '2024-01-01T00:00:00Z',
    statistics: { files: 0, insertions: 0, deletions: 0 },
    references: [],
  }],
  outdated: false,
  isLoading: false,
  isLoadingMore: false,
  error: null,
  hasMore: true,
  refIds: ['refs/heads/topic', 'refs/remotes/origin/topic'],
  ...overrides,
});

const renderPanel = async (props: Partial<React.ComponentProps<typeof GitGraphPanel>> = {}) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.container);

  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        createGitGraphPanelElement(createDefaultGitGraphPanelProps(props)),
      ),
    );
    await flushEffects();
  });

  return {
    restore: async () => {
      await act(async () => {
        root.unmount();
        await flushEffects();
      });
      dom.restore();
    },
  };
};

const triggerSentinelIntersection = async () => {
  for (const instance of observerInstances) {
    const entries = instance.elements.map(createIntersectionEntry);
    instance.callback(entries, instance.observer);
  }
  await flushEffects();
};

const getAppendFetchCalls = () => fetchHistoryCalls.filter((call) => call.options?.append === true);

const createGitGraphPanelElement = (props: React.ComponentProps<typeof GitGraphPanel>) => React.createElement(GitGraphPanel, props);

const createDefaultGitGraphPanelProps = (overrides: Partial<React.ComponentProps<typeof GitGraphPanel>> = {}): React.ComponentProps<typeof GitGraphPanel> => ({
  directory: '/repo',
  git: createUnusedGitApi(),
  commitDetailsController: {
    getCommitSnapshot: () => ({ status: 'idle' }),
    subscribeCommit: () => () => {},
    isExpanded: () => false,
    subscribeExpanded: () => () => {},
    toggleExpanded: () => {},
    retryCommit: () => {},
    selectFile: () => {},
    confirmLargePreview: () => {},
    retryPreview: () => {},
    clearSelection: () => {},
    getPreviewSnapshot: () => ({ status: 'idle' }),
    subscribePreview: () => () => {},
    dispose: () => {},
  },
  onCopyHash: () => {},
  isActive: true,
  ...overrides,
});

const settleMergeBaseLookupCount = async (getLookupCallCount: () => number) => {
  let previousCount = -1;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await act(async () => {
      await flushEffects();
    });
    const currentCount = getLookupCallCount();
    if (currentCount === previousCount) {
      return currentCount;
    }
    previousCount = currentCount;
  }
  throw new Error(`Merge-base lookup count did not settle: ${getLookupCallCount()}`);
};

describe('GitGraphPanel component regression', () => {
  beforeEach(() => {
    renderedGraphSegmentIds.length = 0;
    renderedHistoryRows.length = 0;
    mockEnsureHistoryRefs = mock(async () => null);
    mockFetchHistoryPage = mock(async (
      directory: string,
      git: GitAPI,
      query: FetchHistoryCall['query'],
      options?: FetchHistoryCall['options'],
    ) => {
      fetchHistoryCalls.push({ directory, git, query, options });
      return undefined;
    });
    fetchHistoryCalls.length = 0;
    observerInstances.length = 0;
    gitPaneState = {
      changesCollapsed: false,
      graphCollapsed: true,
      graphHeight: 280,
      graphFilterMode: 'auto',
      graphManualRefIds: [],
    };
    mockRefsState = {
      refs: {
        refs: [
          { id: 'refs/heads/topic', name: 'topic', revision: 'commit-a', kind: 'local', category: 'branches' },
          { id: 'refs/remotes/origin/topic', name: 'origin/topic', revision: 'commit-b', kind: 'remote', category: 'remote-branches' },
        ],
        current: { id: 'refs/heads/topic', name: 'topic', revision: 'commit-a', kind: 'local', category: 'branches' },
        upstream: { id: 'refs/remotes/origin/topic', name: 'origin/topic', revision: 'commit-b', kind: 'remote', category: 'remote-branches' },
        base: null,
      },
      refsError: null,
      isLoadingRefs: false,
    };
    mockQueryState = createQueryState({ hasMore: false });
  });

  test('does not repeat merge-base lookup for an unchanged comparison request', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    let lookupCallCount = 0;
    const getGitHistoryMergeBase = async () => {
      lookupCallCount += 1;
      return { mergeBase: 'commit-root' };
    };
    const gitApi = {
      getGitHistoryMergeBase,
    } satisfies Pick<GitAPI, 'getGitHistoryMergeBase'>;
    const panelGitApiSource: Pick<GitAPI, 'getGitHistoryMergeBase'> & Partial<GitAPI> = gitApi;
    // SAFETY: GitGraphPanel only reads getGitHistoryMergeBase from the git API on this test path.
    const panelGitApi = panelGitApiSource as GitAPI;

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi })),
        ),
      );
      await flushEffects();
    });

    const settledCallCount = await settleMergeBaseLookupCount(() => lookupCallCount);
    expect(settledCallCount).toBeGreaterThan(0);

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi })),
        ),
      );
      await flushEffects();
    });

    expect(await settleMergeBaseLookupCount(() => lookupCallCount)).toBe(settledCallCount);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.restore();
  });

  test('renders incoming and outgoing synthetic graph rows when divergent history has a merge base', async () => {
    mockRefsState = {
      refs: {
        refs: [
          { id: 'refs/heads/main', name: 'main', revision: 'c', kind: 'local', category: 'branches' },
          { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'a', kind: 'remote', category: 'remote-branches' },
        ],
        current: { id: 'refs/heads/main', name: 'main', revision: 'c', kind: 'local', category: 'branches' },
        upstream: { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'a', kind: 'remote', category: 'remote-branches' },
        base: null,
      },
      refsError: null,
      isLoadingRefs: false,
    };
    mockQueryState = {
      items: [
        {
          id: 'a',
          parentIds: ['b'],
          subject: 'remote',
          message: 'remote',
          author: 'author',
          authorEmail: 'author@example.com',
          timestamp: '2024-01-01T00:00:00Z',
          statistics: { files: 0, insertions: 0, deletions: 0 },
          references: [],
        },
        {
          id: 'b',
          parentIds: ['e'],
          subject: 'remote-parent',
          message: 'remote-parent',
          author: 'author',
          authorEmail: 'author@example.com',
          timestamp: '2024-01-01T00:00:00Z',
          statistics: { files: 0, insertions: 0, deletions: 0 },
          references: [],
        },
        {
          id: 'c',
          parentIds: ['d'],
          subject: 'head',
          message: 'head',
          author: 'author',
          authorEmail: 'author@example.com',
          timestamp: '2024-01-01T00:00:00Z',
          statistics: { files: 0, insertions: 0, deletions: 0 },
          references: [],
        },
        {
          id: 'd',
          parentIds: ['e'],
          subject: 'local-parent',
          message: 'local-parent',
          author: 'author',
          authorEmail: 'author@example.com',
          timestamp: '2024-01-01T00:00:00Z',
          statistics: { files: 0, insertions: 0, deletions: 0 },
          references: [],
        },
        {
          id: 'e',
          parentIds: ['f'],
          subject: 'merge-base',
          message: 'merge-base',
          author: 'author',
          authorEmail: 'author@example.com',
          timestamp: '2024-01-01T00:00:00Z',
          statistics: { files: 0, insertions: 0, deletions: 0 },
          references: [],
        },
        {
          id: 'f',
          parentIds: ['g'],
          subject: 'older',
          message: 'older',
          author: 'author',
          authorEmail: 'author@example.com',
          timestamp: '2024-01-01T00:00:00Z',
          statistics: { files: 0, insertions: 0, deletions: 0 },
          references: [],
        },
      ],
      outdated: false,
      isLoading: false,
      isLoadingMore: false,
      error: null,
      hasMore: false,
      refIds: ['refs/heads/main', 'refs/remotes/origin/main'],
    };

    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const gitApi = {
      getGitHistoryMergeBase: async () => ({ mergeBase: 'e' }),
    } satisfies Pick<GitAPI, 'getGitHistoryMergeBase'>;
    const panelGitApiSource: Pick<GitAPI, 'getGitHistoryMergeBase'> & Partial<GitAPI> = gitApi;
    // SAFETY: GitGraphPanel only reads getGitHistoryMergeBase from the git API on this test path.
    const panelGitApi = panelGitApiSource as GitAPI;

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi })),
        ),
      );
      await flushEffects();
    });

    await settleMergeBaseLookupCount(() => renderedGraphSegmentIds.length);

    expect(renderedGraphSegmentIds).toEqual([
      'scm-graph-outgoing-changes',
      'scm-graph-incoming-changes',
    ]);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.restore();
  });

  test('requests compact graph rows for graph commit entries', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    // SAFETY: This regression path does not read any git API methods.
    const panelGitApi = {} as GitAPI;

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi })),
        ),
      );
      await flushEffects();
    });

    expect(renderedHistoryRows.some((row) => row.id === 'commit-a' && row.compactGraph === true)).toBe(true);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.restore();
  });

  test('passes the repository-scoped commit details controller and commit comparison to each commit row', async () => {
    const controller = createDefaultGitGraphPanelProps().commitDetailsController;
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(GitGraphPanel, {
            ...createDefaultGitGraphPanelProps(),
            commitDetailsController: controller,
          }),
        ),
      );
      await flushEffects();
    });

    const row = renderedHistoryRows.find((candidate) => candidate.id === 'commit-a');
    expect(row?.compactGraph).toBe(true);
    expect(row?.commitDetailsController).toBe(controller);
    expect(row?.commitComparison).toEqual({
      directory: '/repo',
      commitHash: 'commit-a',
      parentHash: 'commit-root',
    });
    expect(row?.onCompareWithRemote).toBeDefined();
    expect(row?.onCompareWithRef).toBeDefined();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.restore();
  });

  test('applies and clears comparison overrides on graph rows', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const toggledComparisons: Array<{ directory: string; commitHash: string; parentHash: string | null }> = [];

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(GitGraphPanel, {
            ...createDefaultGitGraphPanelProps(),
            commitDetailsController: {
              getCommitSnapshot: () => ({ status: 'idle' as const }),
              subscribeCommit: () => () => {},
              isExpanded: () => false,
              subscribeExpanded: () => () => {},
              toggleExpanded: (comparison: { directory: string; commitHash: string; parentHash: string | null }) => {
                toggledComparisons.push(comparison);
              },
              retryCommit: () => {},
              selectFile: () => {},
              confirmLargePreview: () => {},
              retryPreview: () => {},
              clearSelection: () => {},
              getPreviewSnapshot: () => ({ status: 'idle' as const }),
              subscribePreview: () => () => {},
              dispose: () => {},
            },
          }),
        ),
      );
      await flushEffects();
    });

    const lastRowFor = (id: string) => {
      for (let index = renderedHistoryRows.length - 1; index >= 0; index -= 1) {
        if (renderedHistoryRows[index]?.id === id) {
          return renderedHistoryRows[index];
        }
      }
      return undefined;
    };

    let row = lastRowFor('commit-a');
    expect(row?.commitComparison?.parentHash).toBe('commit-root');
    expect(row?.onCompareWithRemote).toBeDefined();
    expect(row?.canCompareWithRemote).toBe(true);
    expect(row?.canCompareWithMergeBase).toBe(false);
    expect(row?.onCompareWithRef).toBeDefined();
    expect(row?.activeComparisonLabel).toBeNull();

    await act(async () => {
      row?.onCompareWithRemote?.();
      await flushEffects();
    });

    row = lastRowFor('commit-a');
    expect(row?.commitComparison).toEqual({ directory: '/repo', commitHash: 'commit-a', parentHash: 'commit-b' });
    expect(row?.activeComparisonLabel).toBe('origin/topic');
    expect(row?.onClearComparison).toBeDefined();
    expect(toggledComparisons).toEqual([
      { directory: '/repo', commitHash: 'commit-a', parentHash: 'commit-b' },
    ]);

    await act(async () => {
      row?.onClearComparison?.();
      await flushEffects();
    });

    row = lastRowFor('commit-a');
    expect(row?.commitComparison?.parentHash).toBe('commit-root');
    expect(row?.activeComparisonLabel).toBeNull();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.restore();
  });

  test('uses the existing graph pane and leaves filter controls to the pane header', () => {
    // SAFETY: Server rendering does not execute effects or read git API methods.
    const panelGitApi = {} as GitAPI;
    const markup = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi })),
      ),
    );

    const panelClass = markup.match(/<section id="git-graph-panel" class="([^"]+)"/)?.[1];
    expect(panelClass).toBe('flex h-full min-h-0 flex-col');
    expect(markup).not.toContain('aria-label="Refresh"');
    expect(markup).not.toContain('>Auto</button>');
    expect(markup).not.toContain('>All</button>');
    expect(markup).not.toContain('>Manual</button>');
  });

  test('requests one append page with the scroll container as observer root when the active sentinel intersects', async () => {
    const git = createUnusedGitApi();
    mockQueryState = createQueryState();
    const rendered = await renderPanel({ git, isActive: true });

    expect(observerInstances).toHaveLength(1);
    const observer = observerInstances[0];
    const observerRoot = getElementStubOrNull(observer.options?.root);
    expect(observerRoot).not.toBeNull();
    expect(observerRoot?.id).toBe('git-graph-scroll-container');
    expect(observer.elements).toHaveLength(1);
    expect(observer.elements[0]?.id).toBe('git-graph-end-sentinel');

    await act(async () => {
      await triggerSentinelIntersection();
    });

    expect(getAppendFetchCalls()).toEqual([
      {
        directory: '/repo',
        git,
        query: { mode: 'auto' },
        options: { append: true, limit: 20 },
      },
    ]);

    await rendered.restore();
  });

  test('does not render an accessible Load more button when more history exists', () => {
    mockQueryState = createQueryState();
    const markup = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        createGitGraphPanelElement(createDefaultGitGraphPanelProps()),
      ),
    );

    expect(markup).not.toContain('>Load more</button>');
  });

  for (const scenario of [
    { name: 'the graph is inactive', isActive: false, queryOverrides: {} },
    { name: 'an append request is already in flight', isActive: true, queryOverrides: { isLoadingMore: true } },
    { name: 'the query is outdated', isActive: true, queryOverrides: { outdated: true } },
    { name: 'the query has an error', isActive: true, queryOverrides: { error: 'append failed' } },
    { name: 'the initial query is still loading', isActive: true, queryOverrides: { isLoading: true } },
  ] as const) {
    test(`does not append while ${scenario.name}`, async () => {
      mockQueryState = createQueryState(scenario.queryOverrides);
      const rendered = await renderPanel({ isActive: scenario.isActive });

      await act(async () => {
        await triggerSentinelIntersection();
      });

      expect(getAppendFetchCalls()).toEqual([]);

      await rendered.restore();
    });
  }

  test('defers stale graph refresh until the panel becomes active, then refreshes refs before history once', async () => {
    mockQueryState = {
      items: [{
        id: 'stale-commit',
        parentIds: ['commit-root'],
        subject: 'stale subject',
        message: 'stale message',
        author: 'author',
        authorEmail: 'author@example.com',
        timestamp: '2024-01-01T00:00:00Z',
        statistics: { files: 0, insertions: 0, deletions: 0 },
        references: [],
      }],
      outdated: true,
      isLoading: false,
      isLoadingMore: false,
      error: null,
      hasMore: false,
      refIds: ['refs/heads/topic', 'refs/remotes/origin/topic'],
    };

    const refreshSequence: string[] = [];
    let ensureHistoryRefsCalls = 0;
    let fetchHistoryPageCalls = 0;
    mockEnsureHistoryRefs = mock(async () => {
      ensureHistoryRefsCalls += 1;
      refreshSequence.push('refs');
      return null;
    });
    mockFetchHistoryPage = mock(async () => {
      fetchHistoryPageCalls += 1;
      refreshSequence.push('history');
      return undefined;
    });

    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const panelGitApi = createUnusedGitApi();

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi, isActive: false })),
        ),
      );
      await flushEffects();
    });

    expect(renderedHistoryRows.some((row) => row.id === 'stale-commit' && row.compactGraph === true)).toBe(true);
    expect(ensureHistoryRefsCalls).toBe(0);
    expect(fetchHistoryPageCalls).toBe(0);

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi, isActive: true })),
        ),
      );
      await flushEffects();
    });

    expect(ensureHistoryRefsCalls).toBe(1);
    expect(fetchHistoryPageCalls).toBe(1);
    expect(refreshSequence).toEqual(['refs', 'history']);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.restore();
  });

  test('keeps stale loaded rows visible without rendering an outdated history notice', () => {
    mockQueryState = {
      items: [{
        id: 'stale-commit',
        parentIds: ['commit-root'],
        subject: 'stale subject',
        message: 'stale message',
        author: 'author',
        authorEmail: 'author@example.com',
        timestamp: '2024-01-01T00:00:00Z',
        statistics: { files: 0, insertions: 0, deletions: 0 },
        references: [],
      }],
      outdated: true,
      isLoading: false,
      isLoadingMore: false,
      error: null,
      hasMore: false,
      refIds: ['refs/heads/topic', 'refs/remotes/origin/topic'],
    };

    const panelGitApi = createUnusedGitApi();
    const markup = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        createGitGraphPanelElement(createDefaultGitGraphPanelProps({ git: panelGitApi, isActive: false })),
      ),
    );

    expect(markup).toContain('data-history-id="stale-commit"');
    expect(markup).not.toContain(enDict['gitView.graph.outdated']);
  });
});

describe('GitGraphPanel helpers', () => {
  test('groups refs by category for manual selection', () => {
    const grouped = groupGraphRefs([
      { id: 'HEAD', name: 'HEAD', revision: 'a', kind: 'head', category: 'branches' },
      { id: 'refs/heads/main', name: 'main', revision: 'a', kind: 'local', category: 'branches' },
      { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'a', kind: 'remote', category: 'remote-branches' },
      { id: 'refs/tags/v1', name: 'v1', revision: 'a', kind: 'tag', category: 'tags' },
    ]);

    expect(grouped.branches.map((ref) => ref.id)).toEqual(['refs/heads/main']);
    expect(grouped.remoteBranches.map((ref) => ref.id)).toEqual(['refs/remotes/origin/main']);
    expect(grouped.tags.map((ref) => ref.id)).toEqual(['refs/tags/v1']);
  });

  test('falls back to auto query when manual mode has no refs', () => {
    expect(resolveGraphQuery({
      changesCollapsed: false,
      graphCollapsed: true,
      graphHeight: 280,
      graphFilterMode: 'manual',
      graphManualRefIds: [],
    })).toEqual({ mode: 'auto' });
  });

  test('derives merge-base refs only from current, upstream, and base identities', () => {
    expect(resolveMergeBaseComparisonRefIds({
      current: { id: 'refs/heads/topic' },
      upstream: { id: 'refs/remotes/origin/topic' },
      base: { id: 'refs/remotes/origin/main' },
    })).toEqual([
      'refs/heads/topic',
      'refs/remotes/origin/main',
      'refs/remotes/origin/topic',
    ]);

    expect(resolveMergeBaseComparisonRefIds({
      current: { id: 'refs/heads/topic' },
      upstream: { id: 'refs/heads/topic' },
      base: { id: 'refs/remotes/origin/main' },
    })).toEqual([
      'refs/heads/topic',
      'refs/remotes/origin/main',
    ]);
  });

  test('skips merge-base lookup when fewer than two comparison refs are available', () => {
    expect(resolveMergeBaseComparisonRefIds({
      current: { id: 'refs/heads/topic' },
      upstream: null,
      base: null,
    })).toEqual([]);
  });

  test('keeps loaded rows renderable and shows a non-blocking merge-base explanation', () => {
    expect(resolveGitGraphPanelRenderState({
      itemCount: 3,
      queryError: null,
      refsError: null,
      mergeBaseError: 'merge base failed',
    })).toEqual({
      showInlineMergeBaseError: true,
      showRows: true,
      emptyMessage: null,
    });
  });

  test('auto refreshes initial graph query only when refs are not already loading', () => {
    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: null,
    })).toBe(true);

    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: true,
      refsError: null,
      queryState: null,
    })).toBe(false);

    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: 'refs failed',
      queryState: null,
    })).toBe(false);
  });

  test('auto refreshes outdated graph queries only when idle and error free', () => {
    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: {
        outdated: true,
        isLoading: false,
        isLoadingMore: false,
        error: null,
        items: [{ id: 'commit-a' }],
      },
    })).toBe(true);

    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: {
        outdated: true,
        isLoading: true,
        isLoadingMore: false,
        error: null,
        items: [{ id: 'commit-a' }],
      },
    })).toBe(false);

    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: {
        outdated: true,
        isLoading: false,
        isLoadingMore: true,
        error: null,
        items: [{ id: 'commit-a' }],
      },
    })).toBe(false);

    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: {
        outdated: true,
        isLoading: false,
        isLoadingMore: false,
        error: 'refresh failed',
        items: [{ id: 'commit-a' }],
      },
    })).toBe(false);
  });

  test('does not auto refresh authoritative empty or failed graph queries', () => {
    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: {
        outdated: false,
        isLoading: false,
        isLoadingMore: false,
        error: null,
        items: [],
      },
    })).toBe(false);

    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: {
        outdated: false,
        isLoading: false,
        isLoadingMore: false,
        error: 'initial load failed',
        items: [],
      },
    })).toBe(false);

    expect(shouldAutoRefreshGitGraphQuery({
      isLoadingRefs: false,
      refsError: null,
      queryState: {
        outdated: false,
        isLoading: false,
        isLoadingMore: false,
        error: 'refresh failed',
        items: [{ id: 'commit-a' }],
      },
    })).toBe(false);
  });

  test('disables graph filter edits while refs are loading or errored', () => {
    expect(isGitGraphFilterDisabled({ isLoadingRefs: false, refsError: null })).toBe(false);
    expect(isGitGraphFilterDisabled({ isLoadingRefs: true, refsError: null })).toBe(true);
    expect(isGitGraphFilterDisabled({ isLoadingRefs: false, refsError: 'refs failed' })).toBe(true);
  });
});
