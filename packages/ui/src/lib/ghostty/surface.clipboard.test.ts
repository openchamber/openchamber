import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { GhosttyTerminalSurface } from './surface';

let dom: Window | null = null;
let surface: GhosttyTerminalSurface | null = null;
let originalGlobals: Map<string, PropertyDescriptor | undefined> | null = null;

const restoreGlobals = () => {
  for (const [name, descriptor] of originalGlobals ?? []) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobals = null;
};

afterEach(async () => {
  surface?.dispose();
  surface = null;
  await dom?.happyDOM.close();
  dom = null;
  restoreGlobals();
});

const createSurface = async (options: {
  middleClickPaste?: boolean;
  platform?: string;
} = {}) => {
  const happyWindow = new Window({ url: 'http://localhost/' });
  dom = happyWindow;
  Object.defineProperty(happyWindow.navigator, 'platform', {
    configurable: true,
    value: options.platform ?? 'Linux x86_64',
  });
  Object.defineProperty(happyWindow.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      fillRect() {},
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 }),
    }),
  });
  Object.defineProperty(happyWindow.HTMLCanvasElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 800, bottom: 200, width: 800, height: 200, x: 0, y: 0 }),
  });
  const capturedPointers = new Set<number>();
  Object.defineProperty(happyWindow.HTMLCanvasElement.prototype, 'setPointerCapture', {
    configurable: true, value: (id: number) => { capturedPointers.add(id); },
  });
  Object.defineProperty(happyWindow.HTMLCanvasElement.prototype, 'hasPointerCapture', {
    configurable: true, value: (id: number) => capturedPointers.has(id),
  });
  Object.defineProperty(happyWindow.HTMLCanvasElement.prototype, 'releasePointerCapture', {
    configurable: true, value: (id: number) => { capturedPointers.delete(id); },
  });
  Object.defineProperty(happyWindow.document, 'fonts', {
    configurable: true,
    value: { load: async () => [], add() {}, addEventListener() {}, removeEventListener() {} },
  });
  const globals = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    ResizeObserver: happyWindow.ResizeObserver,
    KeyboardEvent: happyWindow.KeyboardEvent,
    ClipboardEvent: happyWindow.ClipboardEvent,
    MouseEvent: happyWindow.MouseEvent,
    DataTransfer: happyWindow.DataTransfer,
  };
  originalGlobals = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const mount = document.createElement('div');
  Object.defineProperty(mount, 'clientWidth', { value: 800 });
  Object.defineProperty(mount, 'clientHeight', { value: 200 });
  document.body.append(mount);
  let pastes = 0;
  const mouseData: string[] = [];
  const primaryWrites: string[] = [];
  surface = await GhosttyTerminalSurface.create(mount, {
    visible: false,
    labels: { input: 'Terminal input', scrollbar: 'Terminal scrollback' },
    theme: {
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
    },
    onData: (data) => mouseData.push(data),
    onResize() {},
    onSelectionChange: () => {
      const selection = surface?.getSelection();
      if (selection) primaryWrites.push(selection);
    },
    onMiddleClickPaste: options.middleClickPaste === false ? undefined : () => { pastes += 1; },
  });
  surface.write('hello world');
  return { surface, pastes: () => pastes, mouseData, primaryWrites };
};

const middleClick = (
  target: GhosttyTerminalSurface,
  shiftKey = false,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {},
) => {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 1,
    shiftKey,
    ...modifiers,
    clientX: 8,
    clientY: 8,
  });
  target.canvas.dispatchEvent(event);
  return event;
};

const nativePaste = (target: GhosttyTerminalSurface, text: string, timeStamp?: number) => {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const paste = new ClipboardEvent('paste', {
    clipboardData: data, bubbles: true, cancelable: true,
  });
  if (timeStamp !== undefined) Object.defineProperty(paste, 'timeStamp', { value: timeStamp });
  target.input.dispatchEvent(paste);
  return paste;
};

describe('Linux selection clipboard wiring', () => {
  test('middle-click motion preserves the selection and PRIMARY while still suppressing release paste', async () => {
    const { surface: terminal, pastes, mouseData, primaryWrites } = await createSurface();
    const pointer = (type: string, button: number, buttons: number, clientX: number) => {
      const event = new MouseEvent(type, {
        bubbles: true, cancelable: true,
        button, buttons, clientX, clientY: 8,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      terminal.canvas.dispatchEvent(event);
      return event;
    };
    expect(terminal.selectWordAt(8, 8)).toBe(true);
    expect(terminal.getSelection()).toBe('hello');
    expect(terminal.canvas.hasPointerCapture(1)).toBe(false);
    const writes = [...primaryWrites];
    expect(writes.at(-1)).toBe('hello');

    pointer('pointerdown', 1, 4, 8);
    expect(terminal.canvas.hasPointerCapture(1)).toBe(true);
    pointer('pointermove', -1, 4, 80);
    expect(terminal.getSelection()).toBe('hello');
    expect(primaryWrites).toEqual(writes);
    const release = pointer('pointerup', 1, 0, 80);
    expect(terminal.canvas.hasPointerCapture(1)).toBe(false);
    nativePaste(terminal, 'duplicate paste', release.timeStamp + 1);
    expect(pastes()).toBe(1);
    expect(mouseData).toEqual([]);
    expect(terminal.getSelection()).toBe('hello');
    expect(primaryWrites).toEqual(writes);
  });

  test('middle click pastes while no application tracks the mouse', async () => {
    const { surface: terminal, pastes } = await createSurface();
    expect(middleClick(terminal).defaultPrevented).toBe(true);
    expect(pastes()).toBe(1);
  });

  test('a mouse-reporting application owns plain middle click and Shift pastes', async () => {
    const { surface: terminal, pastes, mouseData } = await createSurface();

    for (const mode of [1000, 1002, 1003]) {
      terminal.write(`\x1b[?${mode}h`);
      const pasteCount = pastes();

      const mouseCount = mouseData.length;
      const click = middleClick(terminal);
      expect(click.defaultPrevented).toBe(true);
      expect(pastes()).toBe(pasteCount);
      expect(mouseData.length).toBeGreaterThan(mouseCount);

      middleClick(terminal, true);
      expect(pastes()).toBe(pasteCount + 1);

      terminal.write(`\x1b[?${mode}l`);
    }
  });

  test('suppresses Chromium paste after a mouse-reporting application owns middle click', async () => {
    const { surface: terminal, pastes, mouseData } = await createSurface();
    terminal.write('\x1b[?1000h');

    const click = middleClick(terminal);
    expect(pastes()).toBe(0);
    expect(mouseData.length).toBeGreaterThan(0);

    const release = new MouseEvent('pointerup', {
      bubbles: true, cancelable: true, button: 1, clientX: 8, clientY: 8,
    });
    Object.defineProperty(release, 'timeStamp', { value: click.timeStamp + 1500 });
    terminal.canvas.dispatchEvent(release);

    const mouseReportCount = mouseData.length;
    nativePaste(terminal, 'follow-up selection paste', click.timeStamp + 1501);
    expect(pastes()).toBe(0);
    expect(mouseData).toHaveLength(mouseReportCount);
  });

  test('the bridge swallows the browser middle-click paste, including in a mouse-reporting application', async () => {
    const { surface: terminal, mouseData } = await createSurface();
    const nativePaste = () => {
      const data = new DataTransfer();
      data.setData('text/plain', 'native echo');
      const paste = new ClipboardEvent('paste', {
        clipboardData: data, bubbles: true, cancelable: true,
      });
      terminal.input.dispatchEvent(paste);
      return paste;
    };

    middleClick(terminal);
    expect(nativePaste().defaultPrevented).toBe(true);
    expect(mouseData).toEqual([]);

    terminal.write('\x1b[?1000h');
    middleClick(terminal, true);
    const mouseReportCount = mouseData.length;
    expect(nativePaste().defaultPrevented).toBe(true);
    expect(mouseData).toHaveLength(mouseReportCount);
  });

  test('Ctrl and Meta middle clicks in a mouse-reporting terminal keep native paste', async () => {
    const { surface: terminal, pastes, mouseData } = await createSurface();
    terminal.write('\x1b[?1000h');
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
      const click = middleClick(terminal, false, modifiers);
      expect(click.defaultPrevented).toBe(false);
      const pasteCount = pastes();
      const mouseCount = mouseData.length;

      nativePaste(terminal, 'native paste');
      expect(pastes()).toBe(pasteCount);
      expect(mouseData).toHaveLength(mouseCount + 1);
      expect(mouseData.at(-1)).toBe('native paste');
    }
  });

  test('a held middle click suppresses the paste that follows its release', async () => {
    const { surface: terminal, mouseData } = await createSurface();
    const click = middleClick(terminal);
    const release = new MouseEvent('pointerup', {
      bubbles: true, cancelable: true, button: 1, clientX: 8, clientY: 8,
    });
    Object.defineProperty(release, 'timeStamp', { value: click.timeStamp + 1500 });
    terminal.canvas.dispatchEvent(release);

    nativePaste(terminal, 'held paste', click.timeStamp + 1501);
    expect(mouseData).toEqual([]);
  });

  test('a middle click without a paste does not swallow a later paste', async () => {
    const { surface: terminal, mouseData } = await createSurface();
    const click = middleClick(terminal);
    nativePaste(terminal, 'late paste', click.timeStamp + 5000);
    expect(mouseData).toEqual(['late paste']);
  });

  test('a keyboard paste after a middle click is not swallowed', async () => {
    const { surface: terminal, mouseData } = await createSurface();
    middleClick(terminal);
    terminal.input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Shift', code: 'ShiftLeft', bubbles: true, cancelable: true,
    }));

    const data = new DataTransfer();
    data.setData('text/plain', 'keyboard paste');
    terminal.input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));

    expect(mouseData).toEqual(['keyboard paste']);
  });

  test('a native middle-click paste still works without the bridge', async () => {
    const { surface: terminal, mouseData } = await createSurface({ middleClickPaste: false });
    expect(middleClick(terminal).defaultPrevented).toBe(false);

    const data = new DataTransfer();
    data.setData('text/plain', 'browser paste');
    terminal.input.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true,
    }));

    expect(mouseData).toEqual(['browser paste']);
  });

  test('a browser TUI leaves a native middle-click paste alone', async () => {
    const { surface: terminal, mouseData } = await createSurface({ middleClickPaste: false });
    terminal.write('\x1b[?1000h');
    const nativePaste = (text: string) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      terminal.input.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data, bubbles: true, cancelable: true,
      }));
    };

    middleClick(terminal);
    nativePaste('tui paste');
    expect(mouseData.at(-1)).toBe('tui paste');
  });

  test('Windows and macOS keep middle-click paste in a mouse-reporting terminal', async () => {
    for (const platform of ['Win32', 'MacIntel']) {
      const { surface: terminal, mouseData } = await createSurface({ middleClickPaste: false, platform });
      terminal.write('\x1b[?1000h');
      middleClick(terminal);
      const mouseReportCount = mouseData.length;

      const data = new DataTransfer();
      data.setData('text/plain', 'native paste');
      terminal.input.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: data, bubbles: true, cancelable: true,
      }));

      expect(mouseData).toHaveLength(mouseReportCount + 1);
      expect(mouseData.at(-1)).toBe('native paste');
      terminal.dispose();
      surface = null;
      await dom?.happyDOM.close();
      dom = null;
      restoreGlobals();
    }
  });
});
