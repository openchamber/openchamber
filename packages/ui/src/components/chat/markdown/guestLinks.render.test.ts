import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { GuestLinkClaim, GuestLinkRule } from '@/lib/guests/links';
import type { InstalledGuest } from '@/lib/guests/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
  HTMLAnchorElement: browser.HTMLAnchorElement, Element: browser.Element, Node: browser.Node, Text: browser.Text,
  SVGElement: browser.SVGElement, MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
  Event: browser.Event, Range: browser.Range,
  XMLSerializer: browser.XMLSerializer, IntersectionObserver: browser.IntersectionObserver, ResizeObserver: browser.ResizeObserver,
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser) });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
Object.defineProperty(globalThis, 'customElements', { configurable: true, value: browser.customElements });
const state = { codeBlockLineWrap: false, tableCellWrap: true, copyMessagesAsPlainText: false, mermaidRenderingMode: 'svg', setCodeBlockLineWrap: () => undefined, setTableCellWrap: () => undefined, openContextFile: () => undefined, openContextFileAtLine: () => undefined };
mock.module('@/stores/useUIStore', () => ({ useUIStore: Object.assign((select: (value: typeof state) => never) => select(state), { getState: () => state }) }));
mock.module('@/lib/router/openSessionFromRoute', () => ({ openSession: async () => undefined, openSessionLink: async () => undefined }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/project' }));
// Its hooks pull in the session side panel and the stores behind it; these tests draw no tracker chips.
mock.module('@/components/sourceBoard/openTrackerItem', () => ({
  trackerTargetOfUrl: () => null,
  repositoryUrlOfItemLink: () => null,
  isSameRepositoryItemLink: (left: string, right: string) => left === right,
  trackerItemLabel: () => null,
  wasTrackerItemRequested: () => false,
  settleTrackerItemRequest: () => undefined,
  useShowTrackerItem: () => null,
  useOpenProjectOnBoard: () => null,
  useOpenTrackerItem: () => () => undefined,
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ runtime: { isVSCode: false }, editor: undefined }) }));
const opened: string[] = [];
mock.module('../useOpenChatLink', () => ({ useOpenChatLink: () => (href: string) => { opened.push(href); } }));
mock.module('@/contexts/useThemeSystem', () => ({ useOptionalThemeSystem: () => ({ currentTheme: getDefaultTheme(false) }) }));
const claims: GuestLinkClaim[] = [];
let builtIn = false;
mock.module('./guestLinkClick', () => ({
  isBuiltInLink: () => builtIn,
  runGuestLink: (claim: GuestLinkClaim) => { claims.push(claim); return true; },
}));

const rules: GuestLinkRule[] = [{
  guestId: 'tasks',
  action: 'open',
  keys: ['DEMO'],
  urls: {
    origin: 'https://tasks.example.com',
    identifierPattern: '^[A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16}$',
    patterns: [{ path: '^/tasks/([A-Za-z][A-Za-z0-9_]{0,31}-\\d{1,16})(?:/|$)' }],
    itemTemplate: '/tasks/{id}',
  },
}];

let Renderer: typeof import('../MarkdownRendererImpl');
let I18nProvider: typeof import('@/lib/i18n')['I18nProvider'];
let root: Root;
const host = document.createElement('div');
beforeAll(async () => {
  Renderer = await import('../MarkdownRendererImpl');
  I18nProvider = (await import('@/lib/i18n')).I18nProvider;
  const { useGuestsStore } = await import('@/lib/guests/store');
  const tasks: InstalledGuest = { id: 'tasks', name: 'Tasks', icon: 'task', capabilities: { requested: ['links'], granted: ['links'] } };
  useGuestsStore.setState({ guests: [tasks] });
  document.body.append(host);
  root = createRoot(host);
});
afterAll(async () => { await act(() => root?.unmount()); browser.happyDOM.abort(); });
beforeEach(() => { claims.length = 0; opened.length = 0; builtIn = false; });

type Options = { guestLinks?: readonly GuestLinkRule[] | null; allowRawHtml?: boolean; purpose?: 'copy'; disableLinkSafety?: boolean };
const render = async (content: string, options: Options = {}) => {
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(Renderer.MarkdownContent, {
      content, mode: 'static', settled: true, enableFileReferences: false, guestLinks: options.guestLinks === undefined ? rules : options.guestLinks,
      allowRawHtml: options.allowRawHtml, purpose: options.purpose, disableLinkSafety: options.disableLinkSafety,
    })));
  });
};
const marks = () => Array.from(host.querySelectorAll('[data-oc-guest-link]')).map((element) => element.textContent);

test('an identifier an extension claims becomes clickable; code, words and other keys stay text', async () => {
  await render('See DEMO-2, `DEMO-3`, UTF-8, a/DEMO-4 and HR-5.\n\n```\nDEMO-6\n```');
  expect(marks()).toEqual(['DEMO-2']);
  const mark = host.querySelector('[data-oc-guest-link]');
  expect(mark?.hasAttribute('href')).toBe(false);
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  mark?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(claims).toEqual([{ guestId: 'tasks', action: 'open', identifier: 'DEMO-2', url: 'https://tasks.example.com/tasks/DEMO-2' }]);
});

test('a message already on screen re-parses when an extension starts or stops claiming', async () => {
  await render('See DEMO-2.', { guestLinks: null });
  expect(marks()).toEqual([]);
  await render('See DEMO-2.');
  expect(marks()).toEqual(['DEMO-2']);
  await render('See DEMO-2.', { guestLinks: [] });
  expect(marks()).toEqual([]);
});

test('an author cannot write the mark: raw HTML keeps it off', async () => {
  await render('<a data-oc-guest-link="tasks">DEMO-x</a> <span data-oc-guest-link="tasks">y</span>', { allowRawHtml: true, guestLinks: null });
  expect(host.querySelector('[data-oc-guest-link]')).toBeNull();
});

test('a copy keeps the text as written', async () => {
  await render('See DEMO-2.', { purpose: 'copy' });
  expect(marks()).toEqual([]);
  expect(host.textContent).toContain('DEMO-2');
});

test('a claimed link opens in the extension, also in the user\'s own message; built-in claims and modified clicks keep their way', async () => {
  const url = 'https://tasks.example.com/tasks/DEMO-1';
  await render(`Open ${url}`, { disableLinkSafety: true });
  const anchor = Array.from(host.querySelectorAll('a')).find((element) => element.getAttribute('href') === url);
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  anchor?.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(claims).toEqual([{ guestId: 'tasks', action: 'open', identifier: 'DEMO-1', url }]);

  claims.length = 0;
  anchor?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
  expect(claims).toEqual([]);

  builtIn = true;
  await render(`Open ${url}`);
  const again = Array.from(host.querySelectorAll('a')).find((element) => element.getAttribute('href') === url);
  again?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(claims).toEqual([]);
  expect(opened).toEqual([url]);
});
