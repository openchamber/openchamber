import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// React DOM reads the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { useTableDelimiter } = await import('./useTableDelimiter');

let reactRoot: Root | null = null;
let latest: string | null = null;

function Probe({ path, source, revision }: { path: string | null; source: string; revision: number }) {
  latest = useTableDelimiter(path, source, revision);
  return null;
}

const render = (props: { path: string | null; source: string; revision: number }) => {
  act(() => {
    if (!reactRoot) reactRoot = createRoot(document.createElement('div'));
    reactRoot.render(<Probe {...props} />);
  });
  return latest;
};

afterEach(() => {
  act(() => reactRoot?.unmount());
  reactRoot = null;
  latest = null;
});

const loaded = 'id;"label, title"\n1;alpha,one\n2;beta,two\n';
// After renaming the header to `label, names` a semicolon file writes the comma unquoted,
// and the edited text alone reads as two comma columns just as well.
const edited = 'id;label, names\n1;alpha,one\n2;beta,two\n';

describe('useTableDelimiter', () => {
  test('an edit that reads differently keeps the separator of the loaded file', () => {
    expect(render({ path: '/x/data.csv', source: loaded, revision: 1 })).toBe(';');
    expect(render({ path: '/x/data.csv', source: edited, revision: 1 })).toBe(';');
  });

  test('renaming the open document after a save keeps its separator', () => {
    expect(render({ path: '/x/data.csv', source: loaded, revision: 1 })).toBe(';');
    expect(render({ path: '/x/data.csv', source: edited, revision: 1 })).toBe(';');
    expect(render({ path: '/x/renamed.csv', source: edited, revision: 1 })).toBe(';');
    expect(render({ path: '/x/renamed.tsv', source: edited, revision: 1 })).toBe('\t');
  });

  test('a freshly loaded source or another file is read again', () => {
    expect(render({ path: '/x/data.csv', source: loaded, revision: 1 })).toBe(';');
    expect(render({ path: '/x/data.csv', source: 'a,b\n1,2\n', revision: 2 })).toBe(',');
    expect(render({ path: '/x/other.csv', source: loaded, revision: 3 })).toBe(';');
  });

  test('no table reads nothing', () => {
    expect(render({ path: null, source: loaded, revision: 1 })).toBe(',');
  });
});
