import { describe, expect, test } from 'bun:test';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { closeSearchPanel, openSearchPanel, search } from '@codemirror/search';

import { searchPanelSpace, searchPanelSpaceField, setSearchPanelSpace } from './searchPanelSpace';

// Just enough of a view for the search commands to toggle the panel in state.
const run = (state: EditorState, command: typeof openSearchPanel): EditorState => {
  let next = state;
  const view = {
    get state() { return next; },
    dispatch: (spec: TransactionSpec) => { next = next.update(spec).state; },
    plugin: () => null,
    root: { activeElement: null },
    focus: () => {},
  };
  command(view as unknown as EditorView);
  return next;
};

const paddingTop = (state: EditorState): string | undefined => {
  const styles = state.facet(EditorView.contentAttributes)
    .map((attrs) => (typeof attrs === 'function' ? null : attrs?.style))
    .filter(Boolean)
    .join(';');
  return /padding-top:\s*([^;]+)/.exec(styles)?.[1];
};

const create = () => EditorState.create({ doc: 'a\nb\nc', extensions: [search({ top: true }), searchPanelSpace()] });

describe('searchPanelSpace', () => {
  test('pads the content by the measured panel height while search is open', () => {
    const open = run(create(), openSearchPanel);
    const measured = open.update({ effects: setSearchPanelSpace.of(42) }).state;

    expect(measured.field(searchPanelSpaceField)).toBe(42);
    expect(paddingTop(measured)).toBe('42px');
  });

  test('follows the panel when it grows, e.g. when Replace opens', () => {
    const open = run(create(), openSearchPanel).update({ effects: setSearchPanelSpace.of(42) }).state;
    const grown = open.update({ effects: setSearchPanelSpace.of(78) }).state;

    expect(paddingTop(grown)).toBe('78px');
  });

  test('removes the space when search closes', () => {
    const open = run(create(), openSearchPanel).update({ effects: setSearchPanelSpace.of(42) }).state;
    const closed = run(open, closeSearchPanel);

    expect(closed.field(searchPanelSpaceField)).toBe(0);
    expect(paddingTop(closed)).toBeUndefined();
  });

  test('ignores measurements while search is closed', () => {
    const state = create().update({ effects: setSearchPanelSpace.of(42) }).state;

    expect(state.field(searchPanelSpaceField)).toBe(0);
    expect(paddingTop(state)).toBeUndefined();
  });
});
