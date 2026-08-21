import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n/context';
import type { GitCommitChangedFile, GitCommitHoverDetailsCache, GitRemote } from '@/lib/api/types';
import type { GitHistoryPage, GitHistoryRefsResponse, RuntimeAPIs } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGitStore } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusPresenceProvider } from './presence';

const historyRowCalls: Array<{
  id: string;
  showGraphActions?: boolean;
  onCopyHash: (hash: string) => void;
  commitComparison?: { directory: string; commitHash: string; parentHash: string | null };
  commitDetailsController?: {
    selectFile: (comparison: { directory: string; commitHash: string; parentHash: string | null }, file: GitCommitChangedFile) => void;
  };
  hoverRemoteName?: string | null;
  hoverRemoteUrl?: string | null;
  hoverDetailsCache?: GitCommitHoverDetailsCache | null;
}> = [];
const copiedHashes: string[] = [];
const createToastMessages = () => ({ success: Array<string>(), error: Array<string>() });
const toastMessages = createToastMessages();

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => <span data-icon={name} className={className} />,
}));

mock.module('@/lib/clipboard', () => ({
  copyTextToClipboard: async (text: string) => {
    copiedHashes.push(text);
    return { ok: true };
  },
}));

mock.module('@/components/ui/toast', () => ({
  toast: {
    success(message: string) {
      toastMessages.success.push(message);
    },
    error(message: string) {
      toastMessages.error.push(message);
    },
  },
}));

mock.module('@/components/views/git/HistoryCommitRow', () => ({
  HistoryCommitRow: ({
    entry,
    showGraphActions,
    onCopyHash,
    commitComparison,
    commitDetailsController,
    hoverRemoteName,
    hoverRemoteUrl,
    hoverDetailsCache,
  }: {
    entry: { id: string };
    showGraphActions?: boolean;
    onCopyHash: (hash: string) => void;
    commitComparison?: { directory: string; commitHash: string; parentHash: string | null };
    commitDetailsController?: {
      selectFile: (comparison: { directory: string; commitHash: string; parentHash: string | null }, file: GitCommitChangedFile) => void;
    };
    hoverRemoteName?: string | null;
    hoverRemoteUrl?: string | null;
    hoverDetailsCache?: GitCommitHoverDetailsCache | null;
  }) => {
    historyRowCalls.push({
      id: entry.id,
      showGraphActions,
      onCopyHash,
      commitComparison,
      commitDetailsController,
      hoverRemoteName,
      hoverRemoteUrl,
      hoverDetailsCache,
    });
    return <li data-history-row={entry.id} />;
  },
}));

import { WorkStatusGitGraphSection } from './WorkStatusGitGraphSection';

type ReactContainer = Parameters<typeof createRoot>[0];

type ElementStub = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  id: string;
  attributes: Record<string, string>;
  namespaceURI: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
  childNodes: Array<ElementStub | TextStub>;
  style: Record<string, string>;
  textContent: string;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(child: ElementStub | TextStub): ElementStub | TextStub;
  insertBefore(child: ElementStub | TextStub, ref: ElementStub | TextStub | null): ElementStub | TextStub;
  removeChild(child: ElementStub | TextStub): ElementStub | TextStub;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
};

type TextStub = {
  nodeType: number;
  nodeValue: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
};

type DocumentStub = {
  nodeType: number;
  defaultView: typeof globalThis;
  activeElement: ElementStub | null;
  body: ElementStub | null;
  documentElement: ElementStub | null;
  createElement(tag: string): ElementStub;
  createElementNS(_: string, tag: string): ElementStub;
  createTextNode(text: string): TextStub;
  addEventListener(): void;
  removeEventListener(): void;
};

type ReactContainerLike = ReactContainer & ElementStub;

const createHistoryRefs = (): GitHistoryRefsResponse => ({
  refs: [
    { id: 'HEAD', name: 'HEAD', revision: 'head-sha', kind: 'head', category: 'branches' },
    { id: 'refs/heads/main', name: 'main', revision: 'head-sha', kind: 'local', category: 'branches' },
  ],
  current: { id: 'refs/heads/main', name: 'main', revision: 'head-sha', kind: 'local', category: 'branches' },
  upstream: null,
  base: null,
  snapshot: 'snapshot-a',
});

const createHistoryPage = (): GitHistoryPage => ({
  items: [{
    id: 'a'.repeat(40),
    parentIds: ['b'.repeat(40)],
    subject: 'subject',
    message: 'message',
    author: 'Author',
    authorEmail: 'author@example.com',
    timestamp: '2026-01-01T00:00:00.000Z',
    statistics: { files: 1, insertions: 1, deletions: 0 },
    references: [],
  }],
  nextCursor: null,
  hasMore: false,
  refsSnapshot: 'snapshot-a',
});

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
    textContent: '',
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, ref) {
      if (ref === null) return this.appendChild(child);
      const index = this.childNodes.indexOf(ref);
      if (index === -1) return this.appendChild(child);
      this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === 'id') this.id = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'id') this.id = '';
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    focus() {
      owner.activeElement = this;
    },
  });

  const documentStub: DocumentStub = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    body: null,
    documentElement: null,
    createElement(tag) {
      return makeElement(tag, documentStub);
    },
    createElementNS(_, tag) {
      return makeElement(tag, documentStub);
    },
    createTextNode(text) {
      return { nodeType: 3, nodeValue: text, ownerDocument: documentStub, parentNode: null };
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const rawContainer = makeElement('div', documentStub);
  if (!isReactContainerLike(rawContainer)) {
    throw new Error('Expected a React-compatible container');
  }
  const container = rawContainer;
  documentStub.body = container;
  documentStub.documentElement = container;

  class ElementClass {}
  class IntersectionObserverStub {
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  }

  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('navigator', { userAgent: 'bun', platform: 'test', maxTouchPoints: 0 });
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementClass);
  setGlobal('HTMLElement', ElementClass);
  setGlobal('HTMLButtonElement', ElementClass);
  setGlobal('HTMLInputElement', ElementClass);
  setGlobal('HTMLIFrameElement', ElementClass);
  setGlobal('SVGElement', ElementClass);
  setGlobal('Node', ElementClass);
  setGlobal('MutationObserver', class {
    disconnect() {}
    observe() {}
    takeRecords() { return []; }
  });
  setGlobal('IntersectionObserver', IntersectionObserverStub);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  return {
    container,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const isElementStub = (node: ElementStub | TextStub | null | undefined): node is ElementStub =>
  Boolean(node && node.nodeType === 1);

const isReactContainerLike = (value: ElementStub | null): value is ReactContainerLike => value !== null;

const unexpectedAsync = async (): Promise<never> => {
  throw new Error('Unexpected fixture call');
};

const createGitStatus = () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true });
const createGitBranches = () => ({ all: [], current: 'main', branches: {} });
const createGitLog = () => ({ all: [], latest: null, total: 0 });

const createRuntimeApis = (gitOverrides: Partial<RuntimeAPIs['git']> = {}, github?: RuntimeAPIs['github']): RuntimeAPIs => {
  const runtimeApis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    terminal: {
      listShells: unexpectedAsync,
      createSession: unexpectedAsync,
      connect: () => ({ close() {} }),
      sendInput: unexpectedAsync,
      resize: unexpectedAsync,
      close: unexpectedAsync,
    },
    git: {
      checkIsGitRepository: async () => true,
      getGitStatus: async () => createGitStatus(),
      getGitHistoryRefs: async () => createHistoryRefs(),
      getGitHistory: async () => createHistoryPage(),
      getGitDiff: unexpectedAsync,
      getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
      revertGitFile: unexpectedAsync,
      stageGitFile: unexpectedAsync,
      unstageGitFile: unexpectedAsync,
      isLinkedWorktree: async () => false,
      getGitBranches: async () => createGitBranches(),
      deleteGitBranch: unexpectedAsync,
      deleteRemoteBranch: unexpectedAsync,
      removeRemote: unexpectedAsync,
      generateCommitMessage: unexpectedAsync,
      generatePullRequestDescription: unexpectedAsync,
      listGitWorktrees: unexpectedAsync,
      createGitCommit: unexpectedAsync,
      gitPush: unexpectedAsync,
      gitPull: unexpectedAsync,
      gitFetch: unexpectedAsync,
      listGitStashes: unexpectedAsync,
      countGitStashFiles: unexpectedAsync,
      stashGitChanges: unexpectedAsync,
      applyGitStash: unexpectedAsync,
      popGitStash: unexpectedAsync,
      dropGitStash: unexpectedAsync,
      checkoutBranch: unexpectedAsync,
      createBranch: unexpectedAsync,
      renameBranch: unexpectedAsync,
      getGitLog: async () => createGitLog(),
      getCommitFiles: unexpectedAsync,
      getCurrentGitIdentity: async () => null,
      setGitIdentity: unexpectedAsync,
      getGitIdentities: unexpectedAsync,
      createGitIdentity: unexpectedAsync,
      updateGitIdentity: unexpectedAsync,
      deleteGitIdentity: unexpectedAsync,
      getRemotes: async () => [],
      rebase: unexpectedAsync,
      abortRebase: unexpectedAsync,
      continueRebase: unexpectedAsync,
      merge: unexpectedAsync,
      abortMerge: unexpectedAsync,
      continueMerge: unexpectedAsync,
      checkoutCommit: unexpectedAsync,
      cherryPick: unexpectedAsync,
      revertCommit: unexpectedAsync,
      resetToCommit: unexpectedAsync,
      stash: unexpectedAsync,
      stashPop: unexpectedAsync,
      getConflictDetails: unexpectedAsync,
      ...gitOverrides,
    },
    files: {
      listDirectory: unexpectedAsync,
      search: unexpectedAsync,
      createDirectory: unexpectedAsync,
    },
    settings: {
      load: unexpectedAsync,
      save: unexpectedAsync,
    },
    permissions: {
      requestDirectoryAccess: unexpectedAsync,
      startAccessingDirectory: unexpectedAsync,
      stopAccessingDirectory: unexpectedAsync,
    },
    notifications: {
      notifyAgentCompletion: unexpectedAsync,
    },
    tools: {
      getAvailableTools: unexpectedAsync,
    },
  };

  if (github) {
    runtimeApis.github = github;
  }

  return runtimeApis;
};

const findElement = (node: ElementStub | TextStub | null | undefined, predicate: (element: ElementStub) => boolean): ElementStub | null => {
  if (!isElementStub(node)) return null;
  const element = node;
  if (predicate(element)) return element;
  for (const child of element.childNodes) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
};

const collectPresenceCounts = () => {
  const counts: number[] = [];
  return {
    counts,
    onChange(nextCount: number) {
      counts.push(nextCount);
    },
  };
};

const renderSection = async (
  props: { directory: string | null; panelVisible: boolean },
  runtimeApis: RuntimeAPIs,
  onPresenceChange: (count: number) => void = () => {},
) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.container);

  const renderWithProps = async (nextProps: { directory: string | null; panelVisible: boolean }) => {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeApis}>
          <I18nProvider>
            <WorkStatusPresenceProvider onChange={onPresenceChange}>
              <WorkStatusGitGraphSection {...nextProps} />
            </WorkStatusPresenceProvider>
          </I18nProvider>
        </RuntimeAPIContext.Provider>,
      );
      await flush();
    });
  };

  await renderWithProps(props);

  return {
    container: dom.container,
    rerender: renderWithProps,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await flush();
      });
      dom.restore();
    },
  };
};

describe('WorkStatusGitGraphSection', () => {
  beforeEach(() => {
    historyRowCalls.length = 0;
    copiedHashes.length = 0;
    toastMessages.success.length = 0;
    toastMessages.error.length = 0;
    useUIStore.setState({
      contextPanelByDirectory: {},
      contextRailOrder: [],
      gitRepositoryPaneStates: {},
      workStatusExpandedSections: {},
      workStatusHiddenSections: [],
    });
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('renders a collapsed git-graph section boundary without starting graph requests', async () => {
    const calls = { refs: 0, history: 0, remotes: 0 };
    const runtimeApis = createRuntimeApis({
      getGitHistoryRefs: async () => {
        calls.refs += 1;
        return createHistoryRefs();
      },
      getGitHistory: async () => {
        calls.history += 1;
        return createHistoryPage();
      },
      getRemotes: async () => {
        calls.remotes += 1;
        return [];
      },
    });

    const rendered = await renderSection({ directory: '/repo', panelVisible: true }, runtimeApis);

    const boundary = findElement(rendered.container, (element) => element.attributes['data-work-status-git-graph'] === 'true');
    expect(boundary).not.toBeNull();
    expect(findElement(rendered.container, (element) => element.id === 'git-graph-panel')).toBeNull();
    expect(calls).toEqual({ refs: 0, history: 0, remotes: 0 });

    await rendered.unmount();
  });

  test('starts graph and remote requests only after expansion, then wires rows as read-only graph consumers', async () => {
    const calls = { refs: 0, history: 0, remotes: 0 };
    const remotes: GitRemote[] = [
      { name: 'upstream', fetchUrl: 'https://github.com/openchamber/upstream.git', pushUrl: '' },
      { name: 'origin', fetchUrl: 'https://github.com/openchamber/origin.git', pushUrl: '' },
    ];
    const runtimeApis = createRuntimeApis({
      getGitHistoryRefs: async () => {
        calls.refs += 1;
        return createHistoryRefs();
      },
      getGitHistory: async () => {
        calls.history += 1;
        return createHistoryPage();
      },
      getRemotes: async () => {
        calls.remotes += 1;
        return remotes;
      },
    });

    const rendered = await renderSection({ directory: '/repo', panelVisible: true }, runtimeApis);
    expect(calls).toEqual({ refs: 0, history: 0, remotes: 0 });

    await act(async () => {
      useUIStore.getState().setWorkStatusSectionExpanded('gitGraph', true);
      await flush();
    });

    expect(calls.remotes).toBe(1);
    expect(calls.refs).toBeGreaterThan(0);
    expect(calls.history).toBeGreaterThan(0);
    expect(historyRowCalls[0]).toEqual({
      id: 'a'.repeat(40),
      showGraphActions: false,
      onCopyHash: historyRowCalls[0]?.onCopyHash,
      commitComparison: {
        directory: '/repo',
        commitHash: 'a'.repeat(40),
        parentHash: 'b'.repeat(40),
      },
      commitDetailsController: historyRowCalls[0]?.commitDetailsController,
      hoverRemoteName: 'origin',
      hoverRemoteUrl: 'https://github.com/openchamber/origin.git',
      hoverDetailsCache: null,
    });

    await rendered.unmount();
  });

  test('hands a selected historical file to the context panel and preserves copy-hash feedback', async () => {
    const runtimeApis = createRuntimeApis();

    const rendered = await renderSection({ directory: '/repo', panelVisible: true }, runtimeApis);

    await act(async () => {
      useUIStore.getState().setWorkStatusSectionExpanded('gitGraph', true);
      await flush();
    });

    const row = historyRowCalls[0];
    const selectedFile: GitCommitChangedFile = {
      path: 'src/history.ts',
      originalPath: 'src/history-before.ts',
      status: 'R',
      kind: 'file',
      originalObjectId: '1'.repeat(40),
      objectId: '2'.repeat(40),
      insertions: 7,
      deletions: 3,
      isBinary: false,
    };

    row?.commitDetailsController?.selectFile(
      row.commitComparison ?? { directory: '/repo', commitHash: 'a'.repeat(40), parentHash: 'b'.repeat(40) },
      selectedFile,
    );
    row?.onCopyHash('a'.repeat(40));
    await flush();

    const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
    expect(panel?.activeTabId).toBe('diff');
    expect(panel?.tabs).toHaveLength(1);
    expect(panel?.tabs[0]?.commitDiffTarget).toEqual({
      commitHash: 'a'.repeat(40),
      parentHash: 'b'.repeat(40),
      file: selectedFile,
    });
    expect(copiedHashes).toEqual(['a'.repeat(40)]);
    expect(toastMessages.success).toEqual(['Commit hash copied']);
    expect(toastMessages.error).toEqual([]);

    await rendered.unmount();
  });

  test('renders nothing without a directory and stays inactive when the panel is hidden', async () => {
    const calls = { refs: 0, history: 0, remotes: 0 };
    const presence = collectPresenceCounts();
    const runtimeApis = createRuntimeApis({
      getGitHistoryRefs: async () => {
        calls.refs += 1;
        return createHistoryRefs();
      },
      getGitHistory: async () => {
        calls.history += 1;
        return createHistoryPage();
      },
      getRemotes: async () => {
        calls.remotes += 1;
        return [];
      },
    });

    const missingDirectory = await renderSection({ directory: null, panelVisible: true }, runtimeApis, presence.onChange);
    expect(findElement(missingDirectory.container, (element) => element.attributes['data-work-status-git-graph'] === 'true')).toBeNull();
    expect(presence.counts).toEqual([]);
    await missingDirectory.unmount();

    const hiddenPanel = await renderSection({ directory: '/repo', panelVisible: false }, runtimeApis);
    await act(async () => {
      useUIStore.getState().setWorkStatusSectionExpanded('gitGraph', true);
      await flush();
    });
    expect(calls).toEqual({ refs: 0, history: 0, remotes: 0 });
    await hiddenPanel.unmount();
  });

  test('disposes the old directory controller when the mounted expanded section switches directories', async () => {
    useUIStore.getState().setWorkStatusSectionExpanded('gitGraph', true);

    const refsByDirectory = new Map<string, number>();
    const historyByDirectory = new Map<string, number>();
    const remotesByDirectory = new Map<string, number>();
    const increment = (map: Map<string, number>, directory: string) => {
      map.set(directory, (map.get(directory) ?? 0) + 1);
    };

    const runtimeApis = createRuntimeApis({
      getGitHistoryRefs: async (directory) => {
        increment(refsByDirectory, directory);
        return createHistoryRefs();
      },
      getGitHistory: async (directory) => {
        increment(historyByDirectory, directory);
        return createHistoryPage();
      },
      getRemotes: async (directory) => {
        increment(remotesByDirectory, directory);
        return [];
      },
    });

    const rendered = await renderSection({ directory: '/repo-a', panelVisible: true }, runtimeApis);
    const oldRow = historyRowCalls.at(-1);

    expect(refsByDirectory.get('/repo-a')).toBeGreaterThan(0);
    expect(historyByDirectory.get('/repo-a')).toBeGreaterThan(0);
    expect(remotesByDirectory.get('/repo-a')).toBe(1);

    await rendered.rerender({ directory: '/repo-b', panelVisible: true });

    expect(refsByDirectory.get('/repo-b')).toBeGreaterThan(0);
    expect(historyByDirectory.get('/repo-b')).toBeGreaterThan(0);
    expect(remotesByDirectory.get('/repo-b')).toBe(1);

    const repoARefsBeforeOldSelect = refsByDirectory.get('/repo-a') ?? 0;
    const repoAHistoryBeforeOldSelect = historyByDirectory.get('/repo-a') ?? 0;

    oldRow?.commitDetailsController?.selectFile(
      oldRow.commitComparison ?? { directory: '/repo-a', commitHash: 'a'.repeat(40), parentHash: 'b'.repeat(40) },
      {
        path: 'src/old-history.ts',
        status: 'M',
        kind: 'file',
        insertions: 1,
        deletions: 1,
        isBinary: false,
      },
    );
    await flush();

    expect(refsByDirectory.get('/repo-a')).toBe(repoARefsBeforeOldSelect);
    expect(historyByDirectory.get('/repo-a')).toBe(repoAHistoryBeforeOldSelect);

    await rendered.unmount();
  });
});
