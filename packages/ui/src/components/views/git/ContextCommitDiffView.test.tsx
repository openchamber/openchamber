import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { I18nProvider } from '@/lib/i18n/context';
import type { GitCommitChangedFile, GitCommitFilePreviewRequest, GitCommitFilePreviewResponse, RuntimeAPIs } from '@/lib/api/types';
import type { GitCommitDiffTarget } from '@/stores/useUIStore';
import { createGitCommitDetailsController } from './gitCommitDetailsController';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;
type PierreDiffViewerProps = {
  fileName?: string;
  original?: string;
  modified?: string;
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

const pierreCalls: PierreDiffViewerProps[] = [];
const closeHandlers: Array<() => void> = [];
let runtimeApis: RuntimeAPIs;

mock.module('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, MockButtonProps>(({ children, onClick, ...props }, ref) => {
    const closeMarker = (props as MockButtonProps & { 'data-git-commit-diff-preview-close'?: string })['data-git-commit-diff-preview-close'];
    if (closeMarker === 'true' && onClick) {
      closeHandlers.push(() => onClick({} as React.MouseEvent<HTMLButtonElement>));
    }
    return React.createElement('button', { ...props, onClick, ref }, children);
  }),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));

mock.module('@/components/views/PierreDiffViewer', () => ({
  PierreDiffViewer: (props: PierreDiffViewerProps) => {
    pierreCalls.push(props);
    return React.createElement('div', {
      'data-diff-viewer': true,
      'data-file-name': String(props.fileName ?? ''),
      'data-original': String(props.original ?? ''),
      'data-modified': String(props.modified ?? ''),
    });
  },
}));

const {
  ContextCommitDiffView,
} = await import('./ContextCommitDiffView');

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

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const isTextNode = (node: NodeStub): node is TextStub => node.nodeType === 3;

const isElementNode = (node: NodeStub): node is ElementStub => node.nodeType === 1;

const collectText = (node: NodeStub | null): string => {
  if (!node) {
    return '';
  }
  if (isTextNode(node)) {
    return node.nodeValue;
  }
  if (!isElementNode(node)) {
    return '';
  }
  return `${node.textContent ?? ''}${node.childNodes.map((child) => collectText(child)).join('')}`;
};

const findByAttribute = (node: NodeStub | null, attribute: string, value?: string): ElementStub | null => {
  if (!node || !isElementNode(node)) {
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

const buildFile = (overrides: Partial<GitCommitChangedFile> = {}): GitCommitChangedFile => ({
  path: 'src/new-name.ts',
  originalPath: 'src/old-name.ts',
  status: 'R',
  kind: 'file',
  objectId: '1'.repeat(40),
  originalObjectId: '2'.repeat(40),
  insertions: 7,
  deletions: 3,
  isBinary: false,
  ...overrides,
});

const buildTarget = (overrides: Partial<GitCommitDiffTarget> = {}): GitCommitDiffTarget => ({
  commitHash: 'a'.repeat(40),
  parentHash: 'b'.repeat(40),
  file: buildFile(),
  ...overrides,
});

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const renderView = async (target: GitCommitDiffTarget, onClose: () => void, props: Record<string, unknown> = {}) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.reactContainer);

  const render = async (nextTarget: GitCommitDiffTarget, nextProps: Record<string, unknown> = props) => {
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(
            RuntimeAPIContext.Provider,
            { value: runtimeApis },
            React.createElement(ContextCommitDiffView, {
              directory: '/repo',
              target: nextTarget,
              onClose,
              ...nextProps,
            }),
          ),
        ),
      );
      await flush();
    });
  };

  await render(target, props);

  return {
    container: dom.container,
    rerender: render,
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
  pierreCalls.length = 0;
  closeHandlers.length = 0;
});

describe('ContextCommitDiffView', () => {
  test('requests the exact historical preview and renders the ready diff with a close action', async () => {
    const requests: GitCommitFilePreviewRequest[] = [];
    runtimeApis = {
      git: {
        getCommitFileDiff: async (_directory: string, request: GitCommitFilePreviewRequest) => {
          requests.push(request);
          return { status: 'ready', original: 'before\n', modified: 'after\n' } satisfies GitCommitFilePreviewResponse;
        },
      },
    } as unknown as RuntimeAPIs;
    let closeCount = 0;

    const rendered = await renderView(buildTarget(), () => {
      closeCount += 1;
    });

    expect(requests).toEqual([{
      commitHash: 'a'.repeat(40),
      parentHash: 'b'.repeat(40),
      originalPath: 'src/old-name.ts',
      modifiedPath: 'src/new-name.ts',
    }]);
    expect(findByAttribute(rendered.container, 'data-git-commit-context-diff', 'true')).not.toBeNull();
    expect(pierreCalls.at(-1)?.fileName).toBe('src/new-name.ts');
    expect(pierreCalls.at(-1)?.original).toBe('before\n');
    expect(pierreCalls.at(-1)?.modified).toBe('after\n');

    closeHandlers[0]?.();
    expect(closeCount).toBe(1);

    await rendered.restore();
  });

  test('reuses preview component states for binary, gitlink, too-large, and error cases', async () => {
    runtimeApis = {
      git: {
        getCommitFileDiff: async (_directory: string, request: GitCommitFilePreviewRequest) => {
          if (request.modifiedPath === 'src/too-large.ts') {
            return { status: 'too-large', totalBytes: 9 * 1024 * 1024, maxBytes: 8 * 1024 * 1024 } satisfies GitCommitFilePreviewResponse;
          }
          throw new Error('offline');
        },
      },
    } as unknown as RuntimeAPIs;

    const binary = await renderView(buildTarget({ file: buildFile({ path: 'assets/logo.png', isBinary: true, status: 'M' }) }), () => {});
    expect(collectText(binary.container)).toContain('filesView.editor.cannotPreviewBinary');
    await binary.restore();

    const gitlink = await renderView(buildTarget({ file: buildFile({ path: 'vendor/tooling', kind: 'gitlink', isBinary: true }) }), () => {});
    expect(collectText(gitlink.container)).toContain('gitView.preview.submodulePointer');
    await gitlink.restore();

    const tooLarge = await renderView(buildTarget({ file: buildFile({ path: 'src/too-large.ts', status: 'M', originalPath: undefined }) }), () => {});
    expect(collectText(tooLarge.container)).toContain('gitView.integrate.previewUnavailable');
    await tooLarge.restore();

    const error = await renderView(buildTarget({ file: buildFile({ path: 'src/error.ts', status: 'M', originalPath: undefined }) }), () => {});
    expect(collectText(error.container)).toContain('gitView.history.diffError');
    expect(collectText(error.container)).toContain('diffView.actions.retry');
    await error.restore();
  });

  test('disposes on unmount so stale preview resolutions do not update after teardown', async () => {
    const deferred = createDeferred<GitCommitFilePreviewResponse>();
    runtimeApis = {
      git: {
        getCommitFileDiff: async () => deferred.promise,
      },
    } as unknown as RuntimeAPIs;

    const rendered = await renderView(buildTarget({ file: buildFile({ path: 'src/pending.ts', status: 'M', originalPath: undefined }) }), () => {});
    await rendered.restore();

    deferred.resolve({ status: 'ready', original: 'stale old', modified: 'stale new' });
    await flush();
    expect(pierreCalls).toHaveLength(0);
  });

  test('keeps one controller for equivalent targets, refetches only when the target changes, and disposes once on unmount', async () => {
    const requests: GitCommitFilePreviewRequest[] = [];
    let controllerCreations = 0;
    let controllerDisposals = 0;

    runtimeApis = {
      git: {
        getCommitFileDiff: async (_directory: string, request: GitCommitFilePreviewRequest) => {
          requests.push(request);
          return { status: 'ready', original: request.originalPath ?? '', modified: request.modifiedPath ?? '' } satisfies GitCommitFilePreviewResponse;
        },
      },
    } as unknown as RuntimeAPIs;

    const target = buildTarget();
    const equivalentTarget = buildTarget();
    const changedTarget = buildTarget({
      commitHash: 'c'.repeat(40),
      parentHash: null,
      file: buildFile({
        path: 'src/changed.ts',
        originalPath: 'src/changed-before.ts',
        status: 'R',
      }),
    });

    const createController = (options: Parameters<typeof createGitCommitDetailsController>[0]) => {
      controllerCreations += 1;
      const controller = createGitCommitDetailsController(options);
      return {
        ...controller,
        dispose: () => {
          controllerDisposals += 1;
          controller.dispose();
        },
      };
    };

    const rendered = await renderView(target, () => {}, {
      createController,
    });

    expect(controllerCreations).toBe(1);
    expect(requests).toEqual([{
      commitHash: 'a'.repeat(40),
      parentHash: 'b'.repeat(40),
      originalPath: 'src/old-name.ts',
      modifiedPath: 'src/new-name.ts',
    }]);

    await rendered.rerender(equivalentTarget, { createController });

    expect(controllerCreations).toBe(1);
    expect(requests).toHaveLength(1);

    await rendered.rerender(changedTarget, { createController });

    expect(controllerCreations).toBe(1);
    expect(requests).toEqual([
      {
        commitHash: 'a'.repeat(40),
        parentHash: 'b'.repeat(40),
        originalPath: 'src/old-name.ts',
        modifiedPath: 'src/new-name.ts',
      },
      {
        commitHash: 'c'.repeat(40),
        parentHash: null,
        originalPath: 'src/changed-before.ts',
        modifiedPath: 'src/changed.ts',
      },
    ]);

    await rendered.restore();
    expect(controllerDisposals).toBe(1);
  });
});
