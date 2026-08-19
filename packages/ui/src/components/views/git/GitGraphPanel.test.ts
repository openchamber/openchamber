import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
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

mock.module('./HistoryCommitRow', () => ({
  HistoryCommitRow: ({ entry }: { entry: { id: string } }) => React.createElement('li', { 'data-history-id': entry.id }),
}));

let gitPaneState: GitRepositoryPaneState = {
  changesCollapsed: false,
  graphCollapsed: true,
  graphHeight: 280,
  graphFilterMode: 'auto',
  graphManualRefIds: [],
};

const mockEnsureHistoryRefs = async () => null;
const mockFetchHistoryPage = async () => undefined;
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
  setAttribute(): void;
  removeAttribute(): void;
}

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
    setAttribute() {},
    removeAttribute() {},
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
  // SAFETY: The stubbed element satisfies the DOM container contract React uses in this test.
  const containerValue = container as unknown;
  // SAFETY: React only touches the container fields provided by the stub in this test.
  const reactContainer = containerValue as ReactContainer;
  return { container: reactContainer, restore };
};

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

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
    mockQueryState = {
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
      hasMore: false,
      refIds: ['refs/heads/topic', 'refs/remotes/origin/topic'],
    };
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
          React.createElement(GitGraphPanel, {
            directory: '/repo',
            git: panelGitApi,
            expandedCommitHashes: new Set<string>(),
            onToggleCommit: () => {},
            commitFilesMap: new Map(),
            loadingCommitHashes: new Set<string>(),
            onCopyHash: () => {},
          }),
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
          React.createElement(GitGraphPanel, {
            directory: '/repo',
            git: panelGitApi,
            expandedCommitHashes: new Set<string>(),
            onToggleCommit: () => {},
            commitFilesMap: new Map(),
            loadingCommitHashes: new Set<string>(),
            onCopyHash: () => {},
          }),
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
          React.createElement(GitGraphPanel, {
            directory: '/repo',
            git: panelGitApi,
            expandedCommitHashes: new Set<string>(),
            onToggleCommit: () => {},
            commitFilesMap: new Map(),
            loadingCommitHashes: new Set<string>(),
            onCopyHash: () => {},
          }),
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
