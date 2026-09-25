import { describe, expect, test } from 'bun:test';

import { attachFileRefClickGuard, FILE_REFERENCE_LINK_SELECTOR } from './fileRefClickGuard';

class TestElement {
  parent: TestElement | null = null;
  attributes = new Map<string, string>();

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  closest(selector: string): TestElement | null {
    return findClosestTestElement(this, selector);
  }
}
class TestHTMLElement extends TestElement {}
class TestHTMLAnchorElement extends TestHTMLElement {
  constructor(private readonly rawHref: string, parent: TestElement | null = null) {
    super();
    this.parent = parent;
    this.setAttribute('href', rawHref);
  }
}
Object.assign(globalThis, { Element: TestElement, HTMLElement: TestHTMLElement, HTMLAnchorElement: TestHTMLAnchorElement });

const findClosestTestElement = (start: TestElement | null, selector: string): TestElement | null => {
  for (let current = start; current !== null; current = current.parent) {
    if (selector === 'a[href]' && current instanceof TestHTMLAnchorElement) return current;
    if (selector === FILE_REFERENCE_LINK_SELECTOR && current.getAttribute('data-openchamber-file-link') === 'true') return current;
  }
  return null;
};

class TestContainer {
  listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: (event: MouseEvent) => void): void {
    // SAFETY: dispatch constructs the click-shaped fields the production listener reads.
    this.listeners.set(type, (event) => listener(event as MouseEvent));
  }

  removeEventListener(type: string, listener: (event: MouseEvent) => void): void {
    void listener;
    this.listeners.delete(type);
  }

  dispatchClick(target: TestElement): Event {
    const event = new Event('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: target });
    this.listeners.get('click')?.(event);
    return event;
  }
}

const makeAnchor = (href: string, annotated = false): TestHTMLAnchorElement => {
  const anchor = new TestHTMLAnchorElement(href);
  if (annotated) anchor.setAttribute('data-openchamber-file-link', 'true');
  return anchor;
};

const setup = () => {
  const container = new TestContainer();
  const openedHrefs: string[] = [];
  const cleanup = attachFileRefClickGuard(container, {
    hrefCandidate: (anchor) => {
      const href = anchor.getAttribute('href')?.trim() ?? '';
      if (!href) return null;
      return href.startsWith('file:') || href.startsWith('src/') ? href : null;
    },
    isResolvable: (raw) => raw.length > 0,
    openFileReference: (element) => openedHrefs.push(element.getAttribute('href') ?? ''),
  });
  return { container, openedHrefs, cleanup };
};

describe('file reference click guard', () => {
  test('routes a pre-annotation click on an href file reference to the file viewer', () => {
    const { container, openedHrefs } = setup();
    const link = makeAnchor('src/index.ts');

    const event = container.dispatchClick(link);

    expect(event.defaultPrevented).toBe(true);
    expect(openedHrefs).toEqual(['src/index.ts']);
  });

  test('routes a pre-annotation file:// href click without opening a window', () => {
    const { container, openedHrefs } = setup();
    const link = makeAnchor('file:///repo/src/main.ts');

    const event = container.dispatchClick(link);

    expect(event.defaultPrevented).toBe(true);
    expect(openedHrefs).toEqual(['file:///repo/src/main.ts']);
  });

  test('finds the enclosing anchor when the click lands on a child element', () => {
    const { container, openedHrefs } = setup();
    const link = makeAnchor('src/index.ts');
    const child = new TestElement();
    child.parent = link;

    const event = container.dispatchClick(child);

    expect(event.defaultPrevented).toBe(true);
    expect(openedHrefs).toEqual(['src/index.ts']);
  });

  test('leaves non-file hrefs alone so their own link handling applies', () => {
    const { container, openedHrefs } = setup();
    const external = makeAnchor('https://example.com');

    const event = container.dispatchClick(external);

    expect(event.defaultPrevented).toBe(false);
    expect(openedHrefs).toEqual([]);
  });

  test('still intercepts annotated file references regardless of their href', () => {
    const { container, openedHrefs } = setup();
    const link = makeAnchor('https://external.example/raw', true);

    const event = container.dispatchClick(link);

    expect(event.defaultPrevented).toBe(true);
    expect(openedHrefs).toEqual(['https://external.example/raw']);
  });

  test('removes the click listener on cleanup', () => {
    const { container, openedHrefs, cleanup } = setup();
    cleanup();

    const event = container.dispatchClick(makeAnchor('src/index.ts'));

    expect(event.defaultPrevented).toBe(false);
    expect(openedHrefs).toEqual([]);
  });
});