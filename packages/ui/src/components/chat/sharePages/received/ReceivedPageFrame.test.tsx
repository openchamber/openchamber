import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { JsonValue } from '@/lib/opencode/model';

/** The app's side of a received page: what it hands the shell, and what it does with an answer. */

const theme = { variant: 'light' };
const confirms: Array<{ title: string; message?: string }> = [];
let confirmAnswer = false;
const answers: Array<{ receivedId: string; data: JsonValue; summary: string }> = [];

mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: theme.variant } } }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: 'en' }) }));
mock.module('@/components/ui/confirm-dialog', () => ({
  useConfirmDialog: () => ({
    confirm: async (request: { title: string; message?: string }) => {
      confirms.push(request);
      return confirmAnswer;
    },
    dialog: null,
  }),
}));
mock.module('@/lib/received-pages/api', () => ({
  answerReceivedPage: async (receivedId: string, answer: { data: JsonValue; summary: string }) => {
    answers.push({ receivedId, ...answer });
    return { receivedId };
  },
}));

const { ReceivedPageFrame } = await import('./ReceivedPageFrame');

type Posted = Record<string, JsonValue>;

describe('a received page in the app', () => {
  let dom: Window;
  let root: Root;
  let toShell: Posted[];
  const shellWindow = { postMessage: (message: Posted) => { toShell.push(message); } };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/', settings: { disableIframePageLoading: true } });
    Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, DOMParser: dom.DOMParser, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
    toShell = [];
    confirms.length = 0;
    answers.length = 0;
    theme.variant = 'light';
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  const render = async (answer: JsonValue | null) => {
    await act(async () => {
      root.render(<ReceivedPageFrame receivedId="rp_1" html="<p>page</p>" title="Page" takesAnswer={answer === null} answer={answer} onAnswered={() => undefined} />);
    });
    const frame = document.querySelector('iframe');
    if (!frame) throw new Error('no frame');
    // A stand-in for the shell's window, which the test owns.
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: shellWindow });
    return frame;
  };

  const load = async (frame: Element) => {
    await act(async () => { frame.dispatchEvent(new Event('load')); });
  };

  const fromShell = async (data: Posted) => {
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event('message'), { source: shellWindow, data }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const submit = { source: 'openchamber-share-document', type: 'submit', data: { pick: 'b' }, summary: 'Pick B' };

  test('asks before sending an answer the shell could not tie to a click, and sends nothing on Cancel', async () => {
    await load(await render(null));
    confirmAnswer = false;
    await fromShell({ ...submit, verified: false });
    expect(confirms).toMatchObject([{ title: 'chat.sharedPage.confirm.title', message: 'Pick B' }]);
    expect(answers).toEqual([]);
    expect(toShell.at(-1)).toMatchObject({ type: 'submit-result', ok: false });

    confirmAnswer = true;
    await fromShell({ ...submit, verified: false });
    expect(answers).toEqual([{ receivedId: 'rp_1', data: { pick: 'b' }, summary: 'Pick B' }]);
  });

  test('sends a verified answer without asking', async () => {
    await load(await render(null));
    await fromShell({ ...submit, verified: true });
    expect(confirms).toEqual([]);
    expect(answers).toHaveLength(1);
  });

  test('hands a shell reloaded after the answer (a theme switch) the page with that answer', async () => {
    const frame = await render(null);
    await load(frame);
    const first = toShell.find((message) => message.type === 'page');
    expect(String(first?.page)).not.toContain('oc-share-answer');
    // The answer arrives while the shell stays loaded: a message, no new page.
    await render({ pick: 'b' });
    expect(toShell.filter((message) => message.type === 'page')).toHaveLength(1);
    expect(toShell.at(-1)).toMatchObject({ type: 'init', answer: { pick: 'b' } });
    // The theme switches: the shell reloads and gets the page again, now with the answer inside.
    theme.variant = 'dark';
    await load(await render({ pick: 'b' }));
    const again = toShell.filter((message) => message.type === 'page').at(-1);
    expect(String(again?.page)).toContain('oc-share-answer');
  });
});
