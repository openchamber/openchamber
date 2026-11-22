import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { MarkdownSvg } from './MarkdownSvg';

let root: Root;
let host: HTMLElement;
let dom: Window;

beforeEach(() => {
  dom = new Window({ url: 'https://app.test' });
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); });

const draw = (code: string) => act(() => { root.render(<MarkdownSvg code={code} language="svg" isIncomplete={false} />); });

describe('MarkdownSvg', () => {
  test('draws the source as a data image', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>a&b</text></svg>';
    draw(source);
    const img = host.querySelector('img');
    expect(img).not.toBeNull();
    const src = img?.getAttribute('src') ?? '';
    expect(src.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(src.slice(src.indexOf(',') + 1))).toBe(source);
    expect(host.querySelector('svg')).toBeNull();
  });

  test('keeps the source on the wrapper for selection copy', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>a&b</text></svg>';
    draw(source);
    expect(host.querySelector('[data-streamdown="svg-block"]')?.getAttribute('data-oc-svg-source')).toBe(source);
  });
});
