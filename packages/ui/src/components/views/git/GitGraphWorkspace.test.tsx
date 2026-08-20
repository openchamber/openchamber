import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

type MockButtonProps = React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>;
type ResizeObserverEntryLike = { contentRect: { width: number; height: number } };
type FocusInEventStub = { target: ElementStub | null };
type KeydownEventStub = {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
};
type ElementListenerMap = {
  focusin: Array<(event: FocusInEventStub) => void>;
  keydown: Array<(event: KeydownEventStub) => void>;
};

mock.module('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, MockButtonProps>(({ children, ...props }, ref) => React.createElement('button', { ...props, ref }, children)),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));

mock.module('@/components/views/PierreDiffViewer', () => ({
  PierreDiffViewer: () => React.createElement('div', { 'data-diff-viewer': true }),
}));

const { GitGraphWorkspace } = await import('./GitGraphWorkspace');

type WorkspaceProps = React.ComponentProps<typeof GitGraphWorkspace>;
type PreviewController = WorkspaceProps['controller'];
type PreviewSnapshot = ReturnType<PreviewController['getPreviewSnapshot']>;

type NodeStub = ElementStub | TextStub;
type TextStub = { nodeType: number; nodeValue: string; ownerDocument: DocumentStub; parentNode: ElementStub | null };
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
  listeners: ElementListenerMap;
  addEventListener(...args: ['focusin', (event: FocusInEventStub) => void] | ['keydown', (event: KeydownEventStub) => void]): void;
  removeEventListener(...args: ['focusin', (event: FocusInEventStub) => void] | ['keydown', (event: KeydownEventStub) => void]): void;
  appendChild(child: NodeStub): NodeStub;
  insertBefore(child: NodeStub, ref: NodeStub | null): NodeStub;
  removeChild(child: NodeStub): NodeStub;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
  closest(): null;
  getBoundingClientRect(): { width: number; height: number };
  querySelector(selector: string): ElementStub | null;
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

let notifyResize: ((entries: ResizeObserverEntryLike[]) => void) | null = null;

class StubResizeObserver {
  constructor(callback: (entries: ResizeObserverEntryLike[]) => void) {
    notifyResize = callback;
  }

  observe(element: ElementStub) {
    void element;
  }

  disconnect() {
    notifyResize = null;
  }
}

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = <T,>(name: string, value: T) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  const makeElement = (tag: string, owner: DocumentStub): ElementStub => {
    const element: ElementStub = {
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
      listeners: { focusin: [], keydown: [] },
      addEventListener(...args) {
        const [type, listener] = args;
        if (type === 'focusin') {
          element.listeners.focusin.push(listener);
          return;
        }

        element.listeners.keydown.push(listener);
      },
      removeEventListener(...args) {
        const [type, listener] = args;
        if (type === 'focusin') {
          element.listeners.focusin = element.listeners.focusin.filter((entry) => entry !== listener);
          return;
        }

        element.listeners.keydown = element.listeners.keydown.filter((entry) => entry !== listener);
      },
      appendChild(child) {
        element.childNodes.push(child);
        child.parentNode = element;
        return child;
      },
      insertBefore(child, ref) {
        if (ref === null) {
          return element.appendChild(child);
        }
        const index = element.childNodes.indexOf(ref);
        if (index === -1) {
          return element.appendChild(child);
        }
        element.childNodes.splice(index, 0, child);
        child.parentNode = element;
        return child;
      },
      removeChild(child) {
        const index = element.childNodes.indexOf(child);
        if (index >= 0) {
          element.childNodes.splice(index, 1);
          child.parentNode = null;
        }
        return child;
      },
      setAttribute(name, value) {
        element.attributes[name] = value;
        if (name === 'id') {
          element.id = value;
        }
      },
      removeAttribute(name) {
        delete element.attributes[name];
        if (name === 'id') {
          element.id = '';
        }
      },
      getAttribute(name) {
        return element.attributes[name] ?? null;
      },
      focus() {
        owner.activeElement = element;
        let current: ElementStub | null = element;
        while (current) {
          for (const listener of current.listeners.focusin) {
            listener({ target: element });
          }
          current = current.parentNode;
        }
      },
      closest() {
        return null;
      },
      getBoundingClientRect() {
        return { width: 0, height: 0 };
      },
      querySelector(selector) {
        if (selector === '[data-graph-focus-target]') {
          return findByAttribute(element, 'data-graph-focus-target');
        }
        return null;
      },
    };

    return element;
  };

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
  setGlobal('ResizeObserver', StubResizeObserver);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));

  return {
    // SAFETY: React only reads the DOM-like fields implemented by this container stub.
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

const emitResize = async (width: number) => {
  await act(async () => {
    notifyResize?.([{ contentRect: { width, height: 800 } }]);
    await flush();
  });
};

const createPreviewController = (initialSnapshot: PreviewSnapshot) => {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  const calls = { clearSelection: 0 };

  return {
    getPreviewSnapshot: () => snapshot,
    getCommitSnapshot: () => ({ status: 'idle' as const }),
    subscribeCommit: () => () => {},
    isExpanded: () => false,
    subscribeExpanded: () => () => {},
    toggleExpanded() {},
    retryCommit() {},
    selectFile() {},
    subscribePreview(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearSelection() {
      calls.clearSelection += 1;
      snapshot = { status: 'idle' };
      for (const listener of listeners) {
        listener();
      }
    },
    confirmLargePreview() {},
    retryPreview() {},
    dispose() {},
    setSnapshot(next: PreviewSnapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
    calls,
  };
};

const activePreviewSnapshot = {
  status: 'ready',
  comparison: { directory: '/repo', commitHash: 'abc', parentHash: 'def' },
  file: {
    path: 'src/example.ts',
    status: 'M',
    kind: 'file',
    insertions: 3,
    deletions: 1,
    isBinary: false,
  },
  original: 'before\n',
  modified: 'after\n',
} satisfies PreviewSnapshot;

const renderWorkspace = async (controller: PreviewController) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.reactContainer);
  await act(async () => {
    root.render(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(GitGraphWorkspace, {
          directory: '/repo',
          controller,
          graph: React.createElement('button', { type: 'button', 'data-graph-focus-target': true }, 'graph'),
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
  notifyResize = null;
  useUIStore.setState({ gitRepositoryPaneStates: {} });
});

describe('GitGraphWorkspace', () => {
  test('keeps the graph full-width when nothing is selected', async () => {
    const controller = createPreviewController({ status: 'idle' });
    const rendered = await renderWorkspace(controller);

    await emitResize(720);

    const layout = findByAttribute(rendered.container, 'data-git-graph-workspace-layout', 'full');
    expect(layout).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-git-commit-diff-preview')).toBeNull();

    await rendered.restore();
  });

  test('renders a split workspace at 720px and clamps the persisted preview width', async () => {
    useUIStore.getState().setGitRepositoryPaneState('/repo', { previewWidth: 999 });
    const controller = createPreviewController(activePreviewSnapshot);
    const rendered = await renderWorkspace(controller);

    await emitResize(720);

    const layout = findByAttribute(rendered.container, 'data-git-graph-workspace-layout', 'split');
    expect(layout).not.toBeNull();
    const separator = findByAttribute(rendered.container, 'data-git-graph-workspace-separator');
    expect(separator?.attributes['aria-orientation']).toBe('vertical');
    expect(separator?.style.width).toBe('8px');
    expect(findByAttribute(rendered.container, 'data-close-mode', 'close')).not.toBeNull();

    const stored = useUIStore.getState().getGitRepositoryPaneState('/repo');
    expect(stored.previewWidth).toBe(360);

    await rendered.restore();
  });

  test('keeps the split layout available at the 320/8/360 minimum width contract', async () => {
    const controller = createPreviewController(activePreviewSnapshot);
    const rendered = await renderWorkspace(controller);

    await emitResize(720);

    const splitLayout = findByAttribute(rendered.container, 'data-git-graph-workspace-layout', 'split');
    expect(splitLayout).not.toBeNull();

    await rendered.restore();
  });

  test('switches to an in-surface overlay below the 320/8/360 minimum width contract', async () => {
    const controller = createPreviewController(activePreviewSnapshot);
    const rendered = await renderWorkspace(controller);

    await emitResize(719);

    const overlay = findByAttribute(rendered.container, 'data-git-graph-workspace-layout', 'overlay');
    expect(overlay).not.toBeNull();

    await rendered.restore();
  });

  test('exposes a back action in overlay mode', async () => {
    const controller = createPreviewController(activePreviewSnapshot);
    const rendered = await renderWorkspace(controller);

    await emitResize(719);

    const overlay = findByAttribute(rendered.container, 'data-git-graph-workspace-layout', 'overlay');
    expect(overlay).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-close-mode', 'back')).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-auto-focus-close', 'true')).not.toBeNull();
    expect(findByAttribute(rendered.container, 'data-announce-open', 'true')).not.toBeNull();

    await rendered.restore();
  });

  test('preempts Escape in overlay mode, clears selection, and returns focus to the graph trigger', async () => {
    const controller = createPreviewController({ status: 'idle' });
    const rendered = await renderWorkspace(controller);

    await emitResize(600);
    const graphButton = findByAttribute(rendered.container, 'data-graph-focus-target');
    await act(async () => {
      graphButton?.focus();
      await flush();
    });
    expect(rendered.documentStub.activeElement).toBe(graphButton);

    await act(async () => {
      controller.setSnapshot(activePreviewSnapshot);
      await flush();
    });

    const overlay = findByAttribute(rendered.container, 'data-git-graph-workspace-layout', 'overlay');
    const closeButton = findByAttribute(rendered.container, 'data-preview-close', 'back');
    expect(overlay).not.toBeNull();
    expect(closeButton).not.toBeNull();
    expect(rendered.documentStub.activeElement).toBe(closeButton);

    let prevented = false;
    let stopped = false;
    await act(async () => {
      overlay?.listeners.keydown[0]?.({
        key: 'Escape',
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
      });
      await flush();
    });

    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(controller.calls.clearSelection).toBe(1);
    expect(rendered.documentStub.activeElement).toBe(graphButton);

    await rendered.restore();
  });
});
