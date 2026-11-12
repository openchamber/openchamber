import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import type { SpaceEntry } from '@/lib/spaces/spaces-api';

import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { SpacePlacesSettings } from './SpacePlacesSettings';
import { SpaceActionsSheet } from '@/components/session/spaces/SpaceActions';

const fetch = spyOn(globalThis, 'fetch');

const missing: SpaceEntry = {
  id: 'a1b2c3d4e5f6', kind: 'host-root', placeId: 'host-root', name: 'Missing root work', machine: null,
  projectDirectory: null, projectFolder: { path: '/removed-project', found: false }, directory: null,
  state: 'missing', stoppedIdle: false, step: null, failure: null, network: null, grants: [],
  access: null, needsAccess: [], accessFailures: [], damage: null, setup: null,
};
const globals = new Map<string, PropertyDescriptor | undefined>();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let hasRoot = true;
beforeEach(() => {
  const window = new Window({ url: 'http://localhost:3000/' });
  for (const [key, value] of Object.entries({
    window, document: window.document, navigator: window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useI18nStore.setState({ locale: 'en', dictionary: dict, loadingLocale: null });
  useSpacesStore.getState().resetForRuntimeSwitch();
  useUIStore.setState({ isMobile: true });
  fetch.mockImplementation(async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path.endsWith('/places')) return Response.json({ places: hasRoot ? [{ id: 'host-root', kind: 'host-root', available: true, hostIsolation: false }] : [] });
    if (path.endsWith('/root-passkeys')) return Response.json({ available: false, reason: 'no_passkey_approved', passkeys: [] });
    if (path.endsWith('/disk')) return Response.json({ imageBytes: null, toolsBytes: 0, spacesBytes: 0, freeBytes: 0, freesImage: false });
    return Response.json({ spaces: [missing] });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetch.mockReset();
  useSpacesStore.getState().resetForRuntimeSwitch();
  useUIStore.setState({ isMobile: false });
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

describe('root space cleanup in Settings', () => {
  it.each([true, false] as const)('keeps a missing projectless root space deletable, root place listed=%s', async (listed) => {
    // Given
    hasRoot = listed;
    // When
    await act(async () => root.render(<I18nProvider><SpacePlacesSettings /><SpaceActionsSheet /></I18nProvider>));
    // Then
    const row = container.querySelector(`[data-space-row="${missing.id}"]`);
    expect(row?.textContent).toContain(missing.name);
    expect(row?.textContent).toContain('/removed-project');
    const menu = row?.querySelector('button');
    if (!menu) throw new Error('Missing root cleanup menu');
    // When
    await act(async () => menu.click());
    const remove = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === dict['spaces.actions.remove']);
    if (!remove) throw new Error('Missing root removal action');
    await act(async () => remove.click());
    // Then
    expect(useSpacesStore.getState().deleteDialog).toBe(missing.id);
  });
});
