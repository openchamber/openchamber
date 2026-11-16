import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { MarkdownWindow } from '@/components/chat/markdown/markdownWindow';
import { I18nProvider } from '@/lib/i18n';
import { MarkdownPreviewOutline } from './MarkdownPreviewOutline';

let root: Root;
let host: HTMLElement;
let scrolled: string[];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  const browser = new Window({ url: 'http://localhost' });
  scrolled = [];
  // cmdk scrolls its active item; only heading scrolls are the outline's.
  browser.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
    if (/^H[1-6]$/.test(this.tagName)) scrolled.push(this.textContent ?? '');
  };
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    Node: browser.Node,
    MutationObserver: browser.MutationObserver,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    PointerEvent: browser.PointerEvent,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

function Harness({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  return (
    <I18nProvider>
      <div className="relative">
        <div ref={ref} tabIndex={-1}>
          <div data-markdown-content="">
            <h2>Install</h2>
            <p>text</p>
            <h3>From source</h3>
            <h2>Usage</h2>
          </div>
        </div>
        <MarkdownPreviewOutline containerRef={ref} open={open} onOpenChange={onOpenChange} />
      </div>
    </I18nProvider>
  );
}

const items = () => Array.from(host.querySelectorAll('[cmdk-item]'));

describe('MarkdownPreviewOutline', () => {
  test('draws nothing while closed', async () => {
    await act(async () => root.render(<Harness open={false} onOpenChange={() => {}} />));
    expect(items()).toHaveLength(0);
  });

  test('lists the headings in order, indented from the shallowest level', async () => {
    await act(async () => root.render(<Harness open onOpenChange={() => {}} />));
    expect(items().map((item) => item.textContent)).toEqual(['Install', 'From source', 'Usage']);
    expect(items().map((item) => item.querySelector('[data-heading-depth]')?.getAttribute('data-heading-depth'))).toEqual(['0', '1', '0']);
  });

  test('picking a heading scrolls to that heading and closes the panel', async () => {
    const changes: boolean[] = [];
    await act(async () => root.render(<Harness open onOpenChange={(open) => changes.push(open)} />));
    await act(async () => {
      items()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(scrolled).toEqual(['From source']);
    expect(changes).toEqual([false]);
  });

  test('Escape closes the panel', async () => {
    const changes: boolean[] = [];
    await act(async () => root.render(<Harness open onOpenChange={(open) => changes.push(open)} />));
    const input = host.querySelector('input')!;
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(changes).toEqual([false]);
  });

  test('a pointer press outside closes it, one on the toggle button does not', async () => {
    const changes: boolean[] = [];
    await act(async () => root.render(
      <>
        <button type="button" data-markdown-outline-toggle="" id="toggle">Outline</button>
        <button type="button" id="elsewhere">Elsewhere</button>
        <Harness open onOpenChange={(open) => changes.push(open)} />
      </>,
    ));
    const press = (id: string) => host.querySelector(`#${id}`)!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await act(async () => { press('toggle'); });
    expect(changes).toEqual([]);
    await act(async () => { press('elsewhere'); });
    expect(changes).toEqual([false]);
  });

  test('takes the block hold once the document is windowed, even when it mounts after the panel opened', async () => {
    function Late({ show }: { show: boolean }) {
      const ref = React.useRef<HTMLDivElement | null>(null);
      return (
        <I18nProvider>
          <div style={{ overflowY: 'auto' }}>
            <div ref={ref}>{show ? <div data-markdown-content=""><h2>Late</h2></div> : null}</div>
          </div>
          <MarkdownPreviewOutline containerRef={ref} open onOpenChange={() => {}} />
        </I18nProvider>
      );
    }
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    await act(async () => root.render(<Late show={false} />));
    expect(items()).toHaveLength(0);
    await act(async () => root.render(<Late show />));
    await settle();
    expect(items().map((item) => item.textContent)).toEqual(['Late']);

    // The renderer attaches its window after its content is on screen.
    const content = host.querySelector<HTMLElement>('[data-markdown-content]');
    expect(content).not.toBeNull();
    const blockWindow = new MarkdownWindow();
    blockWindow.attach(content!);
    expect(blockWindow.isRendered(10)).toBe(false);
    await act(async () => { content!.append(document.createElement('p')); });
    await settle();
    expect(blockWindow.isRendered(10)).toBe(true);
    blockWindow.detach();
  });

  test('says so when the document has no headings', async () => {
    function Empty() {
      const ref = React.useRef<HTMLDivElement | null>(null);
      return (
        <I18nProvider>
          <div ref={ref}><div data-markdown-content=""><p>only text</p></div></div>
          <MarkdownPreviewOutline containerRef={ref} open onOpenChange={() => {}} />
        </I18nProvider>
      );
    }
    await act(async () => root.render(<Empty />));
    expect(host.textContent).toContain('No headings in this document');
  });
});
