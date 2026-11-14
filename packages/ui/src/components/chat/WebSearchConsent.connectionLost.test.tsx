import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ExternalToast } from 'sonner';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

const { ConnectionLostError } = await import('@/sync/connection-lost-error');

type FormAnswer = import('@/sync/session-actions').FormAnswer;
type Call = { kind: 'reply' | 'cancel'; answer?: FormAnswer };
let calls: Call[] = [];
let failWith: Error | null = null;
let toasts: Array<{ message: React.ReactNode; data?: ExternalToast }> = [];

const settle = async (call: Call) => {
  calls.push(call);
  if (failWith) throw failWith;
};

const actualSessionActions = await import('@/sync/session-actions');
mock.module('@/sync/session-actions', () => ({
  ...actualSessionActions,
  replyToForm: (_sessionID: string, _formID: string, answer: FormAnswer) => settle({ kind: 'reply', answer }),
  cancelForm: () => settle({ kind: 'cancel' }),
}));
const actualUi = await import('@/components/ui');
mock.module('@/components/ui', () => ({
  ...actualUi,
  toast: { ...actualUi.toast, error: (message: React.ReactNode, data?: ExternalToast) => { toasts.push({ message, data }); return 1; } },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));

const { WebSearchConsentCard } = await import('./WebSearchConsent');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { dict: ukDict } = await import('@/lib/i18n/messages/uk');

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    Event: happyWindow.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const form: import('@/lib/opencode/model').FormRequest = { id: 'form-1', sessionID: 'session-1', title: 'Web search', fields: [{ key: 'choice', type: 'boolean' }] };
const consent = {
  step: 'choice',
  fieldKey: 'choice',
  options: [{ value: 'allow', label: 'Allow' }],
} as const satisfies import('@/lib/opencode/websearch').WebSearchConsent;

const click = async (container: HTMLElement, label: string) => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label);
  if (!button) throw new Error(`Missing button ${label}`);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
};

describe('WebSearchConsentCard when the connection is down', () => {
  const previousI18n = useI18nStore.getState();
  let dom: ReturnType<typeof installDom>;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    calls = [];
    toasts = [];
    failWith = null;
    useI18nStore.setState({ locale: 'uk', dictionary: ukDict });
    dom = installDom();
    root = createRoot(dom.container);
    await act(async () => root.render(<I18nProvider><WebSearchConsentCard form={form} consent={consent} /></I18nProvider>));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
    useI18nStore.setState({ locale: previousI18n.locale, dictionary: previousI18n.dictionary });
  });

  test('a refused answer names the disconnect reason in the user language and the same click retries it', async () => {
    failWith = new ConnectionLostError({ reason: '1006', everConnected: true });
    await click(dom.container, ukDict['chat.webSearchConsent.allow']);

    const expected = ukDict['chat.formCard.connectionLostReason'].replace('{reason}', '1006');
    // No description: Copy on an error toast copies the message itself.
    expect(toasts).toEqual([{ message: expected, data: undefined }]);

    failWith = null;
    await click(dom.container, ukDict['chat.webSearchConsent.allow']);
    expect(calls).toEqual([
      { kind: 'reply', answer: { choice: 'allow' } },
      { kind: 'reply', answer: { choice: 'allow' } },
    ]);
    expect(toasts).toHaveLength(1);
  });

  test('a refused cancel says the connection was lost and stays retryable', async () => {
    failWith = new ConnectionLostError({ reason: null, everConnected: true });
    await click(dom.container, ukDict['chat.webSearchConsent.notNow']);
    expect(toasts).toEqual([{ message: ukDict['chat.formCard.connectionLost'], data: undefined }]);

    failWith = null;
    await click(dom.container, ukDict['chat.webSearchConsent.notNow']);
    expect(calls).toEqual([{ kind: 'cancel' }, { kind: 'cancel' }]);
  });

  test('a page that never connected says so instead of a lost connection', async () => {
    failWith = new ConnectionLostError({ reason: null, everConnected: false });
    await click(dom.container, ukDict['chat.webSearchConsent.allow']);
    expect(toasts).toEqual([{ message: ukDict['chat.formCard.notConnected'], data: undefined }]);
  });
});
