import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, Event: browser.Event, CustomEvent: browser.CustomEvent, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  Element: browser.Element, Node: browser.Node, Text: browser.Text,
  SVGElement: browser.SVGElement, customElements: browser.customElements,
  MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
  XMLSerializer: browser.XMLSerializer, IntersectionObserver: browser.IntersectionObserver,
  ResizeObserver: browser.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(browser, { __OPENCHAMBER_SURFACE__: 'mobile' });

type StatAnswer = Response | Promise<Response> | 'network-error';
let stat: () => StatAnswer = () => Response.json({ path: '/repo/x', isFile: true });
let names: string[] | 'network-error' = [];
const asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/api/fs/stat')) {
    asked.push(url);
    const answer = stat();
    if (answer === 'network-error') throw new TypeError('Failed to fetch');
    return answer;
  }
  if (url.includes('/api/fs/find-by-name')) {
    asked.push(url);
    if (names === 'network-error') throw new TypeError('Failed to fetch');
    return Response.json({ paths: names });
  }
  return Response.json([]);
};

const { MarkdownContent } = await import('../MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { DedicatedMobileAppProvider } = await import('@/apps/mobileAppContext');
const { toast } = await import('@/components/ui');

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
let drawerOpened = 0;
const actions = { openChanges: () => undefined, openFiles: () => { drawerOpened += 1; }, openSourceBoard: () => undefined, openPlan: () => undefined };
const toastError = spyOn(toast, 'error').mockImplementation(() => 'test-toast');
let toastsSeen = 0;
const toasts = () => toastError.mock.calls.slice(toastsSeen).map(([message]) => message);

afterAll(async () => {
  await act(() => root.unmount());
  browser.happyDOM.abort();
  globalThis.fetch = realFetch;
  toastError.mockRestore();
});

beforeEach(() => {
  stat = () => Response.json({ path: '/repo/x', isFile: true });
  names = [];
  asked.length = 0;
  drawerOpened = 0;
  toastsSeen = toastError.mock.calls.length;
  useUIStore.setState({ contextPanelByDirectory: {} });
});

const render = async (content: string) => {
  await act(() => root.render(
    <I18nProvider>
      <DedicatedMobileAppProvider actions={actions}>
        <MarkdownContent content={content} directory="/repo" mode="static" />
      </DedicatedMobileAppProvider>
    </I18nProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const code = () => {
  const element = host.querySelector<HTMLElement>('[data-streamdown="inline-code"]');
  if (!element) throw new Error('Missing inline code');
  return element;
};

const tap = async (element: HTMLElement) => {
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    element.dispatchEvent(click);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return click;
};

const openedPath = () => {
  const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
  return panel?.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath;
};

test('asks nothing and looks like plain code until the tap', async () => {
  await render('Open `src/app.ts` first.');
  expect(asked).toEqual([]);
  expect(code().getAttribute('data-openchamber-file-link')).toBeNull();
  expect(code().getAttribute('role')).toBeNull();
  expect(code().getAttribute('tabindex')).toBeNull();
});

test('a tap on an existing file opens the drawer on it', async () => {
  await render('Open `src/app.ts` first.');
  await tap(code());
  expect(asked).toHaveLength(1);
  expect(openedPath()).toBe('/repo/src/app.ts');
  expect(drawerOpened).toBe(1);
  expect(toasts()).toEqual([]);
});

test('a tap on a missing file shows a toast and asks again next time', async () => {
  stat = () => Response.json({ path: 'x', exists: false });
  await render('Open `src/gone.ts` first.');
  await tap(code());
  expect(toasts()).toEqual(['gone.ts was not found']);
  expect(drawerOpened).toBe(0);

  stat = () => Response.json({ path: '/repo/src/gone.ts', isFile: true });
  await tap(code());
  expect(asked).toHaveLength(2);
  expect(drawerOpened).toBe(1);
});

test('a failed request does not read as a missing file', async () => {
  stat = () => 'network-error';
  await render('Open `src/app.ts` first.');
  await tap(code());
  expect(toasts()).toEqual(["Couldn't open app.ts"]);
  expect(drawerOpened).toBe(0);
});

test('a bare name finds its one file in the project', async () => {
  stat = () => Response.json({ path: 'x', exists: false });
  names = ['/repo/src/helper.ts'];
  await render('Open `helper.ts` first.');
  await tap(code());
  expect(openedPath()).toBe('/repo/src/helper.ts');
  expect(drawerOpened).toBe(1);
});

test('a failed name lookup and a name several files share do not read as missing', async () => {
  stat = () => Response.json({ path: 'x', exists: false });
  names = ['/repo/a/index.ts', '/repo/b/index.ts'];
  await render('Open `index.ts` first.');
  await tap(code());
  expect(toasts()).toEqual(["Couldn't open index.ts"]);

  names = 'network-error';
  await tap(code());
  expect(toasts()).toEqual(["Couldn't open index.ts", "Couldn't open index.ts"]);
  expect(drawerOpened).toBe(0);
});

test('an answer after the code left the screen does nothing', async () => {
  let answer: (response: Response) => void = () => undefined;
  stat = () => new Promise<Response>((resolve) => { answer = resolve; });
  await render('Open `src/app.ts` first.');
  await tap(code());
  await render('Nothing to tap here.');
  await act(async () => {
    answer(Response.json({ path: 'x', exists: false }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(toasts()).toEqual([]);
  expect(drawerOpened).toBe(0);
});

test('a surrounding button keeps its tap', async () => {
  let pressed = 0;
  await act(() => root.render(
    <I18nProvider>
      <DedicatedMobileAppProvider actions={actions}>
        <button type="button" onClick={() => { pressed += 1; }}>
          <MarkdownContent content="`src/app.ts`" directory="/repo" mode="static" />
        </button>
      </DedicatedMobileAppProvider>
    </I18nProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await tap(code());
  expect(pressed).toBe(1);
  expect(asked).toEqual([]);
});

test('code that is not a path and code inside a link keep their old tap', async () => {
  await render('Run `npm run build`.');
  const plain = await tap(code());
  expect(plain.defaultPrevented).toBe(false);

  await render('[`src/app.ts`](https://example.com/app)');
  await tap(code());
  expect(asked).toEqual([]);
  expect(drawerOpened).toBe(0);
});
