import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { VirtualizedFile, Virtualizer } from '@pierre/diffs';

import { useFilePreviewScrollPosition } from './useFilePreviewScrollPosition';

type RestorePreview = ReturnType<typeof useFilePreviewScrollPosition>['restore'];

class MeasuredPreviewFile extends VirtualizedFile {
  lineTop = 1000;

  override getLinePosition() {
    return { top: this.lineTop, height: 20 };
  }

  override getNumericScrollAnchor() {
    return { lineNumber: 51, top: this.lineTop };
  }
}

function Preview({ positionKey, element, onReady }: {
  positionKey: string | null;
  element: HTMLElement;
  onReady: (restore: RestorePreview) => void;
}) {
  const { setScroller, restore } = useFilePreviewScrollPosition(positionKey);
  useLayoutEffect(() => {
    setScroller(element);
    return () => setScroller(null);
  }, [element, setScroller]);
  useLayoutEffect(() => onReady(restore), [onReady, restore]);
  return null;
}

describe('file preview scroll positions', () => {
  let windowInstance: Window;
  let root: Root;
  let scroller: HTMLDivElement;
  let content: HTMLDivElement;
  let height: number;
  let top: number;
  let left: number;
  let restore: RestorePreview;
  let prefix: string;
  let sequence = 0;
  const onReady = (callback: RestorePreview) => { restore = callback; };

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      DOMRect: windowInstance.DOMRect,
      MutationObserver: windowInstance.MutationObserver,
      ResizeObserver: windowInstance.ResizeObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const host = document.createElement('div');
    scroller = document.createElement('div');
    content = document.createElement('div');
    scroller.append(content);
    document.body.append(host, scroller);
    root = createRoot(host);
    height = 2000;
    top = 0;
    left = 0;
    prefix = `preview-test-${sequence++}`;
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollTop: {
        get: () => top,
        set: (value: number) => { top = Math.max(0, Math.min(value, height - 100)); },
      },
      scrollLeft: {
        get: () => left,
        set: (value: number) => { left = Math.max(0, Math.min(value, 500)); },
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
  });

  const render = async (key: string | null) => {
    await act(async () => {
      root.render(<Preview positionKey={key === null ? null : `${prefix}:${key}`} element={scroller} onReady={onReady} />);
    });
  };
  const scroll = (nextTop: number, nextLeft = 0) => {
    scroller.scrollTop = nextTop;
    scroller.scrollLeft = nextLeft;
    scroller.dispatchEvent(new Event('scroll'));
  };

  test('keeps positions independent across files, runtimes, modes and surfaces', async () => {
    const keys = ['runtime-a:file-a:code', 'runtime-a:file-b:code', 'runtime-b:file-a:code', 'runtime-a:file-a:markdown', 'runtime-a:file-a:code:fullscreen'];
    for (const [index, key] of keys.entries()) {
      await render(key);
      expect(top).toBe(0);
      scroll((index + 1) * 150, (index + 1) * 20);
    }
    for (const [index, key] of keys.entries()) {
      await render(key);
      expect(top).toBe((index + 1) * 150);
      expect(left).toBe((index + 1) * 20);
    }
  });

  test('ignores scroll collapse during loading and restores after a full view unmount', async () => {
    await render('file');
    scroll(900, 120);
    await render(null);
    scroll(0);
    await act(async () => root.render(null));
    await render('file');
    expect(top).toBe(900);
    expect(left).toBe(120);
  });

  test('waits for asynchronous code rendering without saving its clamped offset', async () => {
    await render('code');
    scroll(1200);
    await render(null);
    height = 200;
    await render('code');
    expect(top).toBe(100);
    scroll(100);
    height = 2000;
    restore();
    expect(top).toBe(1200);
    scroll(700);
    restore();
    expect(top).toBe(700);
    await render(null);
    await render('code');
    expect(top).toBe(700);
  });

  test('restores when lazy Markdown content mounts', async () => {
    await render('markdown');
    scroll(1000);
    await render(null);
    height = 100;
    await render('markdown');
    expect(top).toBe(0);
    height = 2000;
    content.append(document.createElement('p'));
    await windowInstance.happyDOM.waitUntilComplete();
    expect(top).toBe(1000);
  });

  test('stops pending restoration when the user starts scrolling', async () => {
    await render('markdown');
    scroll(1000);
    await render(null);
    height = 300;
    await render('markdown');
    scroller.dispatchEvent(new Event('wheel'));
    scroll(80);
    height = 2000;
    restore();
    expect(top).toBe(80);
    await render(null);
    await render('markdown');
    expect(top).toBe(80);
  });

  test('disconnects late content callbacks when leaving the file', async () => {
    await render('first');
    scroll(1000);
    await render(null);
    height = 200;
    await render('first');
    await render('second');
    scroll(50);
    height = 2000;
    content.append(document.createElement('p'));
    await windowInstance.happyDOM.waitUntilComplete();
    restore();
    expect(top).toBe(50);
  });

  test('restores the same virtualized line after Pierre reconciles different height estimates', async () => {
    const file = new MeasuredPreviewFile({}, new Virtualizer());
    const node = document.createElement('div');
    const line = document.createElement('div');
    line.dataset.line = '';
    line.dataset.lineIndex = '50';
    node.attachShadow({ mode: 'open' }).append(line);
    content.append(node);
    line.getBoundingClientRect = () => new DOMRect(0, file.lineTop - top + 8, 100, 20);

    await render('virtual');
    scroll(1000);
    restore(node, file);
    await Promise.resolve();
    expect(line.getBoundingClientRect().top).toBe(8);

    await render(null);
    scroll(0);
    await render('virtual');
    restore(node, file);
    // onPostRender runs before Pierre's synchronous height reconciliation.
    file.lineTop = 1500;
    scroll(800);
    await Promise.resolve();
    expect(top).toBe(1500);
    expect(line.getBoundingClientRect().top).toBe(8);
    file.cleanUp();
  });
});
