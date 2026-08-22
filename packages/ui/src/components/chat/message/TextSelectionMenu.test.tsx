/**
 * Regression coverage for issue #2840.
 *
 * This mounts the real mobile TextSelectionMenu against the small DOM stub used
 * by UI component tests, selects formatted DOM content through the component's
 * selectionchange listener, and invokes the real Copy button handler. The
 * selected DOM text is intentionally plain while its Markdown selection is
 * bold, so a plain-text-only copy cannot satisfy the assertions.
 */

import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type FakeClickEvent = { preventDefault?: () => void; stopPropagation?: () => void };
type CopyHandler = (event: FakeClickEvent) => void | Promise<void>;
type ReactProps = { title?: string; onClick?: CopyHandler };
type ReactPropsKey = `__reactProps${string}`;
type FakeEvent = { type: string; target: FakeDocument };
type FakeListener = (event: FakeEvent) => void;
type FakeStyleValue = string | ((...args: string[]) => string | void);

interface FakeStyle {
  cssText: string;
  setProperty: (...args: string[]) => void;
  getPropertyValue: (...args: string[]) => string;
  [key: string]: FakeStyleValue;
}

interface FakeDocument {
  nodeType: number;
  nodeName: string;
  compatMode: string;
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  activeElement: FakeNode | null;
  addEventListener: (type: string, listener: FakeListener) => void;
  removeEventListener: (type: string, listener: FakeListener) => void;
  createElement: (tag: string) => FakeNode;
  createElementNS: (_namespace: string, tag: string) => FakeNode;
  createTextNode: (text: string) => FakeNode;
  execCommand: (_command: string) => boolean;
  emit: (type: string) => void;
}

interface FakeWindow {
  document: FakeDocument;
  navigator: {
    clipboard: {
      write: (items: FakeClipboardItem[]) => Promise<void>;
      writeText: (text: string) => Promise<void>;
    };
  };
  innerWidth: number;
  innerHeight: number;
  getSelection: () => SelectionStub | null;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (id: number) => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  HTMLIFrameElement: unknown;
  HTMLFrameSetElement: unknown;
  HTMLInputElement: unknown;
  HTMLTextAreaElement: unknown;
  HTMLSelectElement: unknown;
  HTMLOptionElement: unknown;
  HTMLAnchorElement: unknown;
}

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  namespaceURI: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  parentElement: FakeNode | null;
  childNodes: FakeNode[];
  style: FakeStyle;
  classList: FakeClassList;
  value: string;
  textContent: string;
  innerHTML: string;
  offsetWidth: number;
  appendChild: (child: FakeNode) => FakeNode;
  insertBefore: (child: FakeNode, reference: FakeNode | null) => FakeNode;
  removeChild: (child: FakeNode) => FakeNode;
  select: () => void;
  setSelectionRange: (_start: number, _end: number) => void;
  contains: (node: FakeNode) => boolean;
  setAttribute: (name: string, value: string) => void;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  removeAttribute: (name: string) => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  getBoundingClientRect: () => DOMRect;
  closest: (selector: string) => FakeNode | null;
  [key: ReactPropsKey]: ReactProps;
}

interface RangeFragment {
  childNodes: FakeNode[];
}

interface TestRange {
  startContainer: FakeNode;
  endContainer: FakeNode;
  commonAncestorContainer: FakeNode;
  cloneContents: () => RangeFragment;
  getBoundingClientRect: () => DOMRect;
}

interface SelectionStub {
  toString: () => string;
  getRangeAt: (_index: number) => TestRange;
  removeAllRanges: () => void;
}

class FakeClassList {
  private readonly classes = new Set<string>();

  add(...classes: string[]): void {
    classes.forEach((value) => this.classes.add(value));
  }

  remove(...classes: string[]): void {
    classes.forEach((value) => this.classes.delete(value));
  }

  contains(value: string): boolean {
    return this.classes.has(value);
  }
}

const makeRect = (): DOMRect => ({
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
});

const makeStyle = (): FakeStyle => ({
  cssText: '',
  setProperty: () => undefined,
  getPropertyValue: () => '',
});

const makeNode = (tag: string, ownerDocument: FakeDocument, nodeType = 1, textContent = ''): FakeNode => {
  const attributes = new Map<string, string>();
  const node: FakeNode = {
    nodeType,
    nodeName: nodeType === 3 ? '#text' : tag.toUpperCase(),
    tagName: nodeType === 3 ? '' : tag.toUpperCase(),
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument,
    parentNode: null,
    parentElement: null,
    childNodes: [],
    style: makeStyle(),
    classList: new FakeClassList(),
    value: '',
    textContent,
    innerHTML: '',
    offsetWidth: 0,
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      this.childNodes.push(child);
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      return child;
    },
    insertBefore(child, reference) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = reference ? this.childNodes.indexOf(reference) : -1;
      if (index === -1) this.childNodes.push(child);
      else this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index !== -1) this.childNodes.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    },
    select: () => undefined,
    setSelectionRange: () => undefined,
    contains(target) {
      let current: FakeNode | null = target;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getBoundingClientRect: makeRect,
    closest: () => null,
  };
  return node;
};

class FakeClipboardItem {
  static supports(type: string): boolean {
    return type === 'text/markdown';
  }

  readonly data: Record<string, Blob>;

  constructor(data: Record<string, Blob>) {
    this.data = data;
  }
}

const isReactPropsKey = (key: string): key is ReactPropsKey => key.startsWith('__reactProps');

const getReactProps = (node: FakeNode): ReactProps | null => {
  const propsKey = Object.keys(node).find(isReactPropsKey);
  return propsKey ? node[propsKey] : null;
};

const findNode = (root: FakeNode, predicate: (node: FakeNode) => boolean): FakeNode | null => {
  if (predicate(root)) return root;
  for (const child of root.childNodes) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
};

const asElement = (node: FakeNode): Element => {
  // SAFETY: the test DOM node implements the host methods React uses for a root.
  return node as never;
};

const asHTMLElement = (node: FakeNode): HTMLElement => {
  // SAFETY: the test DOM node implements the host methods used by the selection menu.
  return node as never;
};

const createSelectorHook = <State,>(state: State) => <Result,>(selector: (value: State) => Result): Result => selector(state);

const installDomStub = () => {
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const listeners = new Map<string, Set<FakeListener>>();
  const writtenItems: Array<FakeClipboardItem | undefined> = [];
  let currentSelection: SelectionStub | null = null;
  let nextAnimationFrameId = 0;
  const animationFrames = new Set<number>();

  const setGlobal = <Value,>(name: string, value: Value): void => {
    if (!previousGlobals.has(name)) {
      previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  // SAFETY: document and window are mutually recursive; both are populated before exposure.
  const documentStub = {} as FakeDocument;
  const addDocumentListener = (type: string, listener: FakeListener): void => {
    const callbacks = listeners.get(type) ?? new Set<FakeListener>();
    callbacks.add(listener);
    listeners.set(type, callbacks);
  };
  const removeDocumentListener = (type: string, listener: FakeListener): void => {
    const callbacks = listeners.get(type);
    if (!callbacks) return;
    callbacks.delete(listener);
    if (callbacks.size === 0) listeners.delete(type);
  };

  const clipboard = {
    write: async (items: FakeClipboardItem[]): Promise<void> => {
      writtenItems.push(items[0]);
    },
    writeText: async (text: string): Promise<void> => {
      void text;
    },
  };
  const windowStub: FakeWindow = {
    document: documentStub,
    navigator: { clipboard },
    innerWidth: 390,
    innerHeight: 844,
    getSelection: () => currentSelection,
    requestAnimationFrame: (callback) => {
      const id = ++nextAnimationFrameId;
      animationFrames.add(id);
      setTimeout(() => {
        if (!animationFrames.delete(id)) return;
        callback(Date.now());
      }, 0);
      return id;
    },
    cancelAnimationFrame: (id) => {
      animationFrames.delete(id);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  };

  Object.assign(documentStub, {
    nodeType: 9,
    nodeName: '#document',
    compatMode: 'CSS1Compat',
    defaultView: windowStub,
    activeElement: null,
    addEventListener: addDocumentListener,
    removeEventListener: removeDocumentListener,
    createElement: (tag: string) => makeNode(tag, documentStub),
    createElementNS: (_namespace: string, tag: string) => makeNode(tag, documentStub),
    createTextNode: (text: string) => makeNode('', documentStub, 3, text),
    execCommand: () => false,
    emit: (type: string) => {
      const event = { type, target: documentStub };
      listeners.get(type)?.forEach((listener) => listener(event));
    },
  });
  documentStub.body = makeNode('body', documentStub);
  documentStub.documentElement = makeNode('html', documentStub);

  setGlobal('document', documentStub);
  setGlobal('window', windowStub);
  setGlobal('navigator', windowStub.navigator);
  setGlobal('Element', class {});
  setGlobal('HTMLElement', class {});
  setGlobal('HTMLIFrameElement', windowStub.HTMLIFrameElement);
  setGlobal('HTMLFrameSetElement', windowStub.HTMLFrameSetElement);
  setGlobal('HTMLInputElement', windowStub.HTMLInputElement);
  setGlobal('HTMLTextAreaElement', windowStub.HTMLTextAreaElement);
  setGlobal('HTMLSelectElement', windowStub.HTMLSelectElement);
  setGlobal('HTMLOptionElement', windowStub.HTMLOptionElement);
  setGlobal('HTMLAnchorElement', windowStub.HTMLAnchorElement);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', windowStub.requestAnimationFrame);
  setGlobal('cancelAnimationFrame', windowStub.cancelAnimationFrame);
  setGlobal('ClipboardItem', FakeClipboardItem);

  return {
    document: documentStub,
    setSelection: (selection: SelectionStub): void => {
      currentSelection = selection;
    },
    writtenItems,
    restore: (): void => {
      previousGlobals.forEach((descriptor, name) => {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      });
    },
  };
};

const sessionUIState = {
  createSession: async (): Promise<null> => null,
  currentSessionId: null,
  availableWorktreesByProject: new Map<string, string[]>(),
};
const inputState = {
  setPendingInputText: (): void => undefined,
};
const toastErrors: Array<{ message: string; description?: string }> = [];

mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string, options?: { description?: string }) => {
      toastErrors.push({ message, description: options?.description });
    },
    success: () => undefined,
  },
}));
mock.module('@/components/chat/composer/editor/dom', () => ({ focusChatInput: () => undefined }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => undefined }));
mock.module('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/projectContextApi', () => ({ PROJECT_NOTE_BODY_MAX_LENGTH: 3000 }));
mock.module('@/lib/projectResolution', () => ({ resolveProjectForSessionDirectory: () => null }));
mock.module('@/lib/smallModel', () => ({ summarizeSelectionForNotes: async () => '' }));
mock.module('@/lib/utils', () => ({ cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ') }));
mock.module('@/stores/useProjectContextStore', () => ({ useProjectContextStore: { getState: () => ({ createNote: async () => null }) } }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: createSelectorHook({ projects: [] }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: createSelectorHook({ isMobile: true }) }));
mock.module('@/sync/input-store', () => ({ useInputStore: createSelectorHook(inputState) }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: createSelectorHook(sessionUIState) }));
mock.module('@/sync/sync-context', () => ({ useSessions: () => [] }));
mock.module('dompurify', () => ({ default: { isSupported: true, addHook: () => undefined, sanitize: (html: string) => html } }));
mock.module('../markdown/markdown-worker', () => ({ highlightCodeInWorker: async () => null }));

const { TextSelectionMenu } = await import('./TextSelectionMenu');

describe('TextSelectionMenu mobile Copy', () => {
  test('copies a formatted selection as plain Markdown, Markdown source, and HTML', async () => {
    const dom = installDomStub();
    let root: Root | null = null;
    toastErrors.length = 0;

    try {
      const mountNode = dom.document.createElement('div');
      dom.document.body.appendChild(mountNode);
      const content = dom.document.createElement('div');
      const strong = dom.document.createElement('strong');
      const selectedTextNode = dom.document.createTextNode('Bold selection');
      strong.appendChild(selectedTextNode);
      content.appendChild(strong);

      const range: TestRange = {
        startContainer: selectedTextNode,
        endContainer: selectedTextNode,
        commonAncestorContainer: strong,
        cloneContents: () => ({ childNodes: [strong] }),
        getBoundingClientRect: () => ({
          left: 100,
          top: 200,
          right: 220,
          bottom: 220,
          width: 120,
          height: 20,
          x: 100,
          y: 200,
          toJSON: () => ({}),
        }),
      };
      let rangeCount = 1;
      const selection: SelectionStub = {
        toString: () => (rangeCount > 0 ? 'Bold selection' : ''),
        getRangeAt: () => range,
        removeAllRanges: () => { rangeCount = 0; },
      };
      dom.setSelection(selection);

      root = createRoot(asElement(mountNode));
      const containerRef = { current: asHTMLElement(content) };
      await act(async () => {
        root?.render(React.createElement(TextSelectionMenu, { containerRef }));
      });
      await act(async () => {
        dom.document.emit('selectionchange');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const copyButton = findNode(
        dom.document.body,
        (node) => getReactProps(node)?.title === 'chat.textSelection.actions.copy',
      );
      if (!copyButton) throw new Error('Mobile Copy button was not mounted');
      const copyHandler = getReactProps(copyButton)?.onClick;
      if (!copyHandler) throw new Error('Mobile Copy button has no click handler');

      await act(async () => {
        await copyHandler({});
      });

      const writtenItem = dom.writtenItems[0];
      if (!writtenItem) throw new Error('Copy did not write a ClipboardItem');
      const plainText = await writtenItem.data['text/plain']?.text();
      const markdown = await writtenItem.data['text/markdown']?.text();
      const html = await writtenItem.data['text/html']?.text();

      expect(plainText).toBe('**Bold selection**');
      expect(markdown).toBe('**Bold selection**');
      expect(html).toContain('<strong>Bold selection</strong>');
      expect(plainText).not.toBe('Bold selection');
      expect(markdown).not.toBe('Bold selection');
      expect(html).not.toBe('Bold selection');
    } finally {
      const mountedRoot = root;
      if (mountedRoot) {
        await act(async () => {
          mountedRoot.unmount();
        });
      }
      dom.restore();
    }
  });

  test('hides the menu and clears the selection when clipboard writes are rejected', async () => {
    const dom = installDomStub();
    let root: Root | null = null;
    toastErrors.length = 0;

    try {
      dom.document.defaultView.navigator.clipboard.write = async () => {
        throw new Error('Clipboard rejected');
      };
      dom.document.defaultView.navigator.clipboard.writeText = async () => {
        throw new Error('Plain clipboard rejected');
      };

      const mountNode = dom.document.createElement('div');
      dom.document.body.appendChild(mountNode);
      const content = dom.document.createElement('div');
      const selectedTextNode = dom.document.createTextNode('Rejected selection');
      content.appendChild(selectedTextNode);

      const range: TestRange = {
        startContainer: selectedTextNode,
        endContainer: selectedTextNode,
        commonAncestorContainer: content,
        cloneContents: () => ({ childNodes: [selectedTextNode] }),
        getBoundingClientRect: makeRect,
      };
      let rangeCount = 1;
      const selection: SelectionStub = {
        toString: () => (rangeCount > 0 ? 'Rejected selection' : ''),
        getRangeAt: () => range,
        removeAllRanges: () => { rangeCount = 0; },
      };
      dom.setSelection(selection);

      root = createRoot(asElement(mountNode));
      const containerRef = { current: asHTMLElement(content) };
      await act(async () => {
        root?.render(React.createElement(TextSelectionMenu, { containerRef }));
      });
      await act(async () => {
        dom.document.emit('selectionchange');
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const copyButton = findNode(
        dom.document.body,
        (node) => getReactProps(node)?.title === 'chat.textSelection.actions.copy',
      );
      if (!copyButton) throw new Error('Mobile Copy button was not mounted');
      const copyHandler = getReactProps(copyButton)?.onClick;
      if (!copyHandler) throw new Error('Mobile Copy button has no click handler');

      await act(async () => {
        await copyHandler({});
      });

      expect(toastErrors).toEqual([{
        message: 'chat.textSelection.toast.copyFailed',
        description: undefined,
      }]);
      expect(selection.toString()).toBe('');
      expect(findNode(
        dom.document.body,
        (node) => getReactProps(node)?.title === 'chat.textSelection.actions.copy',
      )).toBeNull();
    } finally {
      const mountedRoot = root;
      if (mountedRoot) {
        await act(async () => {
          mountedRoot.unmount();
        });
      }
      dom.restore();
    }
  });
});
