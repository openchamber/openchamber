import { afterAll, describe, expect, mock, test } from 'bun:test';
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
  ResizeObserver: browser.ResizeObserver, IntersectionObserver: browser.IntersectionObserver,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

type Answer = (name: string, text: string) => Promise<void>;
let frameAnswer: Answer | null = null;
let frameAnswered: string | null = null;
const chart = { guestId: 'desk', guestName: 'Desk', name: 'DeskChart', description: 'A chart', args: ['title'], entry: 'chart.html', height: 100, answers: false };
mock.module('./useExtensionBlocks', () => ({ useExtensionBlocks: () => new Map([[chart.name, chart]]) }));
// The real frame needs a browser; these tests are about what the block does with its answer.
mock.module('./ExtensionBlockFrame', () => ({
  ExtensionBlockFrame: ({ answer, answered }: { answer: Answer; answered: string | null }) => {
    frameAnswer = answer;
    frameAnswered = answered;
    return null;
  },
}));

const { UiBlock } = await import('./UiBlock');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');
const { getDefaultTheme } = await import('@/lib/theme/themes');

type Host = React.ComponentProps<typeof UiBlock>['host'];

const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterAll(async () => { await act(() => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = realFetch; });

// SAFETY: UiBlock reads only `currentTheme` from the theme system.
const themeSystem = { currentTheme: getDefaultTheme(false) } as React.ContextType<typeof ThemeSystemContext>;
const SOURCE = 'root = Stack([chart])\nchart = DeskChart("Sales")';
let drawn = 0;
const draw = (host: Host, source = SOURCE) => act(() => root.render(
  <I18nProvider>
    <ThemeSystemContext.Provider value={themeSystem}>
      <UiBlock key={drawn++} source={source} complete host={host} />
    </ThemeSystemContext.Provider>
  </I18nProvider>,
));
const answer = (text: string) => {
  if (!frameAnswer) throw new Error('The frame did not mount');
  return frameAnswer('DeskChart', text);
};

describe('a page with an extension frame', () => {
  const send = () => [...container.querySelectorAll('button')].some((button) => button.textContent === 'Send');

  test('gets a Send button unless the frame answers', async () => {
    await draw({ kind: 'page', answered: null, submit: async () => {} });
    expect(send()).toBe(true);
    chart.answers = true;
    await draw({ kind: 'page', answered: null, submit: async () => {} });
    expect(send()).toBe(false);
    chart.answers = false;
  });
});

describe('a note on a frame that answers', () => {
  const writeNote = async (text: string) => {
    const add = [...container.querySelectorAll('button')].find((button) => button.textContent?.toLowerCase().includes('note'));
    if (!add) throw new Error('Expected the note button');
    await act(async () => add.click());
    const field = container.querySelector('textarea');
    if (!field) throw new Error('Expected the note field');
    // SAFETY: React keeps a textarea's props under this key, onChange among them.
    // happy-dom's textarea does not reach React's change tracking, so the handler is called directly.
    const handlers = Object.entries(field).find(([key]) => key.startsWith('__reactProps'))?.[1] as { onChange: (event: { target: { value: string } }) => void };
    await act(async () => handlers.onChange({ target: { value: text } }));
  };
  const answering = async (run: () => Promise<void>) => {
    chart.answers = true;
    await run();
    chart.answers = false;
  };

  test('goes out with the frame\'s answer in a reply', () => answering(async () => {
    const sent: Array<{ picks: unknown[] }> = [];
    await draw({ kind: 'reply', answered: null, submit: async (data) => { sent.push(data); } });
    await writeNote('only this week');
    await act(async () => { await answer('Yes'); });
    expect(sent[0].picks).toEqual([{ button: 'Yes', value: 'DeskChart', note: 'only this week' }]);
  }));

  test('is an answer on its own in a reply, and the frame hears it', () => answering(async () => {
    const sent: Array<{ picks: unknown[] }> = [];
    await draw({ kind: 'reply', answered: null, submit: async (data) => { sent.push(data); } });
    await writeNote('none of these');
    const send = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Send');
    if (!send) throw new Error('Expected a Send button');
    await act(async () => send.click());
    expect(sent[0].picks).toEqual([{ value: 'DeskChart', note: 'none of these' }]);
    expect(frameAnswered).toBe('none of these');
  }));

  test('goes out with a form that shares the block, and one Send stays', () => answering(async () => {
    const sent: Array<{ picks: unknown[] }> = [];
    const source = 'root = Stack([chart, field])\nchart = DeskChart("Sales")\nfield = Input("name", "Name")';
    await draw({ kind: 'reply', answered: null, submit: async (data) => { sent.push(data); } }, source);
    await writeNote('with a note');
    const sends = [...container.querySelectorAll('button')].filter((button) => button.textContent === 'Send');
    expect(sends).toHaveLength(1);
    await act(async () => sends[0]?.click());
    expect(sent[0].picks).toEqual([{ value: 'DeskChart', note: 'with a note' }]);
  }));

  test('goes out when a button finishes the block', () => answering(async () => {
    const sent: Array<{ picks: unknown[] }> = [];
    const source = 'root = Stack([chart, go])\nchart = DeskChart("Sales")\ngo = Button("Go")';
    await draw({ kind: 'reply', answered: null, submit: async (data) => { sent.push(data); } }, source);
    await writeNote('with a note');
    const go = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Go');
    if (!go) throw new Error('Expected the Go button');
    await act(async () => go.click());
    expect(sent[0].picks).toEqual([{ value: 'DeskChart', note: 'with a note' }, { button: 'Go' }]);
  }));

  test('is an answer on its own on a page', () => answering(async () => {
    const sent: Array<{ data: { note?: string } }> = [];
    await draw({ kind: 'page', answered: null, submit: async (data) => { sent.push(data); } });
    await writeNote('none of these');
    const send = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Send');
    if (!send) throw new Error('Expected a Send button');
    await act(async () => send.click());
    expect(sent[0].data.note).toBe('none of these');
  }));

  test('a reloaded reply shows the note it sent', () => answering(async () => {
    await draw({ kind: 'reply', answered: { picks: [{ value: 'DeskChart', note: 'kept' }], values: {}, skipped: [] }, submit: async () => {} });
    expect(container.querySelector('textarea')?.value).toBe('kept');
    expect(frameAnswered).toBe('kept');
  }));
});

describe('an answer from an extension frame', () => {
  test('two answers at once send one', async () => {
    const sent: unknown[] = [];
    let finish = () => {};
    await draw({ kind: 'reply', answered: null, submit: (data) => {
      sent.push(data);
      return new Promise<void>((resolve) => { finish = resolve; });
    } });
    const first = answer('Yes');
    const second = answer('No');
    await expect(second).rejects.toThrow('cannot take an answer');
    await act(async () => { finish(); await first; });
    expect(sent).toHaveLength(1);
    expect(frameAnswered).toBe('Yes');
    await expect(answer('Again')).rejects.toThrow('cannot take an answer');
  });

  test('a failed answer can be sent again', async () => {
    let attempts = 0;
    await draw({ kind: 'reply', answered: null, submit: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
    } });
    await act(async () => { await expect(answer('Yes')).rejects.toThrow('did not reach'); });
    await act(async () => { await answer('Yes'); });
    expect(attempts).toBe(2);
  });

  test('in a reply it answers for the whole block, and a card nobody answered stays skipped', async () => {
    const sent: Array<{ picks: unknown[]; skipped: string[] }> = [];
    const source = 'root = Stack([chart, c])\nchart = DeskChart("Sales")\nc = Card("Ship", [Button("Go", "primary", "ship")])';
    await draw({ kind: 'reply', answered: null, submit: async (data) => { sent.push(data); } }, source);
    await act(async () => { await answer('Yes'); });
    expect(sent[0].picks).toEqual([{ button: 'Yes', value: 'DeskChart' }]);
    expect(sent[0].skipped).toEqual(['Ship']);
  });

  test('on a page it keeps the note the user wrote', async () => {
    const sent: Array<{ summary: string; data: { button?: string; note?: string } }> = [];
    await draw({ kind: 'page', answered: null, submit: async (data) => { sent.push(data); } });
    const add = [...container.querySelectorAll('button')].find((button) => button.textContent?.toLowerCase().includes('note'));
    if (!add) throw new Error('Expected the note button');
    await act(async () => add.click());
    const field = container.querySelector('textarea');
    if (!field) throw new Error('Expected the note field');
    // SAFETY: React keeps a textarea's props under this key, onChange among them.
    // happy-dom's textarea does not reach React's change tracking, so the handler is called directly.
    const handlers = Object.entries(field).find(([key]) => key.startsWith('__reactProps'))?.[1] as { onChange: (event: { target: { value: string } }) => void };
    await act(async () => handlers.onChange({ target: { value: 'only this week' } }));
    await act(async () => { await answer('Yes'); });
    expect(sent[0].data).toMatchObject({ button: 'Yes', note: 'only this week' });
    expect(sent[0].summary).toContain('only this week');
  });
});
