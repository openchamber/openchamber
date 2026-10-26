import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { GhosttyTerminalSurface } from './surface';

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';
const DEL = '\x7f';

let dom: Window | null = null;
let surface: GhosttyTerminalSurface | null = null;

afterEach(() => {
  surface?.dispose();
  surface = null;
  dom?.happyDOM.abort();
  dom = null;
});

/** A real surface with the real WebAssembly encoder; painting is stubbed out. */
async function createSurface(userAgent: string) {
  const happyWindow = new Window({ url: 'http://localhost/' });
  dom = happyWindow;
  Object.defineProperty(happyWindow.navigator, 'userAgent', { value: userAgent });
  Object.defineProperty(happyWindow.HTMLCanvasElement.prototype, 'getContext', {
    value: () => ({
      fillRect() {},
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 }),
    }),
  });
  Object.defineProperty(happyWindow.document, 'fonts', {
    value: { load: async () => [], add() {}, addEventListener() {}, removeEventListener() {} },
  });
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    ResizeObserver: happyWindow.ResizeObserver,
    KeyboardEvent: happyWindow.KeyboardEvent,
    InputEvent: happyWindow.InputEvent,
    CompositionEvent: happyWindow.CompositionEvent,
  });
  const sent: string[] = [];
  surface = await GhosttyTerminalSurface.create(document.createElement('div'), {
    visible: false,
    labels: { input: 'Terminal input', scrollbar: 'Terminal scrollback' },
    theme: {
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
    },
    onData: (data) => sent.push(data),
    onResize() {},
  });
  const field = surface.input;
  const key = (type: 'keydown' | 'keyup', init: { key: string; code: string; keyCode: number }) => {
    const event = new KeyboardEvent(type, { ...init, cancelable: true });
    field.dispatchEvent(event);
    return event;
  };
  /**
   * What Chrome fires after it changed the field: the value is already the
   * result of the edit, and the caret sits after the inserted text.
   */
  const edited = (value: string, init: InputEventInit, caret = value.length) => {
    field.value = value;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new InputEvent('input', init));
  };
  const composition = (type: 'compositionstart' | 'compositionend', data: string) => {
    field.dispatchEvent(new CompositionEvent(type, { data }));
  };
  return { sent, field, key, edited, composition, write: (data: string) => surface?.write(data) };
}

// Sequences recorded on an Android 15 emulator with Gboard 14.2, Chrome 124 and Chromium 158.
const IME_KEY = { key: 'Unidentified', code: '', keyCode: 229 };
const GBOARD_DEL_KEY = { key: 'Backspace', code: '', keyCode: 8 };

describe('soft keyboard Backspace on Android', () => {
  test('keeps one space before the caret so the keyboard always has something to delete', async () => {
    const { field } = await createSurface(ANDROID_UA);
    expect(field.value).toBe(' ');
    expect(field.selectionStart).toBe(1);
  });

  test('a Backspace Gboard makes by deleting its own typing sends one DEL', async () => {
    const { sent, field, key, edited } = await createSurface(ANDROID_UA);
    for (let press = 0; press < 3; press += 1) {
      key('keydown', IME_KEY);
      edited('', { inputType: 'deleteContentBackward', data: null });
      key('keyup', IME_KEY);
    }
    expect(sent).toEqual([DEL, DEL, DEL]);
    expect(field.value).toBe(' ');
  });

  test('the sequence from the issue report sends one DEL and leaves beforeinput uncancelled', async () => {
    const { sent, field, key, edited } = await createSurface(ANDROID_UA);
    key('keydown', { key: 'Process', code: '', keyCode: 229 });
    const before = new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: true });
    field.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual([DEL]);
  });

  test('a Backspace key without a code sends one DEL through the edit it makes', async () => {
    const { sent, key, edited } = await createSurface(ANDROID_UA);
    const press = key('keydown', GBOARD_DEL_KEY);
    // Nothing to encode, so the browser keeps its default and deletes the space.
    expect(press.defaultPrevented).toBe(false);
    edited('', { inputType: 'deleteContentBackward', data: null });
    key('keyup', GBOARD_DEL_KEY);
    expect(sent).toEqual([DEL]);
  });

  test('a hardware Backspace with a code is encoded once and keeps the space', async () => {
    const { sent, field, key } = await createSurface(ANDROID_UA);
    const press = key('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    key('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    expect(press.defaultPrevented).toBe(true);
    expect(sent).toEqual([DEL]);
    expect(field.value).toBe(' ');
  });

  test('typed text, Enter and suggestions reach the shell without the space', async () => {
    const { sent, field, key, edited } = await createSurface(ANDROID_UA);
    for (const [value, data] of [[' l', 'l'], [' s', 's'], [' ach ', 'ach ']]) {
      key('keydown', IME_KEY);
      edited(value, { inputType: 'insertText', data });
      key('keyup', IME_KEY);
    }
    // Gboard's Enter: an empty IME key pair, then Enter, which Chrome inserts as a line break.
    key('keydown', IME_KEY);
    key('keyup', IME_KEY);
    key('keydown', { key: 'Enter', code: '', keyCode: 13 });
    edited(' \n', { inputType: 'insertLineBreak', data: null });
    expect(sent).toEqual(['l', 's', 'ach ', '\n']);
    expect(field.value).toBe(' ');
  });

  test('the next key puts the caret back after the space when a swipe moved it', async () => {
    const { field, key } = await createSurface(ANDROID_UA);
    // Gboard's space-bar swipe: the caret moves with no event.
    field.setSelectionRange(0, 0);
    key('keydown', GBOARD_DEL_KEY);
    expect(field.selectionStart).toBe(1);
  });

  test('text inserted in front of the space arrives without it, its own spaces kept', async () => {
    const { sent, edited } = await createSurface(ANDROID_UA);
    edited('x ', { inputType: 'insertText', data: 'x' }, 1);
    edited(' foo ', { inputType: 'insertText', data: ' foo' }, 4);
    expect(sent).toEqual(['x', ' foo']);
  });

  test('a copy with nothing selected keeps the space for the next Backspace', async () => {
    const { sent, field, edited } = await createSurface(ANDROID_UA);
    field.dispatchEvent(new Event('copy'));
    expect(field.value).toBe(' ');
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual([DEL]);
  });

  test('composition owns its own deletions and commits once without the space', async () => {
    const { sent, field, edited, composition } = await createSurface(ANDROID_UA);
    composition('compositionstart', '');
    edited(' ni', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
    edited(' n', { inputType: 'deleteContentBackward', data: null, isComposing: true });
    edited(' ni', { inputType: 'insertCompositionText', data: 'ni', isComposing: true });
    edited(' 你', { inputType: 'insertCompositionText', data: '你', isComposing: true });
    composition('compositionend', '你');
    // Chrome may echo the commit as a plain input right after compositionend.
    edited(' 你', { inputType: 'insertFromComposition', data: '你' });
    expect(sent).toEqual(['你']);
    expect(field.value).toBe(' ');
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual(['你', DEL]);
  });

  test('a program that asks for Kitty release events gets the release too', async () => {
    const { sent, edited, write } = await createSurface(ANDROID_UA);
    // Kitty flags: disambiguate, report events, report all keys as escape codes.
    write('\x1b[>11u');
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual(['\x1b[127u\x1b[127;1:3u']);
  });
});

describe('Backspace elsewhere', () => {
  test('desktop keeps an empty field and encodes the key once', async () => {
    const { sent, field, key } = await createSurface(MAC_UA);
    expect(field.value).toBe('');
    const press = key('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    key('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8 });
    expect(press.defaultPrevented).toBe(true);
    expect(sent).toEqual([DEL]);
  });

  test('desktop leaves deletion edits alone, as before', async () => {
    // Desktop IMEs delete inside their own composition; only Android rests on a space.
    const { sent, field, key, edited } = await createSurface(MAC_UA);
    key('keydown', { key: 'Process', code: '', keyCode: 229 });
    edited('', { inputType: 'deleteContentBackward', data: null });
    expect(sent).toEqual([]);
    expect(field.value).toBe('');
  });


  test('iOS keeps an empty field and plain typing', async () => {
    const { sent, field, edited } = await createSurface(IPHONE_UA);
    expect(field.value).toBe('');
    edited('a', { inputType: 'insertText', data: 'a' });
    expect(sent).toEqual(['a']);
  });
});
