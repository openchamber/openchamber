import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { useUIStore } from '@/stores/useUIStore';

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => <span data-icon={name} className={className} />,
}));

const { WorkStatusCollapsibleSection } = await import('./WorkStatusPrimitives');

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
  head: ElementStub | null;
  documentElement: ElementStub | null;
  createElement(tag: string): ElementStub;
  createElementNS(_: string, tag: string): ElementStub;
  createTextNode(text: string): TextStub;
  getElementsByTagName(name: string): ElementStub[];
  addEventListener(): void;
  removeEventListener(): void;
};

type ReactContainer = Parameters<typeof createRoot>[0];
type ReactContainerLike = ReactContainer & ElementStub;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const isElementStub = (node: ElementStub | TextStub | null | undefined): node is ElementStub =>
  Boolean(node && node.nodeType === 1);

const isReactContainerLike = (value: ElementStub | null): value is ReactContainerLike => value !== null;

const findElement = (
  node: ElementStub | TextStub | null | undefined,
  predicate: (element: ElementStub) => boolean,
): ElementStub | null => {
  if (!isElementStub(node)) return null;
  if (predicate(node)) return node;
  for (const child of node.childNodes) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
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
    head: null,
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
    getElementsByTagName(name) {
      if (name === 'head' && documentStub.head) return [documentStub.head];
      if (name === 'body' && documentStub.body) return [documentStub.body];
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const head = makeElement('head', documentStub);
  const rawContainer = makeElement('div', documentStub);
  if (!isReactContainerLike(rawContainer)) {
    throw new Error('Expected a React-compatible container');
  }
  const container = rawContainer;
  documentStub.head = head;
  documentStub.body = container;
  documentStub.documentElement = container;

  class ElementClass {}

  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('navigator', { userAgent: 'bun', platform: 'test', maxTouchPoints: 0 });
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementClass);
  setGlobal('HTMLElement', ElementClass);
  setGlobal('HTMLButtonElement', ElementClass);
  setGlobal('HTMLIFrameElement', ElementClass);
  setGlobal('Node', ElementClass);
  setGlobal('MutationObserver', class {
    disconnect() {}
    observe() {}
    takeRecords() { return []; }
  });
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

const renderNode = async (node: React.ReactNode) => {
  const dom = installMinimalDom();
  const root: Root = createRoot(dom.container);

  const rerender = async (nextNode: React.ReactNode) => {
    await act(async () => {
      root.render(nextNode);
      await flush();
    });
  };

  await rerender(node);

  return {
    container: dom.container,
    rerender,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await flush();
      });
      dom.restore();
    },
  };
};

describe('WorkStatusCollapsibleSection', () => {
  beforeEach(() => {
    useUIStore.setState({
      workStatusExpandedSections: {},
      workStatusHiddenSections: [],
    });
  });

  test('renders header controls only while expanded and keeps them outside the section toggle button', async () => {
    const rendered = await renderNode(
      <WorkStatusCollapsibleSection
        id="gitGraph"
        title="Git"
        headerControls={<button type="button" data-header-control="true">Refresh</button>}
      >
        <div>Body</div>
      </WorkStatusCollapsibleSection>,
    );

    expect(findElement(rendered.container, (element) => element.attributes['data-header-control'] === 'true')).toBeNull();

    await act(async () => {
      useUIStore.getState().setWorkStatusSectionExpanded('gitGraph', true);
      await flush();
    });

    const toggleButton = findElement(
      rendered.container,
      (element) => element.tagName === 'BUTTON' && element.attributes['aria-expanded'] === 'true',
    );

    expect(toggleButton).not.toBeNull();
    expect(findElement(rendered.container, (element) => element.attributes['data-header-control'] === 'true')).not.toBeNull();
    expect(findElement(toggleButton, (element) => element.attributes['data-header-control'] === 'true')).toBeNull();

    await rendered.unmount();
  });
});
