import { expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import type { ToolPart } from '@/lib/opencode/model';
import type { RequestedSecret } from '@/lib/opencode/tools';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/sync/sync-context', () => ({ useSessionDirectory: () => '/project' }));
mock.module('@/lib/secretRequestAnswer', () => ({ answerSecretRequest: async () => undefined }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));
mock.module('@/components/chat/lib/scroll/timelineScrollIntent', () => ({ dispatchPageWaiting: () => undefined }));

const { createRoot } = await import('react-dom/client');
const { SecretRequestCard } = await import('./SecretRequestCard');

test('the eye reveals the typed value and hides it again', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const part: ToolPart = {
    id: 'part-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    tool: 'openchamber_secret',
    callID: 'call-1',
    state: { status: 'pending', input: {}, raw: '' },
  };
  const request: RequestedSecret = { label: 'API key', reason: 'Needed for the test run', placeholder: undefined, state: 'waiting' };

  try {
    await act(async () => root.render(<SecretRequestCard part={part} request={request} />));
    const input = () => container.querySelector<HTMLInputElement>('input[aria-label="chat.secretRequest.inputLabel"]')!;
    const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!;

    expect(input().type).toBe('password');
    expect(toggle().getAttribute('aria-label')).toBe('chat.secretRequest.showSecret');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')!.set!.call(input(), 'sk-test-value');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input().value).toBe('sk-test-value');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);

    await act(async () => toggle().click());
    expect(input().type).toBe('text');
    expect(input().value).toBe('sk-test-value');
    expect(toggle().getAttribute('aria-label')).toBe('chat.secretRequest.hideSecret');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    await act(async () => toggle().click());
    expect(input().type).toBe('password');
    expect(input().value).toBe('sk-test-value');
    expect(toggle().getAttribute('aria-label')).toBe('chat.secretRequest.showSecret');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    browser.close();
  }
});
