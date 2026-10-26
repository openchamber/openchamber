import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});

const { EditorView } = await import('@codemirror/view');
const { closeSearchPanel, openSearchPanel, search } = await import('@codemirror/search');
const { searchPanelSpace, searchPanelSpaceField, setSearchPanelSpace } = await import('./searchPanelSpace');
const views: InstanceType<typeof EditorView>[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});
afterAll(() => dom.happyDOM.close());

// happy-dom does no layout, so the tests hand in the panel height the plugin would measure.
function editor() {
  const view = new EditorView({
    doc: 'a\nb\nc',
    extensions: [search({ top: true }), searchPanelSpace()],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function measurePanel(view: InstanceType<typeof EditorView>, space: number) {
  view.dispatch({ effects: setSearchPanelSpace.of(space) });
}

describe('searchPanelSpace', () => {
  test('pads the content by the measured panel height while search is open', () => {
    const view = editor();
    openSearchPanel(view);
    measurePanel(view, 42);

    expect(view.state.field(searchPanelSpaceField)).toBe(42);
    expect(view.contentDOM.style.paddingTop).toBe('42px');
  });

  test('follows the panel when it grows', () => {
    const view = editor();
    openSearchPanel(view);
    measurePanel(view, 42);
    measurePanel(view, 78);

    expect(view.contentDOM.style.paddingTop).toBe('78px');
  });

  test('removes the space when search closes', () => {
    const view = editor();
    openSearchPanel(view);
    measurePanel(view, 42);
    closeSearchPanel(view);

    expect(view.state.field(searchPanelSpaceField)).toBe(0);
    expect(view.contentDOM.style.paddingTop).toBe('');
  });

  test('ignores measurements while search is closed', () => {
    const view = editor();
    measurePanel(view, 42);

    expect(view.state.field(searchPanelSpaceField)).toBe(0);
    expect(view.contentDOM.style.paddingTop).toBe('');
  });
});
