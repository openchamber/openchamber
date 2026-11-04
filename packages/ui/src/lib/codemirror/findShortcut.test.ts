import { afterEach, beforeEach, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { search, searchPanelOpen } from '@codemirror/search';
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view';
import { selectAll } from '@codemirror/commands';
import { Window } from 'happy-dom';

const dom = new Window({ url: 'http://runtime.test' });
const globals = {
  window: dom, document: dom.document, KeyboardEvent: dom.KeyboardEvent, navigator: dom.navigator, Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
let view: EditorView;
let selected: boolean;

beforeEach(() => {
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  selected = false;
});

afterEach(async () => {
  view.destroy();
  const { useUIStore } = await import('@/stores/useUIStore');
  useUIStore.setState({ shortcutOverrides: {} });
});

const press = async (overrides: Record<string, string>, key: string) => {
  const { useUIStore } = await import('@/stores/useUIStore');
  const { searchKeymapWithFindShortcut } = await import('./findShortcut');
  useUIStore.setState({ shortcutOverrides: overrides });
  view = new EditorView({
    state: EditorState.create({
      extensions: [
        keymap.of([{ key: 'Ctrl-a', run: (target) => { selected = true; return selectAll(target); } }]),
        search({ top: true }),
        searchKeymapWithFindShortcut(),
      ],
    }),
    parent: document.body,
  });
  runScopeHandlers(view, new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true }), 'editor');
  return searchPanelOpen(view.state);
};

test('the default key opens the search panel', async () => {
  expect(await press({}, 'f')).toBe(true);
});

test('a rebound key opens it and the old key no longer does', async () => {
  expect(await press({ find_in_file: 'ctrl+y' }, 'y')).toBe(true);
  view.destroy();
  expect(await press({ find_in_file: 'ctrl+y' }, 'f')).toBe(false);
});

test('a key rebound onto an editing command opens search and leaves the command alone', async () => {
  expect(await press({ find_in_file: 'ctrl+a' }, 'a')).toBe(true);
  expect(selected).toBe(false);
});
