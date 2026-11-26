import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { sessionsFilterFocus } from '@/lib/sidebarSections';
import { focusSidebarSection, useSidebarSectionsUiStore } from '@/components/session/sidebar/sections/sectionActions';
import { MobileSidebarFocusChip } from './MobileSidebarFocusChip';
import { useMobileSidebarRowsStore } from './mobileSidebarState';

let win: Window;
let root: Root;
let host: HTMLElement;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

const render = async () => {
  await act(async () => root.render(
    <I18nProvider>
      <MobileSidebarFocusChip />
    </I18nProvider>,
  ));
};

const chip = () => host.querySelector<HTMLButtonElement>('button');

beforeEach(() => {
  useSidebarSectionsUiStore.setState({ focus: null });
  win = new Window({ url: 'http://localhost/' });
  const globals = {
    window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    Event: win.Event, MouseEvent: win.MouseEvent, MutationObserver: win.MutationObserver,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    ResizeObserver: win.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of Object.keys(globals)) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.assign(globalThis, globals);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  useSidebarSectionsUiStore.setState({ focus: null });
  await win.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the list shows no chip until a link focuses it', async () => {
  await render();
  expect(chip()).toBeNull();
});

test('a focused list names its section on a chip, and the chip shows every session again', async () => {
  await render();
  await act(async () => focusSidebarSection(sessionsFilterFocus('attention', 'Waiting on me')!));
  expect(chip()?.textContent).toBe('Waiting on me');
  expect(chip()?.getAttribute('aria-label')).toBe('Show all sessions');

  await act(async () => chip()?.click());
  expect(useSidebarSectionsUiStore.getState().focus).toBeNull();
  expect(chip()).toBeNull();
});

test('closing the list drops the focus, so the next open shows every session', async () => {
  await render();
  await act(async () => focusSidebarSection(sessionsFilterFocus('attention', 'Waiting on me')!));
  await act(async () => useMobileSidebarRowsStore.getState().reset());
  expect(useSidebarSectionsUiStore.getState().focus).toBeNull();
  expect(chip()).toBeNull();
});
