import { afterEach, beforeEach, expect, test } from 'bun:test';
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PierreDiffViewerHandle } from '@/components/views/PierreDiffViewer';
import type { DiffFindMatch } from '@/lib/diff/diffFind';
import { shortcutRegistry } from '@/lib/shortcuts';

import { useDiffFind, type DiffFindSource, type UseDiffFindResult } from './useDiffFind';
import { useDiffFindSurface } from './useDiffFindSurface';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Node: browser.Node,
  Element: browser.Element,
  KeyboardEvent: browser.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root;
let host: HTMLDivElement;
let find: UseDiffFindResult;
let surface: ReturnType<typeof useDiffFindSurface>;
let revealed: DiffFindMatch[];

const Probe = ({ sources, visible }: { sources: DiffFindSource[]; visible: boolean }) => {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  find = useDiffFind({ sources });
  surface = useDiffFindSurface({
    find,
    visible,
    rootRef,
    reveal: (match) => revealed.push(match),
  });
  return <div ref={rootRef}><input data-testid="inside" /></div>;
};

const fileDiffWithNeedle = (name: string): FileDiffMetadata =>
  parseDiffFromFile({ name, contents: 'needle\nold\n' }, { name, contents: 'needle\nnew\n' });

const source = (filePath: string): DiffFindSource => ({
  filePath,
  layout: 'inline',
  load: async () => fileDiffWithNeedle(filePath),
});

const render = (sources: DiffFindSource[], visible = true) =>
  act(async () => root.render(<Probe sources={sources} visible={visible} />));

const nextFrames = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

const pressFind = async (): Promise<boolean | void> => {
  const handler = shortcutRegistry.get('find_in_file');
  if (!handler) throw new Error('find_in_file is not registered');
  let result: boolean | void = undefined;
  await act(async () => {
    result = handler(new KeyboardEvent('keydown', { key: 'f', metaKey: true }));
  });
  return result;
};

type HighlightCall = { matches: ReadonlyArray<{ lineNumber: number }>; currentIndex: number };

const fakeViewer = () => {
  const highlights: HighlightCall[] = [];
  const scrolls: number[] = [];
  const handle: PierreDiffViewerHandle = {
    scrollToLine: ({ lineNumber }) => {
      scrolls.push(lineNumber);
      return true;
    },
    setFindHighlights: (matches, currentIndex) => {
      highlights.push({ matches, currentIndex });
    },
  };
  return { handle, highlights, scrolls };
};

beforeEach(() => {
  revealed = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('a hidden surface leaves Cmd/Ctrl+F to the next registration', async () => {
  await render([source('a.ts')], false);
  expect(await pressFind()).toBe(false);
  expect(find.isOpen).toBe(false);
});

test('a visible surface opens the bar and asks it to re-select its query', async () => {
  await render([source('a.ts')]);
  const before = surface.focusNonce;
  expect(await pressFind()).not.toBe(false);
  expect(find.isOpen).toBe(true);
  expect(surface.focusNonce).toBe(before + 1);
});

test('focus in another surface\'s text field keeps Cmd/Ctrl+F there', async () => {
  await render([source('a.ts')]);
  const outside = document.createElement('textarea');
  document.body.append(outside);
  outside.focus();
  expect(await pressFind()).toBe(false);
  expect(find.isOpen).toBe(false);
  outside.remove();
});

test('only the viewer holding the active match is painted, and the jump reaches it', async () => {
  await render([source('a.ts'), source('b.ts')]);
  const first = fakeViewer();
  const second = fakeViewer();
  act(() => {
    surface.registerViewer('a.ts', first.handle);
    surface.registerViewer('b.ts', second.handle);
  });
  await act(async () => find.openWithQuery('needle'));
  await nextFrames();

  expect(revealed.map((match) => match.filePath)).toEqual(['a.ts']);
  expect(first.highlights.at(-1)?.matches).toHaveLength(1);
  expect(first.highlights.at(-1)?.currentIndex).toBe(0);
  expect(second.highlights.at(-1)?.matches).toHaveLength(0);
  expect(first.scrolls).toEqual([1]);

  await act(async () => find.next());
  await nextFrames();
  expect(revealed.map((match) => match.filePath)).toEqual(['a.ts', 'b.ts']);
  expect(first.highlights.at(-1)?.matches).toHaveLength(0);
  expect(second.highlights.at(-1)?.matches).toHaveLength(1);
  expect(second.scrolls).toEqual([1]);
});

test('a viewer that mounts after the jump started still gets scrolled to the match', async () => {
  await render([source('a.ts')]);
  await act(async () => find.openWithQuery('needle'));
  // No viewer yet: the jump waits for one.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));

  const late = fakeViewer();
  act(() => surface.registerViewer('a.ts', late.handle));
  await nextFrames();
  expect(late.highlights.at(-1)?.matches).toHaveLength(1);
  expect(late.scrolls).toEqual([1]);
});

test('Escape closes the bar from the surface, but a field inside it keeps its own Escape', async () => {
  await render([source('a.ts')]);
  await act(async () => find.open());
  const field = host.querySelector('input');
  if (!field) throw new Error('field not found');
  field.focus();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(find.isOpen).toBe(true);

  field.blur();
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  expect(find.isOpen).toBe(false);
});

test('Cmd/Ctrl+F from inside another find surface is left to that surface', async () => {
  await render([source('a.ts')]);
  const files = document.createElement('div');
  files.setAttribute('data-find-surface', '');
  const preview = document.createElement('p');
  files.append(preview);
  document.body.append(files);
  const handler = shortcutRegistry.get('find_in_file');
  if (!handler) throw new Error('find_in_file is not registered');
  let result: boolean | void = undefined;
  const listener = (event: KeyboardEvent) => { result = handler(event); };
  window.addEventListener('keydown', listener);
  await act(async () => {
    preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
  });
  window.removeEventListener('keydown', listener);
  files.remove();
  expect(result).toBe(false);
  expect(find.isOpen).toBe(false);
});
