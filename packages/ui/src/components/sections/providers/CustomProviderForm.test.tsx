import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { CustomProviderFormState } from './custom-provider-form';

const dom = new Window({ url: 'http://localhost' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node, Event: dom.Event,
  MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, MutationObserver: dom.MutationObserver,
  ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { CustomProviderForm } = await import('./CustomProviderForm');

const savedProvider: CustomProviderFormState = {
  providerID: 'campus-llm',
  name: 'Campus LLM',
  icon: null,
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
    capabilitiesKnown: true,
    variants: '',
    savedVariants: {},
  }],
  headers: [{ row: 'header-1', key: '', value: '' }],
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
    <CustomProviderForm existingProviderIDs={new Set()} mode="edit" initialValues={savedProvider} onSubmit={() => {}} />,
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

test('a new provider opens its first blank model row for editing', async () => {
  const container = await render(<CustomProviderForm existingProviderIDs={new Set()} onSubmit={() => {}} />);
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
    <CustomProviderForm existingProviderIDs={new Set()} mode="edit" initialValues={savedProvider} onSubmit={() => {}} />,
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
