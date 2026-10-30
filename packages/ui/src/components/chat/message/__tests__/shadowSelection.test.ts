import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { resolveShadowSelectionRange } from '../shadowSelection';

const DOM_GLOBAL_NAMES = ['window', 'document', 'Element'] as const;

describe('resolveShadowSelectionRange', () => {
  let win: Window;
  let restoreGlobals: () => void;

  beforeEach(() => {
    win = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const name of DOM_GLOBAL_NAMES) {
      Object.defineProperty(globalThis, name, { value: name === 'document' ? win.document : win[name], configurable: true, writable: true });
    }
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
  });

  afterEach(() => {
    restoreGlobals();
    void win.happyDOM.close();
  });

  // A selection inside a shadow root reaches the document as a collapsed range
  // over the host's light-DOM container, which has no client rects.
  const stageShadowSelection = (shadowText: string, selectedText = shadowText) => {
    const wrapper = document.createElement('div');
    const host = document.createElement('diffs-container');
    wrapper.appendChild(host);
    document.body.appendChild(wrapper);

    const shadow = host.attachShadow({ mode: 'open' });
    const line = document.createElement('div');
    line.textContent = shadowText;
    shadow.appendChild(line);

    const range = document.createRange();
    range.setStart(line.firstChild!, 0);
    range.setEnd(line.firstChild!, shadowText.length);

    Object.defineProperty(shadow, 'getSelection', {
      value: () => ({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => selectedText,
        getRangeAt: () => range,
      }),
      configurable: true,
    });

    const documentRange = document.createRange();
    documentRange.setStart(wrapper, 0);
    documentRange.setEnd(wrapper, 0);

    return { shadow, range, documentRange };
  };

  test('reads the geometry from the host selection the document range only points at', () => {
    const { range, documentRange } = stageShadowSelection('line one\nline two');

    expect(resolveShadowSelectionRange(documentRange, 'line one\nline two')).toBe(range);
  });

  test('ignores a host selection that is not the one the document reports', () => {
    const { documentRange } = stageShadowSelection('line one\nline two', 'another fragment');

    expect(resolveShadowSelectionRange(documentRange, 'line one\nline two')).toBeNull();
  });

  test('stays null when the host exposes no selection (Firefox)', () => {
    const { shadow, documentRange } = stageShadowSelection('line one');
    Object.defineProperty(shadow, 'getSelection', { value: undefined });

    expect(resolveShadowSelectionRange(documentRange, 'line one')).toBeNull();
  });

  test('leaves an ordinary text selection alone', () => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'plain message text';
    document.body.appendChild(paragraph);
    const range = document.createRange();
    range.setStart(paragraph.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 5);

    expect(resolveShadowSelectionRange(range, 'plain')).toBeNull();
  });
});
