import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
const browser = new Window({ url: 'http://localhost/' });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, HTMLElement: browser.HTMLElement,
  Element: browser.Element, Node: browser.Node, Text: browser.Text, SVGElement: browser.SVGElement,
  customElements: browser.customElements, MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { UiBlock } = await import('./UiBlock');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');
type Answer = Parameters<NonNullable<Extract<React.ComponentProps<typeof UiBlock>['host'], { kind: 'page' }>['submit']>>[0];

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => { await act(() => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = realFetch; });

// SAFETY: UiBlock reads only `currentTheme` from the theme system.
const themeSystem = { currentTheme: getDefaultTheme(false) } as React.ContextType<typeof ThemeSystemContext>;
const draw = (source: string, submit: (answer: Answer) => Promise<void>, onNotDrawn?: (errors: string[]) => void) => act(() => root.render(
  <I18nProvider>
    <ThemeSystemContext.Provider value={themeSystem}>
      <UiBlock source={source} complete host={{ kind: 'page', submit, answered: null }} onNotDrawn={onNotDrawn} />
    </ThemeSystemContext.Provider>
  </I18nProvider>,
));
const buttons = () => [...host.querySelectorAll('button')].map((button) => button.textContent);
const text = () => host.textContent ?? '';
const reasons = () => [...host.querySelectorAll('li')].map((item) => item.textContent);

test('a waiting form without buttons gets one that sends its fields', async () => {
  const answers: Answer[] = [];
  await draw('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"], "Scope")', async (answer) => { answers.push(answer); });
  const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send');
  if (!send) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => send.click());
  expect(answers).toHaveLength(1);
  expect(answers[0].data.button).toBe('Send');
});

test('a form with its own button gets no second one', async () => {
  await draw('root = Stack([scope, go])\nscope = Choice("scope", ["API"])\ngo = Button("Go")', async () => {});
  expect(buttons()).toContain('Go');
  expect(buttons()).not.toContain('Send');
});

test('an invalid block says why under the generic line, then its source', async () => {
  const source = 'root = Steps([{ title: "M0", status: "todo" }], "column")';
  await draw(source, async () => {});
  expect(text()).toContain('This block could not be drawn.');
  expect(reasons()).toEqual(['The block needs root = Stack([...])']);
  expect(host.querySelector('pre code')?.textContent).toBe(source);
});

test('an invalid block shows every reason on its own row', async () => {
  await draw('root = Steps([{ title: "M0" }], "column")\nextra = Text("hi")', async () => {});
  expect(reasons()).toEqual([
    'Defined but never used: extra',
    'The block needs root = Stack([...])',
  ]);
});

test('a valid block shows no reasons', async () => {
  await draw('root = Stack([badge])\nbadge = Badge("Hi")', async () => {});
  expect(text()).toContain('Hi');
  expect(text()).not.toContain('This block could not be drawn.');
  expect(reasons()).toEqual([]);
});

test('a settled invalid block reports its reasons once', async () => {
  const reported: string[][] = [];
  await draw('root = Steps([{ title: "M0", status: "todo" }], "column")', async () => {}, (errors) => reported.push(errors));
  expect(reported).toEqual([['The block needs root = Stack([...])']]);
});
