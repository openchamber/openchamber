import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { closeTopmostBackLayer, isTopmostBackLayer, registerBackLayer } from './mobileBackLayers';

describe('mobile back layers', () => {
  const cleanups: Array<() => void> = [];
  const previousGlobals = {
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    KeyboardEvent: globalThis.KeyboardEvent,
  };
  beforeEach(() => {
    const window = new Window();
    Object.assign(globalThis, {
      document: window.document,
      Element: window.Element,
      HTMLElement: window.HTMLElement,
      KeyboardEvent: window.KeyboardEvent,
    });
  });
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    Object.assign(globalThis, previousGlobals);
  });

  test('closes the newest overlay first, one per press', () => {
    const closed: string[] = [];
    const closeEditor = () => closed.push('editor');
    const closeNested = () => closed.push('nested');
    cleanups.push(registerBackLayer(closeEditor));
    const unregisterNested = registerBackLayer(closeNested);

    expect(isTopmostBackLayer(closeNested)).toBe(true);
    expect(closeTopmostBackLayer()).toBe(true);
    unregisterNested();
    expect(isTopmostBackLayer(closeEditor)).toBe(true);
    expect(closeTopmostBackLayer()).toBe(true);
    expect(closed).toEqual(['nested', 'editor']);
  });

  test('leaves back to the shell when nothing is open', () => {
    expect(closeTopmostBackLayer()).toBe(false);
  });

  test('sends Escape to a focused popup before any overlay under it', () => {
    const closed: string[] = [];
    cleanups.push(registerBackLayer(() => closed.push('editor')));
    const popup = document.createElement('div');
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('data-open', '');
    const option = document.createElement('button');
    popup.appendChild(option);
    document.body.appendChild(popup);
    const keys: string[] = [];
    popup.addEventListener('keydown', (event) => keys.push(event.key));
    option.focus();

    expect(closeTopmostBackLayer()).toBe(true);
    expect(keys).toEqual(['Escape']);
    expect(closed).toEqual([]);
  });
});
