import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { TerminalTheme } from '@/lib/terminalTheme';

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

class MockFitAddon {
  fit(): void {}
}

class MockTerminal {
  cols = 80;
  rows = 24;
  options = { cursorBlink: false };
  buffer = {
    active: {
      length: 0,
      viewportY: 0,
      getLine: () => undefined,
    },
  };

  loadAddon(): void {}
  open(): void {}
  onData() {
    return { dispose: () => undefined };
  }
  write(_data: string, callback?: () => void): void {
    callback?.();
  }
  reset(): void {}
  dispose(): void {}
  focus(): void {}
  scrollLines(): void {}
  getSelectionPosition(): undefined {
    return undefined;
  }
  getSelection(): string {
    return '';
  }
}

mock.module('ghostty-web', () => ({
  Ghostty: { load: async () => ({}) },
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

const terminalTheme: TerminalTheme = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: '#333333',
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#ffffff',
  brightBlack: '#666666',
  brightRed: '#ff6666',
  brightGreen: '#66ff66',
  brightYellow: '#ffff66',
  brightBlue: '#6666ff',
  brightMagenta: '#ff66ff',
  brightCyan: '#66ffff',
  brightWhite: '#ffffff',
};

type InstalledDom = {
  restore: () => void;
};

const installDom = (): InstalledDom => {
  const windowInstance = new Window({ url: 'http://localhost/' });
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  const pendingFrameIds = new Set<number>();
  let nextFrameId = 1;

  const installGlobal = (name: string, value: Window[keyof Window]): void => {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  const requestAnimationFrame = (): number => {
    const frameId = nextFrameId++;
    pendingFrameIds.add(frameId);
    return frameId;
  };
  const cancelAnimationFrame = (frameId: number): void => {
    pendingFrameIds.delete(frameId);
  };

  installGlobal('window', windowInstance);
  installGlobal('document', windowInstance.document);
  installGlobal('navigator', windowInstance.navigator);
  installGlobal('Document', windowInstance.Document);
  installGlobal('Element', windowInstance.Element);
  installGlobal('HTMLElement', windowInstance.HTMLElement);
  installGlobal('SVGElement', windowInstance.SVGElement);
  installGlobal('Node', windowInstance.Node);
  installGlobal('Text', windowInstance.Text);
  installGlobal('Event', windowInstance.Event);
  installGlobal('InputEvent', windowInstance.InputEvent);
  installGlobal('FocusEvent', windowInstance.FocusEvent);
  installGlobal('MouseEvent', windowInstance.MouseEvent);
  installGlobal('PointerEvent', windowInstance.PointerEvent);
  installGlobal('ResizeObserver', TestResizeObserver);
  installGlobal('requestAnimationFrame', requestAnimationFrame);
  installGlobal('cancelAnimationFrame', cancelAnimationFrame);
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  return {
    restore: () => {
      pendingFrameIds.clear();
      for (const [name, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      windowInstance.close();
    },
  };
};

type BeforeInputInit = {
  inputType: string;
  data?: string;
  isComposing?: boolean;
};

const dispatchBeforeInput = (container: HTMLDivElement, init: BeforeInputInit): void => {
  const event = new Event('beforeinput', {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    inputType: { configurable: true, value: init.inputType },
    data: { configurable: true, value: init.data ?? '' },
    isComposing: { configurable: true, value: init.isComposing ?? false },
  });
  container.dispatchEvent(event);
};

const withMountedViewport = async (
  enableTouchScroll: boolean,
  callback: (container: HTMLDivElement, received: string[]) => void | Promise<void>,
): Promise<void> => {
  const dom = installDom();
  let root: Root | null = null;

  try {
    const { TerminalViewport } = await import('../TerminalViewport');
    const received: string[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const mountedRoot = createRoot(host);
    root = mountedRoot;

    await act(async () => {
      mountedRoot.render(React.createElement(TerminalViewport, {
        sessionKey: 'android-input-test',
        chunks: [],
        onInput: (data: string) => received.push(data),
        onResize: () => undefined,
        theme: terminalTheme,
        fontFamily: 'monospace',
        fontSize: 14,
        enableTouchScroll,
        autoFocus: false,
      }));
    });

    const container = host.querySelector<HTMLDivElement>('[data-terminal-owner="main"]');
    if (!container) throw new Error('TerminalViewport did not mount its container');
    await callback(container, received);
  } finally {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => mountedRoot.unmount());
    dom.restore();
  }
};

describe('Android terminal IME input', () => {
  test('forwards non-composing beforeinput payloads through the touch input path', async () => {
    await withMountedViewport(true, async (container, received) => {
      await act(async () => {
        dispatchBeforeInput(container, { inputType: 'insertText', data: 'android text' });
        dispatchBeforeInput(container, { inputType: 'insertLineBreak' });
        dispatchBeforeInput(container, { inputType: 'insertParagraph' });
        dispatchBeforeInput(container, { inputType: 'deleteContentBackward' });
      });

      expect(received).toEqual(['android text', '\r', '\r', '\x7f']);
    });
  });

  test('ignores composing and unsupported beforeinput events', async () => {
    await withMountedViewport(true, async (container, received) => {
      await act(async () => {
        dispatchBeforeInput(container, {
          inputType: 'insertText',
          data: 'composing text',
          isComposing: true,
        });
        dispatchBeforeInput(container, { inputType: 'insertFromPaste', data: 'pasted text' });
      });

      expect(received).toEqual([]);
    });
  });

  test('does not attach beforeinput handling when touch scrolling is disabled', async () => {
    await withMountedViewport(false, async (container, received) => {
      await act(async () => {
        dispatchBeforeInput(container, { inputType: 'insertText', data: 'desktop text' });
      });

      expect(received).toEqual([]);
    });
  });
});
