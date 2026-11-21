import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/', width: 1280, height: 800 });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, Event: browser.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// React DOM reads the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { useFileImageNavigation } = await import('./useFileImageNavigation');

type Navigation = ReturnType<typeof useFileImageNavigation>;
type Args = Parameters<typeof useFileImageNavigation>[0];

const ENTRIES = [
  { name: 'a.png', path: '/p/a.png', type: 'file' as const },
  { name: 'logo.svg', path: '/p/logo.svg', type: 'file' as const },
];
const fileDirectory: Args['fileDirectory'] = { mapDirectoryEntries: () => ENTRIES };
const files: Args['files'] = { listDirectory: async (path) => ({ directory: path, entries: [] }) };
const scope: Args['scope'] = { panelRoot: '/p', showGitignored: false, treeScope: '/p', treeScopeRef: { current: '/p' } };

let reactRoot: Root | null = null;
let latest: Navigation | null = null;

function Probe({ svgSource, fullscreenOpen }: { svgSource: boolean; fullscreenOpen: boolean }) {
  latest = useFileImageNavigation({
    fileDirectory,
    fileKinds: { isSelectedImage: true, isSvgSource: svgSource },
    imageFullscreen: { open: fullscreenOpen },
    scope,
    tabs: { selectedFile: ENTRIES[1], selectedFilePath: ENTRIES[1].path },
    files,
    visible: true,
  });
  return null;
}

const show = async (props: { svgSource: boolean; fullscreenOpen: boolean }) => {
  if (!reactRoot) reactRoot = createRoot(document.createElement('div'));
  await act(async () => reactRoot?.render(<Probe {...props} />));
};

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  reactRoot = null;
  latest = null;
});

describe('useFileImageNavigation', () => {
  test('an SVG kept as source in the docked view has no arrows there', async () => {
    await show({ svgSource: true, fullscreenOpen: false });
    expect(latest?.imageNeighbors).toBeNull();
  });

  test('the full-window viewer steps on and off an SVG kept as source', async () => {
    await show({ svgSource: true, fullscreenOpen: true });
    expect(latest?.imageNeighbors?.next.name).toBe('a.png');
    expect(latest?.imageNeighbors?.previous.name).toBe('a.png');
  });
});
