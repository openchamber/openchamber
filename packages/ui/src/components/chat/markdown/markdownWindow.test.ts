import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { holdMarkdownBlocks, MarkdownWindow } from './markdownWindow';

// Twenty blocks of 100 px in a 100 px scroller; a block's box follows the
// scroll offset.
describe('markdown window', () => {
  let dom: Window;
  let scroller: HTMLElement;
  let container: HTMLElement;
  let wrappers: HTMLElement[];
  let paragraphs: HTMLElement[];
  let top: number;
  let blockWindow: MarkdownWindow;

  beforeEach(() => {
    dom = new Window();
    Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, DOMRect: dom.DOMRect, Event: dom.Event, Element: dom.Element, HTMLMediaElement: dom.HTMLMediaElement });
    top = 0;
    scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
    container = document.createElement('div');
    container.setAttribute('data-markdown-content', '');
    const root = document.createElement('div');
    root.setAttribute('data-oc-streamdown', '');
    wrappers = [];
    paragraphs = [];
    for (let index = 0; index < 20; index += 1) {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-oc-block-index', String(index));
      wrapper.setAttribute('data-oc-block-key', `${index}:10`);
      const paragraph = document.createElement('p');
      wrapper.append(paragraph);
      paragraphs.push(paragraph);
      wrapper.getBoundingClientRect = () => new DOMRect(0, index * 100 - top, 400, 100);
      root.append(wrapper);
      wrappers.push(wrapper);
    }
    container.append(root);
    scroller.append(container);
    document.body.append(scroller);
    blockWindow = new MarkdownWindow();
  });

  afterEach(async () => {
    blockWindow.detach();
    await dom.happyDOM.close();
  });

  const rendered = () => wrappers.map((_, index) => index).filter((index) => blockWindow.isRendered(index));

  test('renders the first blocks before it is attached, then those within a viewport of the visible part', () => {
    expect(rendered().length).toBe(20);
    blockWindow.attach(container);
    blockWindow.update();
    expect(rendered()).toEqual([0, 1, 2]);
    top = 1000;
    blockWindow.update();
    expect(rendered()).toEqual([8, 9, 10, 11, 12]);
  });

  test('measures a block as it leaves, with the edge margins its box then carries', () => {
    blockWindow.attach(container);
    blockWindow.update();
    paragraphs[0].style.marginBlockStart = '12px';
    top = 1000;
    blockWindow.update();
    expect(blockWindow.size('0:10')).toEqual({ height: 100, start: 12, end: 0 });
  });

  test('holds every block, or one, until released', () => {
    blockWindow.attach(container);
    blockWindow.update();
    const all = holdMarkdownBlocks(container);
    expect(rendered().length).toBe(20);
    all();
    expect(rendered()).toEqual([0, 1, 2]);
    const one = holdMarkdownBlocks(wrappers[15], { block: wrappers[15] });
    expect(rendered()).toEqual([0, 1, 2, 15]);
    one();
    expect(rendered()).toEqual([0, 1, 2]);
  });

  test('keeps a block whose disclosure the reader toggled mounted', () => {
    blockWindow.attach(container);
    blockWindow.update();
    const summary = document.createElement('summary');
    paragraphs[1].append(summary);
    summary.dispatchEvent(new Event('click', { bubbles: true }));
    top = 1000;
    blockWindow.update();
    expect(rendered()).toEqual([1, 8, 9, 10, 11, 12]);
  });

  test('mounts every block for a selection that crosses one not mounted, until it collapses', () => {
    blockWindow.attach(container);
    blockWindow.update();
    const selection = document.getSelection();
    selection?.setBaseAndExtent(wrappers[0], 0, wrappers[15], 0);
    document.dispatchEvent(new Event('selectionchange'));
    expect(rendered().length).toBe(20);
    selection?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(rendered()).toEqual([0, 1, 2]);
  });

  test('keeps the blocks a selection reached while it lasts', async () => {
    blockWindow.attach(container);
    blockWindow.update();
    const selection = document.getSelection();
    selection?.setBaseAndExtent(wrappers[0], 0, wrappers[1], 0);
    document.dispatchEvent(new Event('selectionchange'));
    top = 1000;
    blockWindow.update();
    expect(rendered()).toEqual([0, 1, 2, 8, 9, 10, 11, 12]);
    selection?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(rendered()).toEqual([8, 9, 10, 11, 12]);
  });
});
