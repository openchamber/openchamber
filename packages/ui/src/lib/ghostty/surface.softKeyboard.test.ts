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
async function createSurface(userAgent: string, platform?: string) {
  const happyWindow = new Window({ url: 'http://localhost/' });
  dom = happyWindow;
  Object.defineProperty(happyWindow.navigator, 'userAgent', { value: userAgent });
  if (platform) Object.defineProperty(happyWindow.navigator, 'platform', { value: platform });
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
  const key = (
    type: 'keydown' | 'keyup',
    init: { key: string; code: string; keyCode: number } & KeyboardEventInit,
  ) => {
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
  return { sent, field, key, edited, composition, terminal: surface, write: (data: string) => surface?.write(data) };
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

describe('macOS natural text editing chords', () => {
  test('Cmd+Backspace and Cmd+arrows send line bytes; other Super chords stand down', async () => {
    const { sent, key, write } = await createSurface(MAC_UA, 'MacIntel');
    write('\x1b[?1h');
    const del = key('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, metaKey: true });
    key('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, metaKey: true });
    expect(del.defaultPrevented).toBe(true);
    key('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, metaKey: true });
    key('keyup', { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, metaKey: true });
    key('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, metaKey: true, repeat: true });
    write('\x1b[>11u');
    key('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, metaKey: true });
    expect(sent).toEqual(['\x15', '\x01', '\x05']);
    write('\x1b[<u');
    // Every other Super chord keeps standing down for the app.
    const untouched = key('keydown', { key: 'b', code: 'KeyB', keyCode: 66, metaKey: true });
    key('keyup', { key: 'b', code: 'KeyB', keyCode: 66, metaKey: true });
    expect(untouched.defaultPrevented).toBe(false);
    expect(sent).toEqual(['\x15', '\x01', '\x05']);
  });
});

describe('viewport scroll chords', () => {
  test('Shift+PageUp scrolls the viewport and never reaches the pty', async () => {
    const { sent, key, write, terminal } = await createSurface(MAC_UA, 'Linux x86_64');
    write('line\r\n'.repeat(60));
    const before = terminal['core'].scrollbarState();
    expect(before).not.toBeNull();
    const press = key('keydown', { key: 'PageUp', code: 'PageUp', keyCode: 33, shiftKey: true });
    key('keyup', { key: 'PageUp', code: 'PageUp', keyCode: 33, shiftKey: true });
    expect(press.defaultPrevented).toBe(true);
    expect(sent).toEqual([]);
    expect(terminal['core'].scrollbarState()!.offset).toBeLessThan(before!.offset);
    // Unmodified PageUp still encodes for the pty, like in Ghostty.
    key('keydown', { key: 'PageUp', code: 'PageUp', keyCode: 33 });
    key('keyup', { key: 'PageUp', code: 'PageUp', keyCode: 33 });
    expect(sent).toEqual(['\x1b[5~']);
  });

  test('Cmd+Home and Cmd+PageDown claim the macOS stand-down to scroll', async () => {
    const { sent, key, write, terminal } = await createSurface(MAC_UA, 'MacIntel');
    write('line\r\n'.repeat(60));
    const home = key('keydown', { key: 'Home', code: 'Home', keyCode: 36, metaKey: true });
    key('keyup', { key: 'Home', code: 'Home', keyCode: 36, metaKey: true });
    expect(terminal['core'].scrollbarState()!.offset).toBe(0);
    const pageDown = key('keydown', { key: 'PageDown', code: 'PageDown', keyCode: 34, metaKey: true });
    key('keyup', { key: 'PageDown', code: 'PageDown', keyCode: 34, metaKey: true });
    expect(home.defaultPrevented).toBe(true);
    expect(pageDown.defaultPrevented).toBe(true);
    expect(terminal['core'].scrollbarState()!.offset).toBe(terminal['core'].scrollbarState()!.len);
    expect(sent).toEqual([]);
  });
});

describe('shell shortcut boundaries', () => {
  for (const signal of ['event', 'compositionstart', 'keyCode']) {
    for (const platform of ['MacIntel', 'Linux x86_64']) {
      test(`${platform} leaves ${signal} composition keys alone`, async () => {
        const { sent, key, write, composition, terminal } = await createSurface(MAC_UA, platform);
        write('line\r\n'.repeat(60));
        const before = terminal['core'].scrollbarState();
        if (signal === 'compositionstart') composition('compositionstart', '');
        const chords = platform === 'MacIntel'
          ? [
            { key: 'Backspace', code: 'Backspace', keyCode: 8, metaKey: true },
            { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, metaKey: true },
            { key: 'PageUp', code: 'PageUp', keyCode: 33, metaKey: true },
          ]
          : [{ key: 'PageUp', code: 'PageUp', keyCode: 33, shiftKey: true }];
        for (const chord of chords) {
          const init = { ...chord, isComposing: signal === 'event', ...(signal === 'keyCode' ? { keyCode: 229 } : {}) };
          expect(key('keydown', init).defaultPrevented).toBe(false);
          key('keyup', init);
        }
        expect(sent).toEqual([]);
        expect(terminal['core'].scrollbarState()).toEqual(before);
      });
    }
  }

  for (const mode of ['\x1b[?1049h', '\x1b[>1u', '\x1b[>11u']) {
    test(`macOS keeps app shortcuts unchanged in ${JSON.stringify(mode)}`, async () => {
      const { sent, key, write } = await createSurface(MAC_UA, 'MacIntel');
      write(mode);
      for (const name of ['Backspace', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
        const chord = { key: name, code: name, keyCode: 0, metaKey: true };
        expect(key('keydown', chord).defaultPrevented).toBe(false);
        key('keyup', chord);
      }
      expect(sent).toEqual([]);
      write(mode === '\x1b[?1049h' ? '\x1b[?1049l' : '\x1b[<u');
      key('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, metaKey: true });
      key('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, metaKey: true });
      expect(sent).toEqual(['\x15']);
    });

    test(`Linux passes scroll chords to the encoder in ${JSON.stringify(mode)}`, async () => {
      const { sent, key, write, terminal } = await createSurface(MAC_UA, 'Linux x86_64');
      write('line\r\n'.repeat(60));
      write(mode);
      const before = terminal['core'].scrollbarState();
      for (const name of ['Home', 'End', 'PageUp', 'PageDown']) {
        const chord = { key: name, code: name, keyCode: 0, shiftKey: true };
        const expected = [terminal['core'].encodeKey(new KeyboardEvent('keydown', chord), 'Linux x86_64'),
          terminal['core'].encodeKey(new KeyboardEvent('keyup', chord), 'Linux x86_64', 'release')].filter(Boolean);
        sent.length = 0;
        key('keydown', chord);
        key('keyup', chord);
        expect(sent).toEqual(expected);
        expect(sent.length).toBeGreaterThan(0);
      }
      expect(terminal['core'].scrollbarState()).toEqual(before);
    });
  }
});
