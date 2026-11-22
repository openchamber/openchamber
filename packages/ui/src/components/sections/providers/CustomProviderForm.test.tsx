import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { CustomProviderFormState } from './custom-provider-form';

const dom = new Window({ url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom, document: dom.document, CustomEvent: dom.CustomEvent, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, KeyboardEvent: dom.KeyboardEvent, MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver, IntersectionObserver: class { observe() {} disconnect() {} }, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { CustomProviderForm } = await import('./CustomProviderForm');
const { CanonicalProviderPicker } = await import('./CanonicalProviderPicker');

const catalog = [{ id: 'anthropic', name: 'Anthropic' }, { id: 'openrouter', name: 'OpenRouter' }];

const savedProvider: CustomProviderFormState = {
  providerID: 'campus-llm',
  name: 'Campus LLM',
  icon: null,
  logo: null,
  protocol: 'openai-chat',
  baseURL: 'https://llm.example.edu/v1',
  apiKey: '',
  models: [{
    row: 'saved-1',
    id: 'fast',
    name: 'Fast',
    contextWindow: '128000',
    maxOutputTokens: '16384',
    inputCapabilities: ['text', 'image'],
    outputCapabilities: ['text'],
    tools: true,
    capabilitiesKnown: { tools: true, input: true, output: true },
    variants: '',
    savedVariants: {},
  }],
  headers: [{ row: 'header-1', key: '', value: '' }],
  tls: { cert: '', key: '', passphrase: '' },
  canonical: '',
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const render = async (element: React.ReactElement) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
};

const buttonByText = (container: HTMLElement, text: string) => {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().includes(text));
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
};

test('saved models start collapsed with a one-line summary and open on click', async () => {
  const container = await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} mode="edit" initialValues={savedProvider} onSubmit={() => {}} />,
  );
  const row = buttonByText(container, 'Fast');
  expect(row.getAttribute('aria-expanded')).toBe('false');
  expect(row.textContent).toContain('128K');
  expect(row.textContent).toContain('image');
  expect(container.querySelector('input[aria-label="Context window"]')).toBeNull();

  await act(async () => row.click());
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Context window"]')?.value).toBe('128000');
});

test('the client certificate stays folded until opened, and opens by itself for a saved one or an error', async () => {
  const certificateInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[aria-label="Certificate file"]');
  const folded = await render(<CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} onSubmit={() => {}} />);
  expect(certificateInput(folded)).toBeNull();
  await act(async () => buttonByText(folded, 'Client certificate').click());
  expect(certificateInput(folded)).not.toBeNull();

  const saved = await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} mode="edit" onSubmit={() => {}}
      initialValues={{ ...savedProvider, tls: { cert: '/etc/client.pem', key: '/etc/client.key', passphrase: '' } }} />,
  );
  expect(certificateInput(saved)?.value).toBe('/etc/client.pem');

  const broken = await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} mode="edit" onSubmit={() => {}}
      initialValues={{ ...savedProvider, apiKey: 'sk-test', tls: { cert: '', key: '', passphrase: 'secret' } }} />,
  );
  // A passphrase alone is a saved certificate too, so the section is open; fold it, then let Save open it.
  await act(async () => buttonByText(broken, 'Client certificate').click());
  expect(certificateInput(broken)).toBeNull();
  await act(async () => buttonByText(broken, 'Update provider').click());
  expect(certificateInput(broken)).not.toBeNull();
});

const canonicalTrigger = () => document.querySelector<HTMLElement>('[aria-label="Model defaults from"]');

const openCanonicalPicker = async () => {
  const trigger = canonicalTrigger();
  if (!trigger) throw new Error('Missing canonical provider picker');
  // The menu opens on mousedown.
  await act(async () => {
    const pointerInit: PointerEventInit = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse' };
    const mouseInit: MouseEventInit = { bubbles: true, cancelable: true, button: 0 };
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', pointerInit));
    trigger.dispatchEvent(new window.MouseEvent('mousedown', mouseInit));
    trigger.dispatchEvent(new window.PointerEvent('pointerup', pointerInit));
    trigger.dispatchEvent(new window.MouseEvent('mouseup', mouseInit));
    trigger.dispatchEvent(new window.MouseEvent('click', mouseInit));
  });
  const search = document.querySelector<HTMLInputElement>('input[data-slot="command-input"]');
  if (!search) throw new Error('Missing canonical provider search');
  return search;
};

const pickerItems = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].map((item) => item.textContent?.trim());

const typeSearch = async (search: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, text);
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
});

const chooseCanonical = async (name: string) => {
  await openCanonicalPicker();
  const item = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((candidate) => candidate.textContent?.trim() === name);
  if (!item) throw new Error(`Missing option: ${name}`);
  await act(async () => item.click());
};

test('a saved canonical provider survives a provider list that fails to load', async () => {
  const plans: Array<{ canonical?: string | null }> = [];
  const failed = await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders="failed" mode="edit" allowExistingAuth
      initialValues={{ ...savedProvider, canonical: 'command-code' }} onSubmit={(plan) => { plans.push(plan.config); }} />,
  );
  expect(canonicalTrigger()?.textContent).toContain('command-code');
  expect(failed.textContent).toContain('The provider list could not be loaded');
  await act(async () => buttonByText(failed, 'Update provider').click());
  expect(plans[0]?.canonical).toBe('command-code');
});

test('the canonical provider lists what OpenCode knows and shows by its name', async () => {
  await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={[...catalog, { id: 'typesafe', name: 'TypeSafe' }]} mode="edit" initialValues={{ ...savedProvider, canonical: 'openrouter' }} onSubmit={() => {}} />,
  );
  expect(canonicalTrigger()?.textContent).toContain('OpenRouter');
  await openCanonicalPicker();
  expect(pickerItems()).toEqual(['None', 'Anthropic', 'OpenRouter', 'TypeSafe']);
});

test('picking the shown None keeps an unread canonical provider, while a deliberate None clears it', async () => {
  const saveAfter = async (canonical: string | null, names: string[]) => {
    const plans: Array<{ canonical?: string | null }> = [];
    const container = await render(
      <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} mode="edit" allowExistingAuth
        initialValues={{ ...savedProvider, canonical }} onSubmit={(plan) => { plans.push(plan.config); }} />,
    );
    for (const name of names) await chooseCanonical(name);
    await act(async () => buttonByText(container, 'Update provider').click());
    cleanups.pop()?.();
    return plans[0];
  };

  expect(await saveAfter(null, ['None'])).not.toHaveProperty('canonical');
  expect((await saveAfter(null, ['OpenRouter', 'None']))?.canonical).toBeNull();
  expect((await saveAfter('openrouter', ['None']))?.canonical).toBeNull();
});

test('the provider being edited is not offered as its own source', async () => {
  await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} mode="edit" initialValues={{ ...savedProvider, providerID: 'openrouter', canonical: '' }} onSubmit={() => {}} />,
  );
  await openCanonicalPicker();
  expect(pickerItems()).toEqual(['None', 'Anthropic']);
});

test('a long provider list mounts a bounded window and search reaches a provider near its end', async () => {
  const providers = Array.from({ length: 320 }, (_, index) => ({ id: `p${String(index).padStart(3, '0')}`, name: `Provider ${String(index).padStart(3, '0')}` }));
  const picked: string[] = [];
  await render(<CanonicalProviderPicker value="" providers={providers} loading={false} disabled={false} onSelect={(id) => picked.push(id)} />);
  const search = await openCanonicalPicker();
  expect(pickerItems()).toHaveLength(200);
  expect(pickerItems()[0]).toBe('None');

  await typeSearch(search, 'provider 31');
  expect(pickerItems()).toEqual(Array.from({ length: 10 }, (_, index) => `Provider 31${index}`));
  await act(async () => search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(picked).toEqual(['p310']);

  await openCanonicalPicker();
  await typeSearch(document.querySelector<HTMLInputElement>('input[data-slot="command-input"]')!, 'nothing like this');
  expect(document.querySelector('[data-slot="command-list"]')?.textContent).toContain('No matching providers');
});

test('the form says which source OpenCode uses when a lower config layer sets one', async () => {
  const container = await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} mode="edit"
      initialValues={{ ...savedProvider, canonical: '', inheritedCanonical: { provider: 'openrouter', path: '/home/me/.config/opencode/opencode.json' } }} onSubmit={() => {}} />,
  );
  expect(container.textContent).toContain('With None, OpenCode still takes model defaults from OpenRouter, set in /home/me/.config/opencode/opencode.json.');
});

test('a new provider opens its first blank model row for editing', async () => {
  const container = await render(<CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} onSubmit={() => {}} />);
  expect(buttonByText(container, 'New model').getAttribute('aria-expanded')).toBe('true');
});

test('found models are reviewed once and added as collapsed rows next to the saved ones', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({
    models: [
      { id: 'fast', name: 'fast' },
      { id: 'vision-pro', name: 'Vision Pro', limit: { context: 200000 } },
      { id: 'tiny', name: 'tiny' },
    ],
    enrichment: { requested: true, available: true },
  }), originalFetch);
  cleanups.push(() => { globalThis.fetch = originalFetch; });

  const container = await render(
    <CustomProviderForm existingProviderIDs={new Set()} catalogProviders={catalog} mode="edit" initialValues={savedProvider} onSubmit={() => {}} />,
  );
  await act(async () => buttonByText(container, 'Find models').click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  // The saved model reads as already added; the other two start selected.
  expect(container.textContent).toContain('Models found');
  expect(container.textContent).toContain('Already added');
  await act(async () => buttonByText(container, 'Add selected (2)').click());

  expect(container.textContent).not.toContain('Models found');
  const added = buttonByText(container, 'Vision Pro');
  expect(added.getAttribute('aria-expanded')).toBe('false');
  expect(added.textContent).toContain('200K');
  expect(buttonByText(container, 'tiny').getAttribute('aria-expanded')).toBe('false');
});
