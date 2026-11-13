import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { CredentialConnection, SignInMethod } from './providerAuth';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ProviderAuthMethodCards } = await import('./ProviderAuthMethodCards');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** OpenCode Go signs in through the Console's `opencode` integration. */
const consoleSignIn: SignInMethod = { id: 'console', type: 'oauth', label: 'OpenCode Console account' };
const goKey: CredentialConnection = { type: 'credential', id: 'cred_key', label: 'OpenCode Go', method: 'key' };
const consoleAccount: CredentialConnection = { type: 'credential', id: 'cred_console', label: 'Default', method: 'oauth' };

const render = async (input: {
  showApiKey?: boolean;
  signInMethods?: SignInMethod[];
  credentials?: CredentialConnection[];
  activeId?: string | null;
  canAdd?: boolean;
  inUseWithoutCredential?: CredentialConnection['method'] | null;
}) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider>
      <ProviderAuthMethodCards
        integrationId="opencode-go"
        showApiKey={input.showApiKey ?? true}
        keyMethod={{ type: 'key' }}
        signInIntegrationId="opencode"
        signInMethods={input.signInMethods ?? [consoleSignIn]}
        credentials={input.credentials ?? []}
        accounts={input.credentials ? {
          activeId: input.activeId ?? null,
          unusedIds: new Set(),
          busyId: null,
          canSwitch: false,
          showActive: true,
          onActivate: () => {},
          onRename: () => {},
          onRemove: () => {},
        } : undefined}
        canAdd={input.canAdd ?? true}
        inUseWithoutCredential={input.inUseWithoutCredential ?? null}
        connectKey={async () => {}}
        onKeySaved={() => {}}
        onSignedIn={() => {}}
      />
    </I18nProvider>,
  ));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const cards = () => [...host.querySelectorAll('button')].filter((button) => button.querySelector('[aria-live]'));
  const card = (name: string) => {
    const trigger = cards().find((button) => button.textContent?.includes(name));
    if (!trigger) throw new Error(`Missing card: ${name}`);
    return trigger;
  };
  const button = (text: string) => [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  return {
    host,
    card,
    cards,
    button,
    keyField: () => host.querySelector('input[type="password"]'),
    click: async (node: HTMLElement | undefined) => {
      if (!node) throw new Error('Missing element');
      await act(async () => node.click());
    },
  };
};

test('each way to connect is its own card, closed until picked', async () => {
  const view = await render({});

  expect(view.card('API key').textContent).toContain('Not connected');
  expect(view.card('OpenCode Console account').textContent).toContain('Sign in through your browser.');
  expect(view.keyField()).toBeNull();

  await view.click(view.card('API key'));
  expect(view.keyField()).not.toBeNull();
  expect(view.button('Connect')).toBe(undefined);

  await view.click(view.card('OpenCode Console account'));
  expect(view.button('Connect')).not.toBe(undefined);
});

test('a provider with one way to connect starts with that card open', async () => {
  const view = await render({ signInMethods: [] });
  expect(view.keyField()).not.toBeNull();
});

test('each card holds its own accounts and says which kind is in use', async () => {
  const view = await render({ credentials: [goKey, consoleAccount], activeId: 'cred_key' });

  expect(view.card('API key').textContent).toContain('In use');
  expect(view.card('OpenCode Console account').textContent).toContain('Not in use');

  await view.click(view.card('API key'));
  expect(view.host.textContent).toContain('OpenCode Go');
  expect(view.host.textContent).not.toContain('Default');
  // A stored key keeps the empty field behind a button, so it never reads as "replace".
  expect(view.keyField()).toBeNull();
  await view.click(view.button('Add account'));
  expect(view.keyField()).not.toBeNull();

  // Closing the card drops the half-added key, so it reopens on Add account.
  await view.click(view.card('API key'));
  await view.click(view.card('API key'));
  expect(view.keyField()).toBeNull();
});

test('a sign-in card with an account offers another behind Add account', async () => {
  const view = await render({ credentials: [goKey, consoleAccount], activeId: 'cred_key' });

  await view.click(view.card('OpenCode Console account'));
  expect(view.host.textContent).toContain('Default');
  expect(view.button('Connect')).toBe(undefined);
  await view.click(view.button('Add account'));
  expect(view.button('Connect')).not.toBe(undefined);
});

test('a credential OpenCode wants signed in again says so on its card', async () => {
  const expired: CredentialConnection = {
    ...consoleAccount,
    status: { status: 'needs_auth', message: 'Session expired' },
  };
  const view = await render({ credentials: [goKey, expired], activeId: 'cred_key' });
  expect(view.card('OpenCode Console account').textContent).toContain('Sign in again');
});

test('several sign-in methods share one card, since an account does not record which one made it', async () => {
  const view = await render({
    signInMethods: [
      { id: 'chatgpt', type: 'oauth', label: 'Sign in with ChatGPT' },
      { id: 'codex-browser', type: 'oauth', label: 'Codex browser (legacy)' },
    ],
  });
  expect(view.cards().length).toBe(2);

  await view.click(view.card('Sign in with ChatGPT'));
  expect(view.host.textContent).toContain('Codex browser (legacy)');
  expect([...view.host.querySelectorAll('button')].filter((node) => node.textContent?.trim() === 'Connect').length).toBe(2);
});

test('enterprise mode keeps stored accounts and offers nothing new', async () => {
  const view = await render({ credentials: [goKey], activeId: 'cred_key', canAdd: false });

  expect(view.cards().length).toBe(1);
  expect(view.host.textContent).toContain('OpenCode Go');
  expect(view.button('Add account')).toBe(undefined);
  expect(view.keyField()).toBeNull();
});

test('a key OpenCode reads from the environment marks the key card in use', async () => {
  const view = await render({ credentials: [], inUseWithoutCredential: 'key' });
  expect(view.card('API key').textContent).toContain('In use');
  expect(view.card('OpenCode Console account').textContent).toContain('Not connected');
});

test('machine credentials without a card of their kind mark the key card', async () => {
  const view = await render({ signInMethods: [], credentials: [], inUseWithoutCredential: 'external' });
  expect(view.cards().length).toBe(1);
  expect(view.card('API key').textContent).toContain('In use');
});
