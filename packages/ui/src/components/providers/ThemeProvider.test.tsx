import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ThemeProvider } from './ThemeProvider';
import { useUIStore } from '@/stores/useUIStore';

test('zoom works without App menu listeners and routes by focused content', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  useUIStore.setState({ fontSize: 100, terminalFontSize: 14, editorFontSize: 13 });
  const zoom = (action: string) => window.dispatchEvent(new CustomEvent('openchamber:zoom', { detail: action }));
  try {
    await act(async () => root.render(<ThemeProvider><input aria-label="composer" /></ThemeProvider>));
    await act(async () => { zoom('zoom-in'); zoom('zoom-in'); });
    expect(useUIStore.getState().fontSize).toBe(120);
    expect(document.documentElement.style.fontSize).toBe('120%');

    const terminal = document.createElement('input');
    terminal.dataset.terminalOwner = 'test-terminal';
    container.append(terminal);
    terminal.focus();
    await act(async () => zoom('zoom-in'));
    expect(useUIStore.getState().terminalFontSize).toBe(15);
    expect(useUIStore.getState().fontSize).toBe(120);
    await act(async () => zoom('zoom-reset'));
    expect(useUIStore.getState().terminalFontSize).toBe(14);

    const key = (value: string, modifiers: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...modifiers });
      document.activeElement?.dispatchEvent(event);
      return event;
    };
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      await act(async () => {
        expect(key('=', modifier).defaultPrevented).toBe(true);
        expect(key('=', modifier).defaultPrevented).toBe(true);
      });
      expect(useUIStore.getState().terminalFontSize).toBe(16);
      expect(useUIStore.getState().fontSize).toBe(120);
      await act(async () => { key('-', modifier); });
      expect(useUIStore.getState().terminalFontSize).toBe(15);
      await act(async () => { key('0', modifier); });
      expect(useUIStore.getState().terminalFontSize).toBe(14);
    }
    expect(key('=', { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(key('=', { ctrlKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(key('=', {}).defaultPrevented).toBe(false);
    useUIStore.getState().setTerminalFontSize(32);
    await act(async () => { key('=', { metaKey: true }); });
    expect(useUIStore.getState().terminalFontSize).toBe(32);
    useUIStore.getState().setTerminalFontSize(9);
    await act(async () => { key('-', { ctrlKey: true }); });
    expect(useUIStore.getState().terminalFontSize).toBe(9);
    await act(async () => { key('0', { ctrlKey: true }); });

    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const editorInput = document.createElement('textarea');
    editor.append(editorInput);
    container.append(editor);
    editorInput.focus();
    expect(key('=', { metaKey: true }).defaultPrevented).toBe(false);
    expect(useUIStore.getState().terminalFontSize).toBe(14);
    await act(async () => zoom('zoom-out'));
    expect(useUIStore.getState().editorFontSize).toBe(12);
    expect(useUIStore.getState().fontSize).toBe(120);

    const browser = document.createElement('webview');
    browser.tabIndex = 0;
    container.append(browser);
    browser.focus();
    expect(document.activeElement).toBe(browser);
    await act(async () => zoom('zoom-in'));
    expect(useUIStore.getState().fontSize).toBe(120);

    browser.blur();
    await act(async () => zoom('zoom-reset'));
    expect(useUIStore.getState().fontSize).toBe(100);
    expect(document.documentElement.style.fontSize).toBe('');
    const composer = document.createElement('div');
    composer.dataset.chatInput = 'true';
    composer.className = 'cm-editor';
    const composerInput = document.createElement('textarea');
    composer.append(composerInput);
    container.append(composer);
    composerInput.focus();
    await act(async () => zoom('zoom-in'));
    expect(useUIStore.getState().fontSize).toBe(110);
    expect(useUIStore.getState().editorFontSize).toBe(12);
    await act(async () => zoom('zoom-reset'));
    await act(async () => root.unmount());
    zoom('zoom-in');
    expect(useUIStore.getState().fontSize).toBe(100);
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
