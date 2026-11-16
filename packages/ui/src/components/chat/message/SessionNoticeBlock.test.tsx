import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => '/project',
  resolveEffectiveDirectory: () => '/project',
}));

import { ChatSurfaceProvider } from '@/components/chat/ChatSurfaceContext';
import { I18nProvider } from '@/lib/i18n';
import type { PageAnswerNotice, PullRequestNotice } from '@/lib/opencode/session-notices';
import { SessionNoticeBlock } from './SessionNoticeBlock';

const url = 'https://github.com/acme/app/pull/7';
const notice: PullRequestNotice = {
  kind: 'pull-request',
  url,
  number: 7,
  events: ['checks-failed', 'activity'],
  failedChecks: ['lint', 'unit'],
  authors: ['bob'],
  text: `<openchamber-pull-request url="${url}" number="7">\nPull request #7: a check failed.\n</openchamber-pull-request>`,
};

describe('SessionNoticeBlock: a pull request wake', () => {
  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT'];
  let windowInstance: Window;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;
  let host: HTMLDivElement;
  let root: Root;
  let open: ReturnType<typeof mock>;

  beforeEach(async () => {
    open = mock(() => null);
    windowInstance = new Window();
    Object.defineProperty(windowInstance, 'open', { value: open });
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MouseEvent: windowInstance.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    // The mini chat has no panel or board, so its rows always leave for the browser.
    await act(async () => root.render(
      <I18nProvider>
        <ChatSurfaceProvider mode="mini-chat">
          <SessionNoticeBlock notice={notice} blockId="notice:msg_1" />
        </ChatSurfaceProvider>
      </I18nProvider>,
    ));
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const click = async (init: MouseEventInit = {}): Promise<boolean> => {
    const link = host.querySelector('a');
    let notCancelled = false;
    await act(async () => {
      notCancelled = link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) ?? false;
    });
    return notCancelled;
  };

  test('reads as one line of what changed, without the envelope or a way to expand it', () => {
    const text = host.textContent ?? '';
    expect(text).toContain('Pull request #7');
    expect(text).toContain('Checks failed: lint, unit');
    expect(text).toContain('New comment or review from bob');
    expect(text).not.toContain('openchamber-pull-request');
    expect(host.querySelector('[aria-expanded]')).toBeNull();
  });

  test('a click in the mini chat opens the pull request in the browser', async () => {
    expect(host.querySelector('a')?.getAttribute('href')).toBe(url);
    expect(await click()).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  test('a modified click keeps the browser\'s own meaning', async () => {
    expect(await click({ metaKey: true })).toBe(true);
  });
});

describe('SessionNoticeBlock: the answer to a page shown with answerLater', () => {
  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  let windowInstance: Window;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;
  let host: HTMLDivElement;
  let root: Root;

  const render = async (notice: PageAnswerNotice) => {
    await act(async () => root.render(
      <I18nProvider>
        <SessionNoticeBlock notice={notice} blockId="notice:msg_1" />
      </I18nProvider>,
    ));
  };

  beforeEach(() => {
    windowInstance = new Window();
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const envelope = '<openchamber-page-answer call="call_1" outcome="answered">\n...\n</openchamber-page-answer>';

  test('an answer reads as the page and the choice, folded, without the envelope', async () => {
    await render({ kind: 'page-answer', title: 'Schema', outcome: 'answered', summary: 'B', details: '```json\n"b"\n```', text: envelope });
    const text = host.textContent ?? '';
    expect(text).toContain('Answer to Schema: B');
    expect(text).not.toContain('openchamber-page-answer');
    expect(host.querySelector('[aria-expanded]')).not.toBeNull();
  });

  test('a declined page is one line with nothing to expand', async () => {
    await render({ kind: 'page-answer', title: 'Schema', outcome: 'declined', summary: '', details: '', text: envelope });
    expect(host.textContent).toContain('You declined Schema');
    expect(host.querySelector('[aria-expanded]')).toBeNull();
  });
});
