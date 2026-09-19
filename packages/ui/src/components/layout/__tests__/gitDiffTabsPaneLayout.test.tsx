import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useGitDiffTabsStore } from '@/stores/useGitDiffTabsStore';

type MockDiffViewProps = {
  singleFilePath?: string | null;
  targetFilePath?: string | null;
};

const diffViewPropsCalls: MockDiffViewProps[] = [];

mock.module('@/components/ui/sortable-tabs-strip', () => ({
  SortableTabsStrip: ({ items }: { items: Array<{ id: string; label: string }> }) =>
    React.createElement(
      'div',
      { 'data-sortable-tabs-strip': 'true' },
      items.map((item) =>
        React.createElement('span', { key: item.id, 'data-tab-id': item.id }, item.label),
      ),
    ),
}));

mock.module('@/components/views/DiffView', () => ({
  DiffView: (props: MockDiffViewProps) => {
    diffViewPropsCalls.push(props);
    return React.createElement('div', { 'data-working-diff-view': 'true' });
  },
}));

const { GitDiffTabsPane } = await import('../GitDiffTabsPane');

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
    // SAFETY: `container` comes from `makeElement`, so it implements the DOM container fields React reads from the root element.
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

const findByAttribute = (node: NodeStub | null, attribute: string, value?: string): ElementStub | null => {
  if (!node || node.nodeType !== 1) {
    return null;
  }

  // SAFETY: the `nodeType === 1` guard narrows this stub node to an element shape with attributes and childNodes.
  const element = node as ElementStub;
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

beforeEach(() => {
  diffViewPropsCalls.length = 0;
  useGitDiffTabsStore.setState({
    byDirectory: {
      '/repo': {
        tabs: [
          {
            kind: 'working',
            path: 'src/history.ts',
            scope: 'working',
            id: 'working:src/history.ts',
            touchedAt: 1,
          },
        ],
        activeTabId: 'working:src/history.ts',
      },
    },
  });
});

describe('GitDiffTabsPane layout', () => {
  test('pins the tabs strip inside a fixed header boundary above the diff content', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.reactContainer);

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(GitDiffTabsPane, { directory: '/repo' }),
        ),
      );
      await flush();
    });

    const header = findByAttribute(dom.container, 'data-git-diff-tabs-header', 'true');
    expect(header).not.toBeNull();
    expect(header?.attributes.class).toContain('h-10');
    expect(header?.attributes.class).toContain('shrink-0');
    expect(header?.attributes.class).toContain('items-stretch');

    await act(async () => {
      root.unmount();
      await flush();
    });
    dom.restore();
  });

  test('passes the working tab path through DiffView single-file mode', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.reactContainer);

    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(GitDiffTabsPane, { directory: '/repo' }),
        ),
      );
      await flush();
    });

    try {
      expect(diffViewPropsCalls.at(-1)?.singleFilePath).toBe('src/history.ts');
      expect(diffViewPropsCalls.at(-1)?.targetFilePath).toBe(undefined);
    } finally {
      await act(async () => {
        root.unmount();
        await flush();
      });
      dom.restore();
    }
  });
});
