import React, { act } from 'react';
import { describe, expect, mock, test, beforeEach } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import type { GitCommitChangedFile } from '@/lib/api/types';
import type { GitCommitComparison } from './HistoryCommitRow';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  },
});

type TestPressEvent = {
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

type TextStub = {
  nodeType: 3;
  nodeValue: string;
  ownerDocument: DocumentStub;
  parentNode: ElementStub | null;
};

type ElementStub = {
  nodeType: 1;
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
  value?: string;
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

type DocumentStub = {
  nodeType: 9;
  defaultView: typeof globalThis;
  activeElement: ElementStub | null;
  body: ElementStub | null;
  documentElement: ElementStub | null;
  createElement(tag: string): ElementStub;
  createElementNS(ns: string, tag: string): ElementStub;
  createTextNode(text: string): TextStub;
  addEventListener(): void;
  removeEventListener(): void;
};

type ReactContainerLike = ElementStub;

type MockButtonProps = React.PropsWithChildren<{
  type?: 'button' | 'submit' | 'reset';
  className?: string;
  title?: string;
  'aria-label'?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  onClick?: (event: TestPressEvent) => void;
  'data-git-commit-changed-file-row'?: string;
}>;

type MockInputProps = {
  value?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => void;
};

type MockMenuItemProps = React.PropsWithChildren<{
  disabled?: boolean;
  className?: string;
  onClick?: (event: TestPressEvent) => void;
}>;

const textFromNode = (node: React.ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => textFromNode(child)).join('');
  if (!node || typeof node !== 'object' || !('props' in node)) return '';
  return textFromNode((node as { props?: { children?: React.ReactNode } }).props?.children ?? null);
};

const buttonRegistry: Array<MockButtonProps & { text: string }> = [];
const inputRegistry: MockInputProps[] = [];
const menuItemRegistry: Array<MockMenuItemProps & { text: string }> = [];
const toastMessages = { success: [] as string[], error: [] as string[] };
const copiedTexts: string[] = [];
const openedUrls: string[] = [];

const gitApi = {
  checkoutCommit: mock(async () => ({ success: true })),
  createBranch: mock(async (_directory: string, name: string) => ({ success: true, branch: name })),
  createGitTag: mock(async (_directory: string, name: string) => ({ success: true, tag: name })),
  cherryPick: mock(async () => ({ conflict: false as const })),
  revertCommit: mock(async () => ({ conflict: false as const })),
  resetToCommit: mock(async () => ({ success: true })),
  merge: mock(async () => ({ conflict: false as const })),
  rebase: mock(async () => ({ conflict: false as const })),
};

let clipboardResult: { ok: boolean; error?: string } = { ok: true };
let runtimeGitCapabilities: { createGitTag?: (...args: unknown[]) => Promise<unknown> } = {};

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: MockButtonProps) => {
    buttonRegistry.push({ children, ...props, text: textFromNode(children) });
    const domProps: React.HTMLAttributes<HTMLSpanElement> & Record<`data-${string}`, string | undefined> = {
      className: props.className,
      title: props.title,
      'aria-label': props['aria-label'],
      'aria-disabled': props.disabled ? 'true' : undefined,
      style: props.style,
      'data-git-commit-changed-file-row': props['data-git-commit-changed-file-row'],
    };

    return React.createElement('span', domProps, children);
  },
}));

mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  ContextMenuContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ContextMenuSeparator: () => <hr />,
  ContextMenuItem: ({ children, ...props }: MockMenuItemProps) => {
    menuItemRegistry.push({ children, ...props, text: textFromNode(children) });
    return <button type="button" disabled={props.disabled}>{children}</button>;
  },
}));

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) => (open ? <div data-dialog-open>{children}</div> : null),
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: MockInputProps) => {
    inputRegistry.push(props);
    return <input value={props.value} onChange={() => {}} placeholder={props.placeholder} />;
  },
}));

mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => <span data-icon={name} className={className} />,
}));

mock.module('@/components/icons/FileTypeIcon', () => ({
  FileTypeIcon: ({ filePath, className }: { filePath: string; className?: string }) => (
    <span data-file-type-icon={filePath} className={className} />
  ),
}));

mock.module('@/components/views/PierreDiffViewer', () => ({
  PierreDiffViewer: () => <div data-diff-viewer />,
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

mock.module('@/lib/clipboard', () => ({
  copyTextToClipboard: mock(async (text: string) => {
    copiedTexts.push(text);
    return clipboardResult;
  }),
}));

mock.module('@/lib/url', () => ({
  openExternalUrl: mock(async (url: string) => {
    openedUrls.push(url);
    return true;
  }),
}));

mock.module('@/lib/gitApi', () => gitApi);

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ git: runtimeGitCapabilities }),
}));

mock.module('./GitCommitHoverPopover', () => ({
  GitCommitHoverPopover: Object.assign(
    ({ rowButton }: { rowButton: React.ReactElement }) => rowButton,
    {
      createCoordinator: () => ({
        claim() {},
        release() {},
      }),
    },
  ),
}));

const { HistoryCommitRow } = await import('./HistoryCommitRow');

const createPressEvent = (): TestPressEvent => ({
  defaultPrevented: false,
  propagationStopped: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopPropagation() {
    this.propagationStopped = true;
  },
});

const invokeClick = async (handler: ((event: TestPressEvent) => void) | undefined) => {
  if (!handler) return;
  await act(async () => {
    handler(createPressEvent());
    await flush();
  });
};

const createChangedFile = (overrides: Partial<GitCommitChangedFile> & Pick<GitCommitChangedFile, 'path' | 'status'>): GitCommitChangedFile => ({
  path: overrides.path,
  status: overrides.status,
  kind: overrides.kind ?? 'file',
  insertions: overrides.insertions ?? 0,
  deletions: overrides.deletions ?? 0,
  isBinary: overrides.isBinary ?? false,
  originalPath: overrides.originalPath,
  originalObjectId: overrides.originalObjectId,
  objectId: overrides.objectId,
});

const isReactContainerLike = (value: ElementStub | null): value is ReactContainerLike => value !== null;

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

const resetRegistries = () => {
  buttonRegistry.length = 0;
  inputRegistry.length = 0;
  menuItemRegistry.length = 0;
  toastMessages.success.length = 0;
  toastMessages.error.length = 0;
  copiedTexts.length = 0;
  openedUrls.length = 0;
  clipboardResult = { ok: true };
  runtimeGitCapabilities = {};
  Object.values(gitApi).forEach((fn) => {
    if ('mock' in fn) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fn as any).mockClear();
    }
  });
};

const renderInteractive = async (element: React.ReactElement) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.container as unknown as Element);
  await act(async () => {
    root.render(<I18nProvider>{element}</I18nProvider>);
    await flush();
  });
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await flush();
      });
      dom.restore();
    },
  };
};

const getMenuItem = (text: string) => [...menuItemRegistry].reverse().find((item) => item.text === text);
const getButton = (text: string) => [...buttonRegistry].reverse().find((button) => button.text === text);

describe('HistoryCommitRow context menu regression', () => {
  beforeEach(() => {
    resetRegistries();
  });

  test('renders collapsed compact graph rows inline without date hash or copy controls', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ul>
          <HistoryCommitRow
            entry={{
              id: 'abcdef1234567890',
              parentIds: ['fedcba0987654321'],
              subject: 'Compact subject that should truncate when space is limited',
              message: 'Compact subject that should truncate when space is limited',
              author: 'Taylor Developer',
              authorEmail: 'taylor@example.com',
              timestamp: '2024-01-02T03:04:00.000Z',
              statistics: { files: 1, insertions: 2, deletions: 1 },
              references: [],
            }}
            mode="graph"
            compactGraph={true}
            viewModel={{
              historyItem: {
                id: 'abcdef1234567890',
                parentIds: ['fedcba0987654321'],
                subject: 'Compact subject that should truncate when space is limited',
                message: 'Compact subject that should truncate when space is limited',
                author: 'Taylor Developer',
                authorEmail: 'taylor@example.com',
                timestamp: '2024-01-02T03:04:00.000Z',
                statistics: { files: 1, insertions: 2, deletions: 1 },
                references: [
                  { id: 'HEAD', name: 'topic', revision: 'abcdef1234567890', kind: 'head', category: 'branches' },
                  { id: 'refs/heads/topic', name: 'topic', revision: 'abcdef1234567890', kind: 'local', category: 'branches' },
                  { id: 'refs/remotes/origin/topic', name: 'origin/topic', revision: 'abcdef1234567890', kind: 'remote', category: 'remote-branches' },
                  { id: 'refs/tags/v1', name: 'v1', revision: 'abcdef1234567890', kind: 'tag', category: 'tags' },
                ],
              },
              inputSwimlanes: [],
              outputSwimlanes: [{ id: 'fedcba0987654321', color: 'var(--chart-1)' }],
              kind: 'node',
            }}
            totalColumns={1}
            isExpanded={false}
            onToggle={() => {}}
            files={[]}
            isLoadingFiles={false}
            onCopyHash={() => {}}
            directory="/repo"
          />
        </ul>
      </I18nProvider>,
    );

    expect(markup.indexOf('Compact subject that should truncate when space is limited')).toBeLessThan(markup.indexOf('topic'));
    expect(markup.indexOf('topic')).toBeLessThan(markup.indexOf('Taylor Developer'));
    expect(markup).toContain('h-[22px]');
    expect(markup).toContain('whitespace-nowrap');
    expect(markup.match(/>topic<\/span>/g)).toHaveLength(1);
    expect(markup).not.toContain('origin/topic');
    expect(markup).not.toContain('>v1</span>');
    expect(markup).not.toContain('<code');
    expect(markup).not.toContain('2024');
    expect(markup).not.toContain('data-icon="file-copy"');
  });

  test('renders menu actions while the expanded body omits inline action controls and branch inputs by default', () => {
    runtimeGitCapabilities = { createGitTag: async () => ({ success: true, tag: 'v1.2.3' }) };

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ul>
          <HistoryCommitRow
            entry={{
              id: 'abcdef1234567890',
              parentIds: ['fedcba0987654321'],
              subject: 'Menu subject',
              message: 'Menu subject',
              author: 'Taylor Developer',
              authorEmail: 'taylor@example.com',
              timestamp: '2024-01-02T03:04:00.000Z',
              statistics: { files: 0, insertions: 0, deletions: 0 },
              references: [],
            }}
            mode="graph"
            isExpanded={true}
            onToggle={() => {}}
            files={[]}
            isLoadingFiles={false}
            onCopyHash={() => {}}
            directory="/repo"
            hoverRemoteUrl="https://github.com/acme/repo.git"
          />
        </ul>
      </I18nProvider>,
    );

    const visibleLabels = menuItemRegistry.map((item) => item.text);
    expect(visibleLabels).toContain('Open Changes');
    expect(visibleLabels).toContain('Open on GitHub');
    expect(visibleLabels).toContain('Checkout (Detached)');
    expect(visibleLabels).toContain('Create Branch…');
    expect(visibleLabels).toContain('Create Tag…');
    expect(visibleLabels).toContain('Cherry-pick');
    expect(visibleLabels).toContain('Revert');
    expect(visibleLabels).toContain('Reset (Soft)');
    expect(visibleLabels).toContain('Reset (Mixed)');
    expect(visibleLabels).toContain('Reset (Hard)');
    expect(visibleLabels).toContain('Merge into current');
    expect(visibleLabels).toContain('Rebase onto this');
    expect(visibleLabels).toContain('Copy SHA');
    expect(visibleLabels).toContain('Copy Commit Message');
    expect(markup).not.toContain('Branch name');
    expect(markup).not.toContain('>Confirm<');
    expect(markup).not.toContain('>Cancel<');
  });

  test('opens changes and compare actions through explicit callbacks', async () => {
    const toggleCalls: number[] = [];
    const compareRemoteCalls: number[] = [];
    const clearCalls: number[] = [];

    const rendered = await renderInteractive(
      <ul>
        <HistoryCommitRow
          entry={{
            id: 'abcdef1234567890',
            parentIds: ['fedcba0987654321'],
            subject: 'Compare subject',
            message: 'Compare subject',
            author: 'Taylor Developer',
            authorEmail: 'taylor@example.com',
            timestamp: '2024-01-02T03:04:00.000Z',
            statistics: { files: 0, insertions: 0, deletions: 0 },
            references: [],
          }}
          mode="graph"
          isExpanded={false}
          onToggle={() => { toggleCalls.push(1); }}
          files={[]}
          isLoadingFiles={false}
          onCopyHash={() => {}}
          directory="/repo"
          onCompareWithRemote={() => { compareRemoteCalls.push(1); }}
          canCompareWithRemote={true}
        />
      </ul>,
    );

    await invokeClick(getMenuItem('Open Changes')?.onClick);
    await invokeClick(getMenuItem('Compare with Remote')?.onClick);

    expect(toggleCalls).toEqual([1, 1]);
    expect(compareRemoteCalls).toEqual([1]);

    await rendered.unmount();

    resetRegistries();

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ul>
          <HistoryCommitRow
            entry={{
              id: 'abcdef1234567890',
              parentIds: ['fedcba0987654321'],
              subject: 'Compare subject',
              message: 'Compare subject',
              author: 'Taylor Developer',
              authorEmail: 'taylor@example.com',
              timestamp: '2024-01-02T03:04:00.000Z',
              statistics: { files: 0, insertions: 0, deletions: 0 },
              references: [],
            }}
            mode="graph"
            isExpanded={true}
            onToggle={() => {}}
            files={[]}
            isLoadingFiles={false}
            onCopyHash={() => {}}
            directory="/repo"
            activeComparisonLabel="origin/main"
            onClearComparison={() => { clearCalls.push(1); }}
          />
        </ul>
      </I18nProvider>,
    );

    expect(markup).toContain('Comparing with origin/main');
    expect(markup).toContain('Clear comparison');
  });

  test('opens a confirmation dialog for destructive actions and dispatches after confirm', async () => {
    const successCalls: number[] = [];
    const rendered = await renderInteractive(
      <ul>
        <HistoryCommitRow
          entry={{
            id: 'abcdef1234567890',
            parentIds: ['fedcba0987654321'],
            subject: 'Cherry pick me',
            message: 'Cherry pick me',
            author: 'Taylor Developer',
            authorEmail: 'taylor@example.com',
            timestamp: '2024-01-02T03:04:00.000Z',
            statistics: { files: 0, insertions: 0, deletions: 0 },
            references: [],
          }}
          mode="graph"
          isExpanded={false}
          onToggle={() => {}}
          files={[]}
          isLoadingFiles={false}
          onCopyHash={() => {}}
          directory="/repo"
          onActionSuccess={() => { successCalls.push(1); }}
        />
      </ul>,
    );

    await invokeClick(getMenuItem('Cherry-pick')?.onClick);
    await invokeClick(getButton('Confirm')?.onClick);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (expect(gitApi.cherryPick) as any).toHaveBeenCalledWith('/repo', 'abcdef1234567890');
    expect(successCalls).toEqual([1]);

    await rendered.unmount();
  });

  test('keeps the create branch dialog open when branch creation fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gitApi.createBranch as any).mockImplementationOnce(async () => {
      throw new Error('Branch failed');
    });

    const rendered = await renderInteractive(
      <ul>
        <HistoryCommitRow
          entry={{
            id: 'abcdef1234567890',
            parentIds: ['fedcba0987654321'],
            subject: 'Branch me',
            message: 'Branch me',
            author: 'Taylor Developer',
            authorEmail: 'taylor@example.com',
            timestamp: '2024-01-02T03:04:00.000Z',
            statistics: { files: 0, insertions: 0, deletions: 0 },
            references: [],
          }}
          mode="graph"
          isExpanded={false}
          onToggle={() => {}}
          files={[]}
          isLoadingFiles={false}
          onCopyHash={() => {}}
          directory="/repo"
        />
      </ul>,
    );

    await invokeClick(getMenuItem('Create Branch…')?.onClick);
    const branchInput = inputRegistry.find((input) => input.placeholder === 'Branch name');
    expect(branchInput).toBeDefined();
    await act(async () => {
      branchInput?.onChange?.({ target: { value: 'feature/menu' } });
      await flush();
    });
    await invokeClick(getButton('Create')?.onClick);

    expect(toastMessages.error).toEqual(['Branch failed']);
    expect(inputRegistry.some((input) => input.value === 'feature/menu')).toBe(true);

    await rendered.unmount();
  });

  test('hides create tag when unsupported and copies the commit message with existing clipboard toasts', async () => {
    const rendered = await renderInteractive(
      <ul>
        <HistoryCommitRow
          entry={{
            id: 'abcdef1234567890',
            parentIds: ['fedcba0987654321'],
            subject: 'Copy this subject',
            message: 'Copy this subject',
            author: 'Taylor Developer',
            authorEmail: 'taylor@example.com',
            timestamp: '2024-01-02T03:04:00.000Z',
            statistics: { files: 0, insertions: 0, deletions: 0 },
            references: [],
          }}
          mode="graph"
          isExpanded={false}
          onToggle={() => {}}
          files={[]}
          isLoadingFiles={false}
          onCopyHash={() => {}}
          directory="/repo"
        />
      </ul>,
    );

    expect(getMenuItem('Create Tag…')).toBe(undefined);
    await invokeClick(getMenuItem('Copy Commit Message')?.onClick);

    expect(copiedTexts).toEqual(['Copy this subject']);
    expect(toastMessages.success).toEqual(['Commit message copied']);

    await rendered.unmount();
  });

  test('renders controller-backed changed files with aria wiring and isolates nested button presses', () => {
    const toggleCalls: number[] = [];
    const onToggle = mock(() => {
      toggleCalls.push(1);
    });
    const copiedHashes: string[] = [];
    const selectedFiles: Array<{ comparison: GitCommitComparison; file: GitCommitChangedFile }> = [];
    const retriedComparisons: GitCommitComparison[] = [];
    const onCopyHash = mock((hash: string) => {
      copiedHashes.push(hash);
    });
    const selectFile = mock((comparison: GitCommitComparison, file: GitCommitChangedFile) => {
      selectedFiles.push({ comparison, file });
    });
    const retryCommit = mock((comparison: GitCommitComparison) => {
      retriedComparisons.push(comparison);
    });
    const comparison: GitCommitComparison = {
      directory: '/repo',
      commitHash: 'abcdef1234567890',
      parentHash: 'fedcba0987654321',
    };

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <ul>
          <HistoryCommitRow
            entry={{
              hash: 'abcdef1234567890',
              date: '2024-01-02T03:04:00.000Z',
              message: 'Add changed file rows',
              refs: '',
              body: '',
              author_name: 'Taylor Developer',
              author_email: 'taylor@example.com',
              filesChanged: 2,
              insertions: 4,
              deletions: 2,
              parents: ['fedcba0987654321'],
            }}
            isExpanded={true}
            onToggle={onToggle}
            files={[]}
            isLoadingFiles={false}
            onCopyHash={onCopyHash}
            directory="/repo"
            commitComparison={comparison}
            commitDetailsController={{
              getCommitSnapshot: () => ({
                status: 'ready',
                files: [
                  createChangedFile({ path: 'src/new-name.ts', originalPath: 'src/old-name.ts', status: 'R', insertions: 4, deletions: 2 }),
                ],
              }),
              subscribeCommit: () => () => {},
              retryCommit,
              selectFile,
            }}
            selectedChangedFilePath="src/new-name.ts"
          />
        </ul>
      </I18nProvider>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="history-commit-details-abcdef1234567890"');
    expect(markup).toContain('id="history-commit-details-abcdef1234567890"');
    expect(markup).toContain('data-git-commit-changed-files="flat"');
    expect(markup).toContain('data-git-commit-changed-file-row="src/new-name.ts"');
    expect(markup).toContain('data-file-type-icon="src/new-name.ts"');
    expect(markup).toContain('data-git-commit-changed-file-name="src/new-name.ts"');
    expect(markup).toContain('>new-name.ts<');
    expect(markup).toContain('data-git-commit-changed-file-directory="src/new-name.ts"');
    expect(markup).toContain('>src/old-name.ts → src/new-name.ts<');
    expect(markup).toContain('data-git-commit-changed-file-status="src/new-name.ts"');
    expect(markup).toContain('>R<');
    expect(markup).not.toContain('data-git-commit-changed-directory-row=');
    expect(markup).not.toContain('>Binary<');
    expect(markup).not.toContain('>+4<');
    expect(markup).not.toContain('>-2<');
    expect(markup).not.toContain('data-diff-viewer');

    const fileRowButton = buttonRegistry.find((props) => props['data-git-commit-changed-file-row'] === 'src/new-name.ts');
    expect(fileRowButton).toBeDefined();
    const fileEvent = createPressEvent();
    fileRowButton?.onClick?.(fileEvent);
    expect(fileEvent.defaultPrevented).toBe(true);
    expect(fileEvent.propagationStopped).toBe(true);
    expect(selectedFiles).toEqual([
      {
        comparison,
        file: createChangedFile({ path: 'src/new-name.ts', originalPath: 'src/old-name.ts', status: 'R', insertions: 4, deletions: 2 }),
      },
    ]);
    expect(retriedComparisons).toEqual([]);

    const copyButton = buttonRegistry.find((props) => props['aria-label'] === 'Copy SHA');
    expect(copyButton).toBeDefined();
    const copyEvent = createPressEvent();
    copyButton?.onClick?.(copyEvent);
    expect(copyEvent.propagationStopped).toBe(true);
    expect(copiedHashes).toEqual(['abcdef1234567890']);
    expect(toggleCalls).toEqual([]);
  });
});
