import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiffViewSnapshotSource } from '@/components/views/DiffView';
import { I18nProvider } from '@/lib/i18n';
import type { GitCommitChangedFile } from '@/lib/api/types';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;
type MockDiffViewProps = {
  snapshotSource?: DiffViewSnapshotSource;
  hideStackedFileSidebar?: boolean;
  showOpenInEditorAction?: boolean;
  flushContent?: boolean;
};

const diffViewCalls: MockDiffViewProps[] = [];

mock.module('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, MockButtonProps>(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children)),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));

mock.module('@/components/views/DiffView', () => ({
  DiffView: (props: MockDiffViewProps) => {
    diffViewCalls.push(props);
    return React.createElement('div', {
      'data-standard-diff-view': 'true',
      'data-diff-view-toggle': 'true',
    });
  },
}));

const {
  GitCommitDiffPreview,
} = await import('./GitCommitDiffPreview');

type PreviewProps = React.ComponentProps<typeof GitCommitDiffPreview>;
type PreviewController = PreviewProps['controller'];
type PreviewSnapshot = ReturnType<PreviewController['getPreviewSnapshot']>;

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
  value?: string;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild(child: NodeStub): NodeStub;
  insertBefore(child: NodeStub, ref: NodeStub | null): NodeStub;
  removeChild(child: NodeStub): NodeStub;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
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
    // SAFETY: React only reads the DOM-like fields provided by this test container stub.
    reactContainer: container as Element & ElementStub,
    stubContainer: container,
    documentStub,
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

const findByAttribute = (node: NodeStub | null, attribute: string, value?: string): ElementStub | null => {
  if (!node || node.nodeType !== 1) {
    return null;
  }

  if (!('attributes' in node)) {
    return null;
  }

  const element = node;

  if ((attribute in element.attributes) && (value === undefined || element.attributes[attribute] === value)) {
    return element;
  }

  for (const child of element.childNodes) {
    const match = findByAttribute(child, attribute, value);
    if (match) {
      return match;
    }
  }

  return null;
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createPreviewController = (initialSnapshot: PreviewSnapshot) => {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();

  const calls = {
    confirmLargePreview: 0,
    retryPreview: 0,
    clearSelection: 0,
  };

  const controller: PreviewController & {
    setSnapshot: (next: PreviewSnapshot) => void;
    calls: typeof calls;
  } = {
    getPreviewSnapshot: () => snapshot,
    getCommitSnapshot: () => ({ status: 'idle' as const }),
    subscribeCommit: () => () => {},
    isExpanded: () => false,
    subscribeExpanded: () => () => {},
    toggleExpanded() {},
    retryCommit() {},
    selectFile() {},
    subscribePreview(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    confirmLargePreview() {
      calls.confirmLargePreview += 1;
    },
    retryPreview() {
      calls.retryPreview += 1;
    },
    clearSelection() {
      calls.clearSelection += 1;
    },
    dispose() {},
    setSnapshot(next) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
    calls,
  };

  return controller;
};

const buildFile = (overrides: Partial<GitCommitChangedFile> = {}): GitCommitChangedFile => ({
  path: 'src/example.ts',
  status: 'M',
  kind: 'file',
  insertions: 8,
  deletions: 3,
  isBinary: false,
  ...overrides,
});

const buildReadySnapshot = (fileOverrides: Partial<GitCommitChangedFile> = {}, overrides: Partial<Extract<PreviewSnapshot, { status: 'ready' }>> = {}): PreviewSnapshot => ({
  status: 'ready',
  comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
  file: buildFile(fileOverrides),
  original: 'const before = 1;\n',
  modified: 'const after = 2;\n',
  ...overrides,
});

const renderPreviewMarkup = (
  controller: PreviewController,
  props: Partial<PreviewProps> = {},
) => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    null,
    React.createElement(GitCommitDiffPreview, {
      controller,
      announceOverlayOpen: false,
      ...props,
    }),
  ),
);

const renderPreviewClient = async (
  controller: PreviewController,
  props: Partial<PreviewProps> = {},
) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.reactContainer);
  await act(async () => {
    root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(GitCommitDiffPreview, {
            controller,
            announceOverlayOpen: true,
            ...props,
          }),
        ),
      );
    await flush();
  });

  return {
    container: dom.stubContainer,
    documentStub: dom.documentStub,
    restore: async () => {
      await act(async () => {
        root.unmount();
        await flush();
      });
      dom.restore();
    },
  };
};

  beforeEach(() => {
    diffViewCalls.length = 0;
  });

describe('GitCommitDiffPreview', () => {
  test('passes ready snapshots to DiffView for added, modified, deleted, and renamed files', () => {
    const addedController = createPreviewController(buildReadySnapshot({ status: 'A', path: 'src/new.ts' }, { original: '', modified: 'export const created = true;\n' }));
    renderPreviewMarkup(addedController);
    expect(diffViewCalls.at(-1)?.snapshotSource).toEqual({
      directory: '/repo',
      files: [{
        path: 'src/new.ts',
        status: 'A',
        insertions: 8,
        deletions: 3,
        isBinary: false,
        original: '',
        modified: 'export const created = true;\n',
      }],
    });

    const modifiedController = createPreviewController(buildReadySnapshot({ status: 'M', path: 'src/updated.ts' }));
    renderPreviewMarkup(modifiedController);
    expect(diffViewCalls.at(-1)?.snapshotSource).toEqual({
      directory: '/repo',
      files: [{
        path: 'src/updated.ts',
        status: 'M',
        insertions: 8,
        deletions: 3,
        isBinary: false,
        original: 'const before = 1;\n',
        modified: 'const after = 2;\n',
      }],
    });

    const deletedController = createPreviewController(buildReadySnapshot({ status: 'D', path: 'src/removed.ts' }, { modified: '' }));
    renderPreviewMarkup(deletedController);
    expect(diffViewCalls.at(-1)?.snapshotSource).toEqual({
      directory: '/repo',
      files: [{
        path: 'src/removed.ts',
        status: 'D',
        insertions: 8,
        deletions: 3,
        isBinary: false,
        original: 'const before = 1;\n',
        modified: '',
      }],
    });

    const renamedController = createPreviewController(buildReadySnapshot({ status: 'R', path: 'src/new-name.ts', originalPath: 'src/old-name.ts' }));
    const renamedMarkup = renderPreviewMarkup(renamedController);
    expect(renamedMarkup).not.toContain('src/old-name.ts');
    expect(renamedMarkup).not.toContain('data-git-commit-diff-preview-header');
    expect(diffViewCalls.at(-1)?.snapshotSource).toEqual({
      directory: '/repo',
      files: [{
        path: 'src/new-name.ts',
        status: 'R',
        insertions: 8,
        deletions: 3,
        isBinary: false,
        original: 'const before = 1;\n',
        modified: 'const after = 2;\n',
      }],
    });
    expect(diffViewCalls.at(-1)?.hideStackedFileSidebar).toBe(true);
    expect(diffViewCalls.at(-1)?.showOpenInEditorAction).toBe(false);
    expect(diffViewCalls.at(-1)?.flushContent).toBe(true);
  });

  test('renders preview content without inset padding', () => {
    const markup = renderPreviewMarkup(createPreviewController(buildReadySnapshot()));

    expect(markup).not.toContain('px-4');
    expect(markup).not.toContain('py-3');
  });

  test('renders loading placeholder and keeps stale body visible for same-key retry errors', () => {
    const loadingController = createPreviewController({
      status: 'loading',
      comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
      file: buildFile(),
    });
    const loadingMarkup = renderPreviewMarkup(loadingController);
    expect(loadingMarkup).toContain('Loading diff...');

    const staleController = createPreviewController({
      status: 'error',
      comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
      file: buildFile(),
      error: new Error('boom'),
      retryCount: 1,
    });
    const staleMarkup = renderPreviewMarkup(staleController);
    expect(staleMarkup).toContain('Failed to load diff. Click to retry.');
    expect(staleMarkup).toContain('Retry');
    expect(staleMarkup).not.toContain('data-standard-diff-view');
  });

  test('renders binary and gitlink object metadata without opening the diff viewer', () => {
    const binaryController = createPreviewController({
      status: 'binary',
      comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
      file: buildFile({ path: 'assets/logo.png', isBinary: true, objectId: '1111111', originalObjectId: '0000000' }),
    });
    const binaryMarkup = renderPreviewMarkup(binaryController);
    expect(binaryMarkup).toContain('Cannot preview binary file');
    expect(binaryMarkup).toContain('0000000');
    expect(binaryMarkup).toContain('1111111');
    expect(binaryMarkup).not.toContain('data-standard-diff-view');

    const gitlinkController = createPreviewController({
      status: 'gitlink',
      comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
      file: buildFile({ path: 'vendor/tooling', kind: 'gitlink', objectId: 'bbbbbbb', originalObjectId: 'aaaaaaa' }),
      objectId: 'bbbbbbb',
      originalObjectId: 'aaaaaaa',
    });
    const gitlinkMarkup = renderPreviewMarkup(gitlinkController);
    expect(gitlinkMarkup).toContain('Submodule pointer');
    expect(gitlinkMarkup).toContain('aaaaaaa');
    expect(gitlinkMarkup).toContain('bbbbbbb');
    expect(gitlinkMarkup).not.toContain('data-standard-diff-view');
  });

  test('renders line-gate confirmation and backend too-large states', () => {
    const lineGateController = createPreviewController({
      status: 'confirm-large',
      comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
      file: buildFile({ insertions: 450, deletions: 60 }),
      changedLines: 510,
      maxChangedLines: 400,
    });
    const lineGateMarkup = renderPreviewMarkup(lineGateController);
    expect(lineGateMarkup).toContain('Large diff (510 changed lines)');
    expect(lineGateMarkup).toContain('Render anyway');

    const tooLargeController = createPreviewController({
      status: 'too-large',
      comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
      file: buildFile(),
      totalBytes: 10485761,
      maxBytes: 8388608,
    });
    const tooLargeMarkup = renderPreviewMarkup(tooLargeController);
    expect(tooLargeMarkup).toContain('Preview unavailable');
    expect(tooLargeMarkup).toContain('10.0 MB');
    expect(tooLargeMarkup).toContain('8.0 MB');
  });

  test('removes duplicate preview chrome while keeping the polite announcement', async () => {
    const controller = createPreviewController(buildReadySnapshot({ status: 'R', path: 'src/new-name.ts', originalPath: 'src/old-name.ts' }));
    const rendered = await renderPreviewClient(controller);

    const header = findByAttribute(rendered.container, 'data-git-commit-diff-preview-header');
    expect(header).toBeNull();

    const announcement = findByAttribute(rendered.container, 'data-git-commit-diff-preview-announcement');
    expect(announcement?.attributes['aria-live']).toBe('polite');

    const closeButton = findByAttribute(rendered.container, 'data-git-commit-diff-preview-close');
    expect(closeButton).toBeNull();
    expect(rendered.documentStub.activeElement).toBeNull();

    await rendered.restore();
  });

  test('renders DiffView flush without adding an inner ready-state wrapper', async () => {
    const controller = createPreviewController(buildReadySnapshot({ status: 'M', path: 'src/test.ts' }));
    const rendered = await renderPreviewClient(controller);

    const diffViewer = findByAttribute(rendered.container, 'data-standard-diff-view', 'true');
    expect(diffViewer).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-diff-view-toggle', 'true')).not.toBeNull();

    const parent = diffViewer?.parentNode;
    expect(parent).not.toBeNull();
    expect(parent?.nodeType).toBe(1);
    // SAFETY: The preceding assertion confirms the parent is an ElementStub, not a TextStub.
    const classStr = (parent as ElementStub).attributes['class'] ?? '';
    expect(classStr).not.toContain('rounded-lg');
    expect(classStr).not.toContain('border');
    expect(classStr).not.toContain('bg-[var(--surface-background)]');

    await rendered.restore();
  });
});
