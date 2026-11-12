import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

test('preview search preserves text nodes, isolates highlights and refreshes current ranges', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement, Element: dom.Element, Text: dom.Text, Node: dom.Node,
    NodeFilter: dom.NodeFilter, MutationObserver: dom.MutationObserver, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
    CSS: dom.CSS, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // Happy DOM provides real text nodes and Ranges, but has no highlight painter.
  const highlights = new Map<string, Set<Range>>();
  class TestHighlight extends Set<Range> {
    priority = 0;
    constructor(...ranges: Range[]) { super(ranges); }
  }
  Object.defineProperty(dom, 'Highlight', { configurable: true, value: TestHighlight });
  Object.defineProperty(dom, 'CSS', { configurable: true, value: { ...dom.CSS, highlights } });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { MarkdownPreviewSearch } = await import('./MarkdownPreviewSearch');
  const host = document.createElement('div');
  const focusTarget = document.createElement('button');
  document.body.append(focusTarget);
  focusTarget.focus();
  document.body.append(host);
  const root = createRoot(host);
  const first = React.createRef<HTMLDivElement>();
  const second = React.createRef<HTMLDivElement>();
  let open = true;
  let content = 'Alpha alpha';
  let showSecond = true;
  const render = () => act(async () => root.render(<I18nProvider>
    <div ref={first} tabIndex={-1}><p>{content}</p><svg><text>alpha</text></svg><script>alpha</script><style>alpha</style></div>
    <MarkdownPreviewSearch containerRef={first} open={open} focusNonce={0} onOpenChange={(value) => { open = value; }} />
    {showSecond && <><div ref={second}><p>Alpha</p></div>
      <MarkdownPreviewSearch containerRef={second} open focusNonce={0} onOpenChange={() => {}} /></>}
  </I18nProvider>));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)); });
  const typeQuery = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };
  try {
    await render();
    const text = first.current?.querySelector('p')?.firstChild;
    const inputs = host.querySelectorAll('input');
    await typeQuery(inputs[0], 'alpha');
    expect(first.current?.querySelector('p')?.firstChild).toBe(text);
    expect(first.current?.querySelector('mark')).toBeNull();
    expect(host.textContent).toContain('1/2');
    expect(highlights.size).toBe(2);
    const currentName = [...highlights.keys()].find((name) => name.endsWith('-current'))!;
    expect([...highlights.values()].map((ranges) => [...ranges].map((range) => range.toString()))).toEqual([['Alpha', 'alpha'], ['Alpha']]);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Next match"]')?.click());
    expect(host.textContent).toContain('2/2');
    expect(highlights.get(currentName)?.values().next().value?.startOffset).toBe(6);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')?.click());
    expect(host.textContent).toContain('1/2');
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Previous match"]')?.click());
    expect(host.textContent).toContain('2/2');
    await typeQuery(inputs[1], 'alpha');
    expect(highlights.size).toBe(4);
    content = 'Alpha alpha alpha';
    await render();
    await settle();
    expect(host.textContent).toContain('2/3');
    expect(highlights.get(currentName)?.values().next().value?.toString()).toBe('alpha');
    showSecond = false;
    await render();
    expect(highlights.size).toBe(2);
    await typeQuery(inputs[0], '');
    expect(highlights.size).toBe(0);
    const updatedText = first.current?.querySelector('p')?.firstChild;
    await typeQuery(inputs[0], 'alpha');
    open = false;
    await render();
    expect(highlights.size).toBe(0);
    expect(first.current?.querySelector('p')?.firstChild).toBe(updatedText);
    open = true;
    await render();
    await settle();
    expect(host.textContent).toContain('1/3');
    Reflect.deleteProperty(dom, 'Highlight');
    await typeQuery(host.querySelector('input')!, 'Alpha');
    expect(host.textContent).toContain('1/3');
    expect(highlights.size).toBe(0);
    expect(first.current?.querySelector('p')?.firstChild).toBe(updatedText);
    await act(async () => host.querySelector('input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await render();
    expect(host.querySelector('input')).toBeNull();
    expect(document.activeElement).toBe(focusTarget);

    const { findPreviewRanges, scrollPreviewRangeIntoView } = await import('./markdownPreviewFind');
    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    scroller.style.overflowX = 'auto';
    scroller.style.overflowY = 'auto';
    scroller.innerHTML = '<pre>alpha</pre>';
    document.body.append(scroller);
    const range = findPreviewRanges(scroller, 'alpha')[0];
    Object.defineProperty(range, 'getBoundingClientRect', { value: () => ({ top: 140, bottom: 160, left: 20, right: 50 }) });
    Object.defineProperty(scroller, 'getBoundingClientRect', { value: () => ({ top: 0, bottom: 100, left: 0, right: 100 }) });
    Object.defineProperty(scroller, 'clientHeight', { value: 100 });
    Object.defineProperty(scroller, 'clientWidth', { value: 100 });
    const scrolls: ScrollToOptions[] = [];
    Object.defineProperty(scroller, 'scrollBy', { value: (options: ScrollToOptions) => scrolls.push(options) });
    scrollPreviewRangeIntoView(scroller, range);
    expect(scrolls).toEqual([{ left: 0, top: 60 }]);
  } finally {
    await act(async () => root.unmount());
    expect(highlights.size).toBe(0);
    dom.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
