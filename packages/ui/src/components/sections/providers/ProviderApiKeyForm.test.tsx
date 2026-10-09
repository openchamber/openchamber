import { afterAll, afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { IntegrationKeyMethod } from '@opencode/client';
import type { IntegrationKeyRequest } from './ProviderApiKeyForm';

const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, Event: browser.Event,
  MutationObserver: browser.MutationObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ProviderApiKeyForm } = await import('./ProviderApiKeyForm');

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

/** The key method OpenCode 2.0.23 ships for `cloudflare-ai-gateway`. */
const cloudflareGatewayKey: IntegrationKeyMethod = {
  type: 'key',
  label: 'Gateway API token',
  form: [
    { key: 'accountId', title: 'Enter your Cloudflare Account ID', required: true, type: 'string', placeholder: 'e.g. 1234567890abcdef1234567890abcdef' },
    { key: 'gatewayId', title: 'Enter your Cloudflare AI Gateway ID', required: true, type: 'string', placeholder: 'e.g. my-gateway' },
  ],
};

const render = async (keyMethod: IntegrationKeyMethod | undefined) => {
  const requests: IntegrationKeyRequest[] = [];
  let saved = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <I18nProvider>
      <ProviderApiKeyForm
        integrationId="cloudflare-ai-gateway"
        keyMethod={keyMethod}
        connectKey={async (request) => { requests.push(request); }}
        onSaved={() => { saved += 1; }}
      />
    </I18nProvider>,
  ));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });

  const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Input value setter missing');
  const input = (selector: string) => {
    const element = host.querySelector<HTMLInputElement>(selector);
    if (!element) throw new Error(`Missing input: ${selector}`);
    return element;
  };
  return {
    host,
    requests,
    saved: () => saved,
    input,
    type: (selector: string, text: string) => act(async () => {
      const element = input(selector);
      setter.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }),
    save: () => act(async () => {
      const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Save Key');
      if (!button) throw new Error('Missing save button');
      button.click();
    }),
  };
};

const accountId = 'input[aria-label="Enter your Cloudflare Account ID"]';
const gatewayId = 'input[aria-label="Enter your Cloudflare AI Gateway ID"]';

test('a key method with a form shows its fields under the key', async () => {
  const form = await render(cloudflareGatewayKey);
  expect(form.input(accountId).placeholder).toBe('e.g. 1234567890abcdef1234567890abcdef');
  expect(form.input(gatewayId).placeholder).toBe('e.g. my-gateway');
  expect(form.host.textContent).toContain('Enter your Cloudflare AI Gateway ID');
});

test('a blank required field stops the save and names the field', async () => {
  const form = await render(cloudflareGatewayKey);
  await form.type('input[type="password"]', 'cfut_TEST');
  await form.type(accountId, '0'.repeat(32));
  await form.save();

  expect(form.requests).toEqual([]);
  expect(form.host.textContent).toContain('Fill in “Enter your Cloudflare AI Gateway ID” to continue');
});

test('the key is sent with the answered fields', async () => {
  const form = await render(cloudflareGatewayKey);
  await form.type('input[type="password"]', ' cfut_TEST ');
  await form.type(accountId, '0'.repeat(32));
  await form.type(gatewayId, ' default ');
  await form.save();

  expect(form.requests).toEqual([{
    integrationID: 'cloudflare-ai-gateway',
    key: 'cfut_TEST',
    answer: { accountId: '0'.repeat(32), gatewayId: 'default' },
  }]);
  expect(form.saved()).toBe(1);
  expect(form.input('input[type="password"]').value).toBe('');
});

test('a key method without a form sends the bare key', async () => {
  const form = await render({ type: 'key', label: 'API key' });
  expect(form.host.querySelectorAll('input').length).toBe(1);
  await form.type('input[type="password"]', 'sk-test');
  await form.save();

  expect(form.requests).toEqual([{ integrationID: 'cloudflare-ai-gateway', key: 'sk-test' }]);
});

test('a provider OpenCode has no integration for takes a bare key', async () => {
  const form = await render(undefined);
  await form.type('input[type="password"]', 'sk-test');
  await form.save();

  expect(form.requests).toEqual([{ integrationID: 'cloudflare-ai-gateway', key: 'sk-test' }]);
});
