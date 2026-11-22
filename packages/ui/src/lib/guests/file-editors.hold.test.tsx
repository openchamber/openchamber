import { afterAll, beforeAll, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useGuestFileEditor } from './file-editors';
import { setGuestScopePaths } from './folders';
import { useGuestsStore } from './store';
import type { InstalledGuest } from './types';

const dom = new Window({ url: 'http://localhost' });
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let host: HTMLElement;

beforeAll(async () => {
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterAll(async () => {
  await act(async () => root.unmount());
  useGuestsStore.setState({ guests: [] });
  setGuestScopePaths([]);
  await dom.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const canvas = (folders: string[]): InstalledGuest => ({
  id: 'canvas',
  name: 'Canvas',
  icon: 'apps',
  capabilities: { requested: [], granted: [] },
  fileEditors: [{ id: 'editor', title: 'Canvas', match: ['*.canvas'], entry: 'editor/index.html' }],
  folders,
});

const Probe: React.FC<{ path: string; dirty: boolean }> = ({ path, dirty }) => (
  <span>{useGuestFileEditor(path, dirty)?.guestId ?? 'host'}</span>
);

const show = (path: string, dirty: boolean) => act(async () => root.render(<Probe path={path} dirty={dirty} />));

test('unsaved changes keep their editor when another client limits its extension elsewhere; new opens fall back', async () => {
  setGuestScopePaths(['/work/app']);
  useGuestsStore.setState({ guests: [canvas(['/work'])] });
  await show('/work/app/flow.canvas', false);
  expect(host.textContent).toBe('canvas');

  await show('/work/app/flow.canvas', true);
  await act(async () => useGuestsStore.setState({ guests: [canvas(['/elsewhere'])] }));
  expect(host.textContent).toBe('canvas');

  // A save clears the flag before the frame reports edits made during the write; the editor must not go away then.
  await show('/work/app/flow.canvas', false);
  expect(host.textContent).toBe('canvas');
  await show('/work/app/flow.canvas', true);
  expect(host.textContent).toBe('canvas');

  // Another file opens in the host's view, and so does the first one once its changes are saved or discarded.
  await show('/work/app/other.canvas', true);
  expect(host.textContent).toBe('host');
  await show('/work/app/flow.canvas', false);
  expect(host.textContent).toBe('host');
});
