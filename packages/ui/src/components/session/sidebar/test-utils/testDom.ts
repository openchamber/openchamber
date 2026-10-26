class ElementStub implements Partial<Element> {
  nodeType = 1;
}

type DocumentStub = {
  nodeType: number;
  defaultView: typeof globalThis;
  activeElement: null;
  addEventListener: () => void;
  removeEventListener: () => void;
  querySelectorAll: () => never[];
  createElement: (tagName: string) => Element;
  createElementNS: (namespace: string, tagName: string) => Element;
  createTextNode: (text: string) => Text;
  documentElement?: Element;
  body?: Element;
};

type GlobalValue = typeof globalThis | typeof ElementStub | DocumentStub | Storage | boolean;

export const installHookTestDom = (storage?: Storage) => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: GlobalValue) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const createElement = (ownerDocument: DocumentStub): Element => {
    // SAFETY: React only uses these DOM identity, child-list, and listener methods in this test fixture.
    const element = Object.create(ElementStub.prototype) as Element;
    Object.assign(element, {
      nodeType: 1,
      tagName: 'DIV',
      nodeName: 'DIV',
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      ownerDocument,
      parentNode: null,
      parentElement: null,
      childNodes: [],
      style: { setProperty: () => undefined, getPropertyValue: () => '' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      appendChild<T extends Node>(child: T): T {
        // SAFETY: every fixture child is a Node supplied by React's host renderer.
        (this.childNodes as Node[]).push(child);
        return child;
      },
      insertBefore<T extends Node>(child: T): T {
        // SAFETY: every fixture child is a Node supplied by React's host renderer.
        (this.childNodes as Node[]).push(child);
        return child;
      },
      removeChild<T extends Node>(child: T): T {
        // SAFETY: this fixture stores only Node children from React's host renderer.
        const children = this.childNodes as Node[];
        const index = children.indexOf(child);
        if (index >= 0) children.splice(index, 1);
        return child;
      },
      setAttribute: () => undefined,
      removeAttribute: () => undefined,
      getAttribute: () => null,
      hasAttribute: () => false,
      contains: () => false,
      compareDocumentPosition: () => 0,
    });
    return element;
  };
  const documentStub: DocumentStub = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelectorAll: () => [],
    createElement: () => createElement(documentStub),
    createElementNS: () => createElement(documentStub),
    // SAFETY: React only checks the text node identity field in this fixture.
    createTextNode: () => ({ nodeType: 3 } as Text),
  };
  // SAFETY: React's test renderer only inspects this fixture's DOM identity fields and listeners.
  const container = createElement(documentStub);
  Object.assign(documentStub, { documentElement: container, body: container });
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  if (storage) setGlobal('localStorage', storage);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
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
