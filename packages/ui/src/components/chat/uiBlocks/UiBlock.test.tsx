import { afterAll, describe, expect, test } from 'bun:test';
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
  customElements: browser.customElements, MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser, CustomEvent: browser.CustomEvent,
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver,
  requestAnimationFrame: browser.requestAnimationFrame, cancelAnimationFrame: browser.cancelAnimationFrame });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { UiBlock } = await import('./UiBlock');
const { onTabStep } = await import('../lib/scroll/timelineScrollIntent');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');
type Answer = Parameters<NonNullable<Extract<React.ComponentProps<typeof UiBlock>['host'], { kind: 'page' }>['submit']>>[0];
type ReplyAnswer = Parameters<NonNullable<Extract<React.ComponentProps<typeof UiBlock>['host'], { kind: 'reply' }>['submit']>>[0];

const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => { await act(() => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = realFetch; });

// SAFETY: UiBlock reads only `currentTheme` from the theme system.
const themeSystem = { currentTheme: getDefaultTheme(false) } as React.ContextType<typeof ThemeSystemContext>;
// A key per draw: a reused instance would keep the previous block's sent state.
let drawn = 0;
const render = (source: string, blockHost: React.ComponentProps<typeof UiBlock>['host']) => {
  const key = ++drawn;
  return act(() => root.render(
    <I18nProvider>
      <ThemeSystemContext.Provider value={themeSystem}>
        <UiBlock key={key} source={source} complete host={blockHost} />
      </ThemeSystemContext.Provider>
    </I18nProvider>,
  ));
};
// Without submit it draws as in a reply.
const draw = (source: string, submit?: (answer: Answer) => Promise<void>) => render(source, submit ? { kind: 'page', submit, answered: null } : undefined);
type ReplySubmit = NonNullable<Extract<React.ComponentProps<typeof UiBlock>['host'], { kind: 'reply' }>['submit']>;
const drawReply = (source: string, submit: ReplySubmit) => render(source, { kind: 'reply', submit, answered: null });
const buttons = () => [...host.querySelectorAll('button')].map((button) => button.textContent);
const option = (label: string) => [...host.querySelectorAll('span')].find((element) => element.textContent === label);
const send = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Send');
const press = async (label: string) => {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Expected a ${label} button, got ${buttons().join(', ')}`);
  await act(async () => button.click());
};

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

describe('a form in a reply without buttons', () => {
  const drawReply = (source: string, submit: (answer: ReplyAnswer, text: string) => Promise<void>) => act(() => root.render(
    <I18nProvider>
      <ThemeSystemContext.Provider value={themeSystem}>
        <UiBlock key={source} source={source} complete host={{ kind: 'reply', submit, answered: null }} />
      </ThemeSystemContext.Provider>
    </I18nProvider>,
  ));
  const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent === name);
  const form = 'root = Stack([deploy])\ndeploy = Choice("deploy", ["Yes", "No"], "What should Deploy do?")';

  test('sends the chosen fields, and offers Send only once one is filled', async () => {
    const answers: { answer: ReplyAnswer; text: string }[] = [];
    await drawReply(form, async (answer, text) => { answers.push({ answer, text }); });
    expect(buttonNamed('Send')?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]')?.click());
    expect(buttonNamed('Send')?.disabled).toBe(false);
    await act(async () => buttonNamed('Send')?.click());
    expect(answers).toEqual([{
      answer: { picks: [], values: { deploy: 'Yes' }, skipped: [] },
      text: 'The user answered the UI block in your previous reply:\n- What should Deploy do? Yes',
    }]);
    expect(host.textContent).toContain('Sent');
  });

  test('a block that lost a part draws the rest and says what it lost', async () => {
    await drawReply('root = Stack([state, note])\nstate = Badge("Done")\nnote = Callout()', async () => {});
    expect(host.textContent).toContain('Done');
    expect(host.textContent).toContain('Part of this block could not be drawn.');
    expect(host.textContent).toContain('missing required field');
  });

  test('a fold with nothing inside draws nothing and says nothing', async () => {
    await drawReply('root = Stack([state, a, b])\nstate = Badge("Done")\na = Details("Method notes")\nb = Details("Sources", [])', async () => {});
    expect(host.textContent).toContain('Done');
    expect(host.textContent).not.toContain('Method notes');
    expect(host.textContent).not.toContain('Sources');
    expect(host.textContent).not.toContain('could not be drawn');
  });

  test('a block with no fields gets no button', async () => {
    await drawReply('root = Stack([state])\nstate = Badge("Done")', async () => {});
    expect(host.textContent).toContain('Done');
    expect(buttons()).not.toContain('Send');
  });
});

test('a block that cannot be drawn says why and folds its source', async () => {
  await draw('root = Stack([question])\nquestion = Choice("approach", ["A"])\nConfirm = Button("Go")', async () => {});
  expect(host.textContent).toContain('Defined but never used: Confirm');
  const source = host.querySelector('pre');
  expect(source?.hidden).toBe(true);
  const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Source');
  await act(async () => toggle?.click());
  expect(source?.hidden).toBe(false);
});

const tabbedForm = 'root = Stack([tabs])\ntabs = Tabs([Tab("Editor", [Choice("editor", ["Zed"])]), Tab("Why", [Input("why", "Why?")])])';

test('a waiting form that ends with tabs steps through them with Next and sends from the last tab', async () => {
  const answers: Answer[] = [];
  await draw(tabbedForm, async (answer) => { answers.push(answer); });
  expect(buttons()).toContain('Next');
  expect(buttons()).not.toContain('Send');
  await press('Next');
  expect(host.textContent).toContain('Why?');
  expect(buttons()).not.toContain('Next');
  // Next went away, so focus moved to the tab it opened.
  expect(document.activeElement?.classList.contains('oc-box')).toBe(true);
  await press('Send');
  expect(answers).toHaveLength(1);
});

test('Next keeps the fields of earlier tabs and asks for the new tab to come into view, and the first draw does not', async () => {
  const answers: Answer[] = [];
  const steps: HTMLElement[] = [];
  const stop = onTabStep(host, (tabs) => { steps.push(tabs); });
  await draw(tabbedForm, async (answer) => { answers.push(answer); });
  expect(steps).toHaveLength(0);
  await act(async () => host.querySelector<HTMLElement>('[role="radio"]')?.click());
  await press('Next');
  stop();
  expect(steps).toHaveLength(1);
  expect(steps[0].contains(document.activeElement)).toBe(true);
  await press('Send');
  expect(answers[0].data.values).toEqual({ editor: 'Zed' });
});

test('the host\'s controls stay under the block on every tab', async () => {
  await act(() => root.render(
    <I18nProvider>
      <ThemeSystemContext.Provider value={themeSystem}>
        <UiBlock key={++drawn} source={tabbedForm} complete host={{ kind: 'page', submit: async () => {}, answered: null }} actions={<button type="button">Decline</button>} />
      </ThemeSystemContext.Provider>
    </I18nProvider>,
  ));
  const decline = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Decline');
  const tile = () => host.querySelector('.oc-box');
  expect(decline()).toBeDefined();
  expect(tile()?.contains(decline() ?? null)).toBe(false);
  await press('Next');
  expect(tile()?.contains(decline() ?? null)).toBe(false);
  expect(buttons()).toContain('Send');
  expect(tile()?.textContent).toContain('Send');
});

test('a tab with buttons of its own takes Next on their line', async () => {
  await draw('root = Stack([tabs])\ntabs = Tabs([Tab("A", [Choice("a", ["x"]), Button("Send A", "primary", "a")]), Tab("B", [Input("b")])])', async () => {});
  const row = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Next')?.parentElement;
  expect([...row?.querySelectorAll('button') ?? []].map((button) => button.textContent)).toEqual(['Send A', 'Next']);
});

test('tabs in a reply, or on a page nobody answers, step only through their strip', async () => {
  await draw(tabbedForm);
  expect(buttons()).not.toContain('Next');
  await act(() => root.render(
    <I18nProvider>
      <ThemeSystemContext.Provider value={themeSystem}>
        <UiBlock key={++drawn} source={tabbedForm} complete host={{ kind: 'page', submit: null, answered: null }} />
      </ThemeSystemContext.Provider>
    </I18nProvider>,
  ));
  expect(buttons()).not.toContain('Next');
});

test("a reply's form without buttons gets one that sends its fields", async () => {
  const answers: Parameters<ReplySubmit>[] = [];
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"], "Scope")', async (...answer) => { answers.push(answer); });
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  const press = send();
  if (!press) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => press.click());
  expect(answers).toHaveLength(1);
  expect(answers[0][0].values).toEqual({ scope: 'API' });
  expect(answers[0][0].picks).toEqual([]);
  expect(host.textContent).toContain('Sent');
  expect(buttons()).not.toContain('Send');
});

test("a reply's form with its own button gets no second one", async () => {
  await drawReply('root = Stack([scope, go])\nscope = Choice("scope", ["API"])\ngo = Button("Go")', async () => {});
  expect(buttons()).toContain('Go');
  expect(buttons()).not.toContain('Send');
});

test("a reply's block without fields or buttons gets no Send", async () => {
  await drawReply('root = Stack([badge])\nbadge = Badge("status")', async () => {});
  expect(buttons()).not.toContain('Send');
});

test("a reply's field-only form offers Send once a field has a value", async () => {
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"])', async () => {});
  expect(send()?.disabled).toBe(true);
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  expect(send()?.disabled).toBe(false);
});

test("an answered reply's field-only form shows Sent and no Send", async () => {
  await render('root = Stack([scope])\nscope = Choice("scope", ["API"])', {
    kind: 'reply', submit: null, answered: { picks: [], values: { scope: 'API' }, skipped: [] },
  });
  expect(host.textContent).toContain('Sent');
  expect(buttons()).not.toContain('Send');
});

test("a reply's Send can be tried again after a failed send", async () => {
  const attempts: number[] = [];
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API"])', async () => {
    attempts.push(attempts.length);
    if (attempts.length === 1) throw new Error('The server did not answer');
  });
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  const first = send();
  if (!first) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => first.click());
  expect(host.textContent).toContain('Not sent. Try again.');
  expect(send()?.disabled).toBe(false);
  const second = send();
  if (!second) throw new Error(`Expected a Send button to retry, got ${buttons().join(', ')}`);
  await act(async () => second.click());
  expect(attempts).toHaveLength(2);
  expect(host.textContent).toContain('Sent');
});

test("a reply's failed send stops asking to retry once its fields are empty", async () => {
  await drawReply('root = Stack([scope])\nscope = Choice("scope", ["API", "Links"], "Scope", true)', async () => {
    throw new Error('The server did not answer');
  });
  const pick = option('API');
  if (!pick) throw new Error(`Expected an option, got ${buttons().join(', ')}`);
  await act(async () => pick.click());
  const first = send();
  if (!first) throw new Error(`Expected a Send button, got ${buttons().join(', ')}`);
  await act(async () => first.click());
  expect(host.textContent).toContain('Not sent. Try again.');
  await act(async () => pick.click());
  expect(send()?.disabled).toBe(true);
  expect(host.textContent).not.toContain('Not sent. Try again.');
});

test("a reply's decision keeps its failure line after the choice is cleared, since a press retries", async () => {
  await drawReply('root = Stack([go])\ngo = Button("Go")', async () => {
    throw new Error('The server did not answer');
  });
  const go = () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Go');
  await act(async () => go()?.click());
  expect(host.textContent).toContain('Not sent. Try again.');
  await act(async () => go()?.click());
  expect(host.textContent).toContain('Not sent. Try again.');
});
