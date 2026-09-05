import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import type { GitStatus } from '@/lib/api/types';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement> & {
  'data-diff-view-toggle'?: string;
}>;
type PierreDiffViewerProps = {
  fileName?: string;
  original?: string;
  modified?: string;
  renderSideBySide?: boolean;
  wrapLines?: boolean;
  layout?: string;
};

type UIStoreState = {
  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  diffFileLayout: Record<string, 'inline' | 'side-by-side'>;
  diffWrapLines: boolean;
  pendingDiffFile: string | null;
  pendingDiffStaged: boolean;
  pendingDiffScope: 'working' | 'staged' | 'turn' | 'branch' | null;
};

type NodeStub = ElementStub | TextStub;

type TextStub = {
  nodeType: number;
  nodeValue: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
};

type ElementStub = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  id: string;
  attributes: Record<string, string>;
  namespaceURI: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
  childNodes: NodeStub[];
  style: Record<string, string>;
  textContent: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(child: NodeStub): NodeStub;
  insertBefore(child: NodeStub, ref: NodeStub | null): NodeStub;
  removeChild(child: NodeStub): NodeStub;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
  scrollTo(options: { top: number }): void;
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number };
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

type RenderedButton = {
  props: MockButtonProps;
};

type MockUIStore = UIStoreState & {
  setDiffFileLayout: typeof setDiffFileLayout;
  setDiffWrapLines: typeof setDiffWrapLines;
  openContextSurface: () => void;
  setPendingDiffFile: () => void;
  openContextFileAtLine: () => void;
};

type MockGitDirectoryState = {
  branches: null;
  isLoadingBranches: false;
  diffCache: Map<string, never>;
};

const pierreCalls: PierreDiffViewerProps[] = [];
const renderedButtons: RenderedButton[] = [];
const uiStoreListeners = new Set<() => void>();
let uiStoreState: UIStoreState;
let gitStatusState: GitStatus | null = null;
let isGitRepoState = false;
let isGitLoadingStatusState = false;
let gitDirectoriesState = new Map<string, MockGitDirectoryState>();
const noop = () => {};
const mockUIStore: MockUIStore = {
  diffLayoutPreference: 'dynamic',
  diffFileLayout: {},
  diffWrapLines: false,
  pendingDiffFile: null,
  pendingDiffStaged: false,
  pendingDiffScope: null,
  setDiffFileLayout: noop,
  setDiffWrapLines: noop,
  openContextSurface: noop,
  setPendingDiffFile: noop,
  openContextFileAtLine: noop,
};

const emitUIStoreChange = () => {
  for (const listener of uiStoreListeners) {
    listener();
  }
};

const setDiffFileLayout = (path: string, layout: 'inline' | 'side-by-side') => {
  uiStoreState = {
    ...uiStoreState,
    diffFileLayout: {
      ...uiStoreState.diffFileLayout,
      [path]: layout,
    },
  };
  mockUIStore.diffFileLayout = uiStoreState.diffFileLayout;
  emitUIStoreChange();
};

const setDiffWrapLines = (value: boolean) => {
  uiStoreState = {
    ...uiStoreState,
    diffWrapLines: value,
  };
  mockUIStore.diffWrapLines = uiStoreState.diffWrapLines;
  emitUIStoreChange();
};

mockUIStore.setDiffFileLayout = setDiffFileLayout;
mockUIStore.setDiffWrapLines = setDiffWrapLines;

mock.module('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, MockButtonProps>(({ children, ...props }, ref) => {
    renderedButtons.push({ props: { ...props, children } });
    return React.createElement('button', { ...props, ref }, children);
  }),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));

mock.module('@/components/icons/FileTypeIcon', () => ({
  FileTypeIcon: ({ filePath, className }: { filePath: string; className?: string }) => React.createElement('span', { 'data-file-type-icon': filePath, className }),
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DropdownMenuRadioGroup: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DropdownMenuRadioItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => React.createElement('div', { 'data-value': value }, children),
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef<HTMLElement, React.PropsWithChildren<React.HTMLAttributes<HTMLElement> & {
    outerClassName?: string;
    disableHorizontal?: boolean;
    observeMutations?: boolean;
    preventOverscroll?: boolean;
  }>>((overlayProps, ref) => {
    const sanitizedProps = {
      ...overlayProps,
      className: [overlayProps.outerClassName, overlayProps.className].filter(Boolean).join(' ') || undefined,
    };
    delete sanitizedProps.outerClassName;
    delete sanitizedProps.disableHorizontal;
    delete sanitizedProps.observeMutations;
    delete sanitizedProps.preventOverscroll;
    return React.createElement('div', { ...sanitizedProps, ref }, overlayProps.children);
  }),
}));

mock.module('@/components/ui', () => ({
  toast: {
    error: () => undefined,
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: UIStoreState & {
    setDiffFileLayout: typeof setDiffFileLayout;
    setDiffWrapLines: typeof setDiffWrapLines;
    openContextSurface: () => void;
    setPendingDiffFile: () => void;
    openContextFileAtLine: () => void;
  }) => T) => React.useSyncExternalStore(
    (listener) => {
      uiStoreListeners.add(listener);
      return () => uiStoreListeners.delete(listener);
    },
    () => selector(mockUIStore),
  ),
}));

mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => '/repo',
}));

mock.module('@/hooks/useNestedGitDirectory', () => ({
  useNestedGitDirectory: () => ({
    rootIsGitRepo: true,
    gitDirectory: '/repo',
    nestedRepos: null,
    nestedRepoSelection: null,
  }),
}));

mock.module('@/stores/useGitStore', () => ({
  useGitStore: <T,>(selector: (state: {
    setActiveDirectory: () => void;
    ensureStatus: () => Promise<void>;
    fetchStatus: () => Promise<void>;
    fetchBranches: () => Promise<void>;
    clearDiffCache: () => void;
    setDiff: () => void;
    directories: Map<string, MockGitDirectoryState>;
  }) => T) => selector({
    setActiveDirectory: () => undefined,
    ensureStatus: async () => undefined,
    fetchStatus: async () => undefined,
    fetchBranches: async () => undefined,
    clearDiffCache: () => undefined,
    setDiff: () => undefined,
    directories: gitDirectoriesState,
  }),
  useGitStatus: () => gitStatusState,
  useIsGitRepo: () => isGitRepoState,
  useGitLoadingStatus: () => isGitLoadingStatusState,
}));

mock.module('@/stores/useGitBaseBranchStore', () => ({
  gitBaseBranchEntryKey: () => 'base-key',
  useGitBaseBranchStore: <T,>(selector: (state: { overrides: Record<string, string>; setOverride: () => void }) => T) => selector({
    overrides: {},
    setOverride: () => undefined,
  }),
}));

mock.module('@/lib/gitApi', () => ({
  getBranchBase: async () => ({ base: null }),
  getGitRangeDiff: async () => ({ diff: '' }),
  getGitRangeFiles: async () => [],
}));

mock.module('@/lib/toolHelpers', () => ({
  getLanguageFromExtension: () => 'typescript',
  isImageFile: () => false,
}));

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    git: {
      getGitDiff: async () => ({ diff: '' }),
      getGitFileDiff: async () => ({ original: '', modified: '', isBinary: false }),
      stageGitFile: async () => undefined,
      unstageGitFile: async () => undefined,
      revertGitFile: async () => undefined,
    },
    files: {},
  }),
}));

mock.module('@/components/session/ReviewFlowDialog', () => ({
  ReviewFlowDialog: () => null,
}));

mock.module('./PierreDiffViewer', () => ({
  PierreDiffViewer: (props: PierreDiffViewerProps) => {
    pierreCalls.push(props);
    return React.createElement('div', {
      'data-diff-viewer': 'true',
      'data-render-side-by-side': String(props.renderSideBySide ?? ''),
      'data-wrap-lines': String(props.wrapLines ?? ''),
      'data-original': String(props.original ?? ''),
      'data-modified': String(props.modified ?? ''),
      'data-layout': String(props.layout ?? ''),
    });
  },
}));

mock.module('@/lib/device', () => ({
  useDeviceInfo: () => ({
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    deviceType: 'desktop',
    screenWidth: 1280,
    breakpoint: 'lg',
    hasTouchInput: false,
    hasTouchOnlyPointer: false,
  }),
}));

mock.module('@/lib/contextFileOpenGuard', () => ({
  getContextFileOpenFailureMessage: () => 'failed',
  validateContextFileOpen: async () => ({ ok: true }),
}));

mock.module('@/lib/path-utils', () => ({
  toAbsoluteFilePath: (directory: string, filePath: string) => `${directory}/${filePath}`,
}));

mock.module('@/lib/sessionEvents', () => ({
  sessionEvents: {
    onGitRefreshHint: () => () => undefined,
  },
}));

mock.module('./diffScrollAnchor', () => ({
  findDiffScrollAnchor: () => null,
  getRestoredDiffScrollTop: (current: number) => current,
}));

mock.module('@/lib/desktop', () => ({
  isDesktopShell: () => false,
  isVSCodeRuntime: () => false,
}));

mock.module('@/lib/reviewFlow', () => ({
  startReviewFlow: async () => undefined,
}));

mock.module('@/components/views/walkthrough/walkthroughAction', () => ({
  WALKTHROUGH_ACTION_CLASS: 'walkthrough-action',
}));

mock.module('@/stores/useWalkthroughStore', () => ({
  useWalkthroughStore: <T,>(selector: (state: { requestSource: () => void }) => T) => selector({ requestSource: () => undefined }),
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: { currentSessionId: string | null; getDirectoryForSession: () => string | null }) => T) => selector({
    currentSessionId: null,
    getDirectoryForSession: () => null,
  }),
}));

mock.module('@/sync/sync-context', () => ({
  useSessionMessages: () => [],
}));

const { DiffView } = await import('./DiffView');
type DiffViewSnapshotSource = React.ComponentProps<typeof DiffView>['snapshotSource'];

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
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 600,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
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
        child.parentNode = null;
      }
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
    focus() {
      owner.activeElement = this;
    },
    scrollTo({ top }) {
      this.scrollTop = top;
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 200, left: 0, right: 400, width: 400, height: 200 };
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

  const container = makeElement('div', documentStub);
  documentStub.body = container;
  documentStub.documentElement = container;

  class ElementClass {}

  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementClass);
  setGlobal('HTMLElement', ElementClass);
  setGlobal('HTMLButtonElement', ElementClass);
  setGlobal('HTMLIFrameElement', ElementClass);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));

  return {
    // SAFETY: The minimal DOM stub implements the Element shape React reads from the mount container in this test harness.
    reactContainer: container as Element & ElementStub,
    container,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
};

const isElementNode = (node: NodeStub | null): node is ElementStub => node !== null && node.nodeType === 1;

const findByAttribute = (node: NodeStub | null, attribute: string, value?: string): ElementStub | null => {
  if (!isElementNode(node)) {
    return null;
  }

  if ((attribute in node.attributes) && (value === undefined || node.attributes[attribute] === value)) {
    return node;
  }

  for (const child of node.childNodes) {
    const match = findByAttribute(child, attribute, value);
    if (match) {
      return match;
    }
  }

  return null;
};

const countByAttribute = (node: NodeStub | null, attribute: string, value?: string): number => {
  if (!isElementNode(node)) {
    return 0;
  }

  const ownCount = (attribute in node.attributes) && (value === undefined || node.attributes[attribute] === value) ? 1 : 0;
  return ownCount + node.childNodes.reduce((count, child) => count + countByAttribute(child, attribute, value), 0);
};

const findByClass = (node: NodeStub | null, className: string): ElementStub | null => {
  if (!isElementNode(node)) {
    return null;
  }

  const classes = (node.attributes.class ?? '').split(/\s+/).filter(Boolean);
  if (classes.includes(className)) {
    return node;
  }

  for (const child of node.childNodes) {
    const match = findByClass(child, className);
    if (match) {
      return match;
    }
  }

  return null;
};

const findByLabel = (node: NodeStub | null, matcher: RegExp): ElementStub | null => {
  if (!isElementNode(node)) {
    return null;
  }

  const label = node.attributes['aria-label'] ?? node.attributes.title ?? '';
  if (matcher.test(label)) {
    return node;
  }

  for (const child of node.childNodes) {
    const match = findByLabel(child, matcher);
    if (match) {
      return match;
    }
  }

  return null;
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

const getLatestButton = (predicate: (entry: RenderedButton) => boolean): RenderedButton => {
  for (let index = renderedButtons.length - 1; index >= 0; index -= 1) {
    const entry = renderedButtons[index];
    if (predicate(entry)) {
      return entry;
    }
  }
  throw new Error('Expected matching button');
};

const clickButton = async (entry: RenderedButton) => {
  await act(async () => {
    // SAFETY: DiffView button handlers in this test only call stopPropagation on the event object.
    entry.props.onClick?.({ stopPropagation() {} } as React.MouseEvent<HTMLButtonElement>);
    await flush();
  });
};

const renderDiffView = async (props: Partial<React.ComponentProps<typeof DiffView>> = {}) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.reactContainer);

  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(DiffView, props)));
    await flush();
  });

  return {
    container: dom.container,
    restore: async () => {
      await act(async () => {
        root.unmount();
      });
      dom.restore();
    },
  };
};

const snapshotSource: DiffViewSnapshotSource = {
  directory: '/repo',
  files: [
    {
      path: 'src/example.ts',
      status: 'M',
      insertions: 2,
      deletions: 1,
      original: 'const value = 1;\n',
      modified: 'const value = 2;\n',
    },
  ],
};

const createGitStatus = (files: GitStatus['files'], diffStats: NonNullable<GitStatus['diffStats']>): GitStatus => ({
  current: 'feature/one-file-diff-tabs',
  tracking: 'origin/feature/one-file-diff-tabs',
  ahead: 0,
  behind: 0,
  files,
  isClean: files.length === 0,
  diffStats,
});

describe('DiffView snapshot source', () => {
  beforeEach(() => {
    pierreCalls.length = 0;
    renderedButtons.length = 0;
    uiStoreListeners.clear();
    uiStoreState = {
      diffLayoutPreference: 'dynamic',
      diffFileLayout: {},
      diffWrapLines: false,
      pendingDiffFile: null,
      pendingDiffStaged: false,
      pendingDiffScope: null,
    };
    mockUIStore.diffLayoutPreference = uiStoreState.diffLayoutPreference;
    mockUIStore.diffFileLayout = uiStoreState.diffFileLayout;
    mockUIStore.diffWrapLines = uiStoreState.diffWrapLines;
    mockUIStore.pendingDiffFile = uiStoreState.pendingDiffFile;
    mockUIStore.pendingDiffStaged = uiStoreState.pendingDiffStaged;
    mockUIStore.pendingDiffScope = uiStoreState.pendingDiffScope;
    gitStatusState = null;
    isGitRepoState = false;
    isGitLoadingStatusState = false;
    gitDirectoriesState = new Map();
  });

  test('renders snapshot files through the standard read-only viewport', async () => {
    const rendered = await renderDiffView({ snapshotSource });

    expect(findByAttribute(rendered.container, 'data-diff-snapshot-mode', 'true')).not.toBeNull();
    expect(findByClass(rendered.container, 'diff-toolbar__expand-button')).not.toBeNull();
    expect(countByAttribute(rendered.container, 'data-diff-view-toggle', 'true')).toBe(1);
    expect(findByLabel(rendered.container, /line wrap/i)).not.toBeNull();
    expect(findByClass(rendered.container, 'diff-toolbar__review-button')).toBeNull();
    expect(findByClass(rendered.container, 'diff-toolbar__walkthrough-button')).toBeNull();
    expect(findByLabel(rendered.container, /full files/i)).toBeNull();
    expect(pierreCalls.at(-1)?.original).toBe('const value = 1;\n');
    expect(pierreCalls.at(-1)?.modified).toBe('const value = 2;\n');

    await rendered.restore();
  });

  test('updates viewer layout and line wrapping from snapshot viewport controls', async () => {
    const rendered = await renderDiffView({ snapshotSource });

    expect(pierreCalls.at(-1)?.wrapLines).toBe(false);
    expect(pierreCalls.at(-1)?.renderSideBySide).toBe(true);

    await clickButton(getLatestButton((entry) => /line wrap/i.test(String(entry.props.title ?? entry.props['aria-label'] ?? ''))));
    expect(pierreCalls.at(-1)?.wrapLines).toBe(true);
    expect(pierreCalls.at(-1)?.renderSideBySide).toBe(true);

    await clickButton(getLatestButton((entry) => entry.props['data-diff-view-toggle'] === 'true'));
    expect(pierreCalls.at(-1)?.wrapLines).toBe(true);
    expect(pierreCalls.at(-1)?.renderSideBySide).toBe(false);

    await rendered.restore();
  });

  test('keeps snapshot file entries read-only even when editor actions are requested', async () => {
    const rendered = await renderDiffView({ snapshotSource, showOpenInEditorAction: true });

    expect(findByAttribute(rendered.container, 'data-icon', 'add')).toBeNull();
    expect(findByAttribute(rendered.container, 'data-icon', 'arrow-go-back')).toBeNull();
    expect(findByAttribute(rendered.container, 'data-icon', 'edit')).toBeNull();

    await rendered.restore();
  });

  test('renders only the requested working-tree file when single-file mode targets one changed path', async () => {
    gitStatusState = createGitStatus(
      [
        { path: 'src/target.ts', index: '', working_dir: 'M' },
        { path: 'src/other.ts', index: '', working_dir: 'M' },
      ],
      {
        'src/target.ts': { insertions: 2, deletions: 1 },
        'src/other.ts': { insertions: 4, deletions: 3 },
      },
    );
    isGitRepoState = true;

    const rendered = await renderDiffView({
      diffScope: 'working',
      singleFilePath: 'src/target.ts',
    });
    await act(async () => {
      await flush();
    });

    try {
      expect(countByAttribute(rendered.container, 'data-diff-file-path')).toBe(1);
      expect(findByAttribute(rendered.container, 'data-diff-file-path')?.attributes['data-diff-file-path']).toBe('src/target.ts');
    } finally {
      await rendered.restore();
    }
  });

  test('shows the single-file missing-target state instead of the clean-tree empty state', async () => {
    gitStatusState = createGitStatus(
      [
        { path: 'src/other.ts', index: '', working_dir: 'M' },
      ],
      {
        'src/other.ts': { insertions: 4, deletions: 3 },
      },
    );
    isGitRepoState = true;

    const rendered = await renderDiffView({
      diffScope: 'working',
      singleFilePath: 'src/target.ts',
    });
    await act(async () => {
      await flush();
    });

    try {
      expect(countByAttribute(rendered.container, 'data-diff-file-path')).toBe(0);
      expect(countByAttribute(rendered.container, 'data-diff-empty-state', 'single-file')).toBe(1);
    } finally {
      await rendered.restore();
    }
  });
});
