import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { GhosttyTerminalSurface } from './surface';

describe('terminal soft-keyboard backspace', () => {
  let dom: Window;
  let surface: GhosttyTerminalSurface;
  let sent: string[];

  beforeEach(async () => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom, document: dom.document, navigator: dom.navigator,
      ResizeObserver: dom.ResizeObserver, KeyboardEvent: dom.KeyboardEvent,
      InputEvent: dom.InputEvent, CompositionEvent: dom.CompositionEvent,
    });
    // These tests exercise DOM input and the real WASM encoder, without painting.
    Object.defineProperty(dom.HTMLCanvasElement.prototype, 'getContext', { value: () => ({
      fillRect() {},
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 }),
    }) });
    Object.defineProperty(dom.document, 'fonts', { value: {
      load: async () => [], addEventListener() {}, removeEventListener() {},
    } });
    sent = [];
    surface = await GhosttyTerminalSurface.create(document.createElement('div'), {
      visible: false,
      labels: { input: 'Terminal', scrollbar: 'Scrollback' },
      theme: {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      },
      onData: (data) => sent.push(data), onResize() {},
    });
  });

  afterEach(() => {
    surface?.dispose();
    dom.happyDOM.abort();
  });

  function deleteBackward(cancelable = true) {
    const before = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward', data: null, cancelable,
    });
    surface.input.dispatchEvent(before);
    if (!before.defaultPrevented) {
      surface.input.value = '';
      surface.input.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward', data: null,
      }));
    }
    return before;
  }

  test('handles Android Process/229 followed by deletion on an empty textarea', () => {
    surface.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229 }));
    const before = deleteBackward();
    expect(before.defaultPrevented).toBe(true);
    expect(sent).toEqual(['\x7f']);
    expect(surface.input.value).toBe('');
  });

  test('handles repeated deletes without requiring text in the textarea', () => {
    deleteBackward();
    deleteBackward();
    expect(sent).toEqual(['\x7f', '\x7f']);
  });

  test('uses input when beforeinput is not cancelable', () => {
    deleteBackward(false);
    expect(sent).toEqual(['\x7f']);
  });

  test('handles an input-only deletion without forwarding stale textarea contents', () => {
    surface.input.value = 'copied output';
    surface.input.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward' }));
    expect(sent).toEqual(['\x7f']);
    expect(surface.input.value).toBe('');
  });

  test('leaves deletion of an uncommitted IME candidate to the browser', () => {
    surface.input.dispatchEvent(new CompositionEvent('compositionstart'));
    surface.input.value = 'ni';
    const before = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward', cancelable: true,
    });
    surface.input.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    surface.input.value = 'n';
    surface.input.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward' }));
    expect(sent).toEqual([]);
    surface.input.dispatchEvent(new CompositionEvent('compositionend', { data: 'n' }));
    expect(sent).toEqual(['n']);
    deleteBackward();
    expect(sent).toEqual(['n', '\x7f']);
  });

  test('honors the event composition flag even without compositionstart', () => {
    for (const type of ['beforeinput', 'input']) {
      surface.input.dispatchEvent(new InputEvent(type, {
        inputType: 'deleteContentBackward', isComposing: true, cancelable: true,
      }));
    }
    expect(sent).toEqual([]);
  });

  test('desktop Backspace prevents the browser edit and sends once', () => {
    const key = new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', cancelable: true });
    surface.input.dispatchEvent(key);
    if (!key.defaultPrevented) deleteBackward();
    surface.input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace' }));
    expect(key.defaultPrevented).toBe(true);
    expect(sent).toEqual(['\x7f']);
  });

  test('uses the active Kitty keyboard protocol, including release reporting', () => {
    surface.write('\x1b[>11u');
    deleteBackward();
    expect(sent).toEqual(['\x1b[127u\x1b[127;1:3u']);
  });

  test('removes the deletion listener on disposal', () => {
    surface.dispose();
    const before = deleteBackward();
    expect(before.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });
});
