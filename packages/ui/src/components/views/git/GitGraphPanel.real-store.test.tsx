import React, { act } from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import type { GitHistoryItem, GitHistoryPage, GitHistoryRefsResponse } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  useGitHistoryRefsState,
  useGitStore,
} from '@/stores/useGitStore';

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchHistoryPage']>[1];
type ReactContainer = Parameters<typeof createRoot>[0];

const createHistoryRefs = (): GitHistoryRefsResponse => ({
  refs: [
    { id: 'HEAD', name: 'HEAD', revision: 'head-sha', kind: 'head', category: 'branches' },
    { id: 'refs/heads/main', name: 'main', revision: 'head-sha', kind: 'local', category: 'branches' },
    { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'upstream-sha', kind: 'remote', category: 'remote-branches' },
  ],
  current: { id: 'refs/heads/main', name: 'main', revision: 'head-sha', kind: 'local', category: 'branches' },
  upstream: { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'upstream-sha', kind: 'remote', category: 'remote-branches' },
  base: null,
  snapshot: 'snapshot-a',
});

const createHistoryItem = (id: string): GitHistoryItem => ({
  id,
  parentIds: [],
  subject: id,
  message: id,
  author: 'Author',
  authorEmail: 'author@example.com',
  timestamp: '2026-01-01T00:00:00.000Z',
  statistics: { files: 1, insertions: 1, deletions: 0 },
  references: [],
});

const createHistoryPage = (items: string[]): GitHistoryPage => ({
  items: items.map(createHistoryItem),
  nextCursor: null,
  hasMore: false,
  refsSnapshot: 'snapshot-a',
});

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

  // SAFETY: This stub is fully populated before any consumer can observe it.
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

  const container: unknown = makeElement('div', documentStub);
  // SAFETY: React only touches the DOM container fields provided by this stub.
  const reactContainer = container as ReactContainer;
  return { container: reactContainer, restore };
};

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const GraphStoreProbe = ({ directory, git }: { directory: string; git: GitAPI }) => {
  const ensureHistoryRefs = useGitStore((state) => state.ensureHistoryRefs);
  const fetchHistoryPage = useGitStore((state) => state.fetchHistoryPage);
  const { refs, refsError, isLoadingRefs } = useGitHistoryRefsState(directory);

  React.useEffect(() => {
    if (refs || refsError || isLoadingRefs) {
      return;
    }
    void ensureHistoryRefs(directory, git);
    void fetchHistoryPage(directory, git, { mode: 'auto' });
  }, [directory, ensureHistoryRefs, fetchHistoryPage, git, isLoadingRefs, refs, refsError]);

  return React.createElement('div', {
    'data-loading-refs': String(isLoadingRefs),
    'data-ref-count': String(refs?.refs.length ?? 0),
    'data-ref-error': refsError ?? '',
  });
};

describe('GitGraphPanel real store regression', () => {
  beforeEach(() => {
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('graph store subscriptions settle without external store loop errors', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const consoleMessages: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      consoleMessages.push(args.map((value) => String(value)).join(' '));
    };

    const requestCounts = { refs: 0, history: 0 };
    const git: GitAPI = {
      checkIsGitRepository: async () => true,
      getGitStatus: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true }),
      getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
      getGitLog: async () => ({ all: [], latest: null, total: 0 }),
      getCurrentGitIdentity: async () => null,
      getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
      getGitHistoryRefs: async () => {
        requestCounts.refs += 1;
        return createHistoryRefs();
      },
      getGitHistory: async () => {
        requestCounts.history += 1;
        return createHistoryPage(['commit-a']);
      },
    };

    await act(async () => {
      root.render(React.createElement(GraphStoreProbe, { directory: '/repo', git }));
      await flushEffects();
    });

    await act(async () => {
      await flushEffects();
    });

    console.error = originalConsoleError;

    expect(requestCounts).toEqual({ refs: 1, history: 1 });
    expect(useGitStore.getState().getDirectoryState('/repo')?.history.refs?.snapshot).toBe('snapshot-a');
    expect(/getSnapshot should be cached|Maximum update depth exceeded/i.test(consoleMessages.join('\n'))).toBe(false);

    // Appending a second page must reuse cached refs without calling getGitHistoryRefs again
    await act(async () => {
      await useGitStore.getState().fetchHistoryPage('/repo', git, { mode: 'auto' }, { append: true });
      await flushEffects();
    });

    expect(requestCounts).toEqual({ refs: 1, history: 2 });
    expect(/getSnapshot should be cached|Maximum update depth exceeded/i.test(consoleMessages.join('\n'))).toBe(false);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    dom.restore();
  });
});
