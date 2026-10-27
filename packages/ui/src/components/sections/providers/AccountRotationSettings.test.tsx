import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { CredentialConnection } from './providerAuth';

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
const { AccountRotationSettings } = await import('./AccountRotationSettings');
const { getSettingsSaveState, reportSettingsSaveState } = await import('@/lib/persistence');

const accounts: CredentialConnection[] = [
  { type: 'credential', id: 'a', label: 'First sign-in', method: 'oauth' },
  { type: 'credential', id: 'b', label: 'Second sign-in', method: 'oauth' },
  { type: 'credential', id: 'key', label: 'API key', method: 'key' },
];
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  reportSettingsSaveState('saved');
});

const serve = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, original);
  cleanups.push(() => { globalThis.fetch = original; });
};
const render = async (directory = '/repo', savedAccounts = accounts) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const update = async (nextDirectory: string) => {
    await act(async () => root.render(<I18nProvider><AccountRotationSettings providerID="openai" accounts={savedAccounts} directory={nextDirectory} /></I18nProvider>));
  };
  await update(directory);
  const unmount = () => { act(() => root.unmount()); container.remove(); };
  cleanups.push(unmount);
  return { container, update, unmount };
};
const row = (container: HTMLElement, text: string) => {
  const element = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((candidate) => candidate.textContent?.includes(text));
  if (!element) throw new Error(`Missing row: ${text}`);
  return element;
};
const button = (container: HTMLElement, text: string) => {
  const element = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
};

test('shows the app-wide warning and saves an opt-in provider toggle', async () => {
  let submitted = '';
  let directoryHeader: string | null = null;
  serve(async (_input, init) => {
    if (init?.method === 'PUT') {
      submitted = String(init.body);
      directoryHeader = new Headers(init.headers).get('x-opencode-directory');
      return new Response(submitted, { headers: { 'Content-Type': 'application/json' } });
    }
    return Response.json({ enabled: false });
  });
  const { container } = await render('/repo with spaces');
  expect(container.textContent).toContain('all sessions on this server');
  expect(container.textContent).not.toContain('API key');
  await act(async () => row(container, 'Switch to the next account').click());
  expect(button(container, 'Save').disabled).toBe(false);
  await act(async () => button(container, 'Save').click());
  expect(JSON.parse(submitted)).toEqual({ enabled: true });
  expect(directoryHeader).toBe('/repo with spaces');
});

test('read failure stays distinct from disabled settings and can be retried', async () => {
  let attempts = 0;
  serve(async () => ++attempts === 1 ? new Response('Unavailable', { status: 503 }) : Response.json({ enabled: true }));
  const { container } = await render();
  expect(row(container, 'Switch to the next account').getAttribute('aria-disabled')).toBe('true');
  expect(container.textContent).toContain('Could not load or save');
  await act(async () => button(container, 'Try again').click());
  expect(row(container, 'Switch to the next account').getAttribute('aria-pressed')).toBe('true');
});

test('failed saves retain the draft toggle for retry', async () => {
  serve(async (_input, init) => init?.method === 'PUT' ? new Response('Unavailable', { status: 503 }) : Response.json({ enabled: true }));
  const { container } = await render();
  await act(async () => row(container, 'Switch to the next account').click());
  await act(async () => button(container, 'Save').click());
  expect(container.textContent).toContain('Could not load or save');
  expect(row(container, 'Switch to the next account').getAttribute('aria-pressed')).toBe('false');
  expect(button(container, 'Save').disabled).toBe(false);
});

test('VS Code explicitly hides this server-owned capability', async () => {
  serve(async () => new Response('{}', { status: 501 }));
  const { container } = await render();
  expect(container.textContent).toBe('');
});

test('an obsolete directory response cannot overwrite current settings', async () => {
  let finishFirst: (response: Response) => void = () => {};
  let calls = 0;
  serve(async () => ++calls === 1 ? new Promise<Response>((resolve) => { finishFirst = resolve; }) : Response.json({ enabled: true }));
  const { container, update } = await render('/first');
  await update('/second');
  await act(async () => finishFirst(Response.json({ enabled: false })));
  expect(row(container, 'Switch to the next account').getAttribute('aria-pressed')).toBe('true');
});

for (const success of [true, false]) {
  test(`save indicator settles after navigation when save succeeds=${success}`, async () => {
    let finish: (response: Response) => void = () => {};
    serve(async (_input, init) => init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Response.json({ enabled: false }));
    const { container, update } = await render();
    await act(async () => button(container, 'Save').click());
    expect(getSettingsSaveState()).toBe('saving');
    await update('/another-directory');
    await act(async () => finish(success ? Response.json({ enabled: true }) : new Response('{}', { status: 503 })));
    expect(getSettingsSaveState()).toBe(success ? 'idle' : 'error');
    expect(row(container, 'Switch to the next account').getAttribute('aria-pressed')).toBe('false');
  });
}

test('save indicator settles when the page unmounts mid-save', async () => {
  let finish: (response: Response) => void = () => {};
  serve(async (_input, init) => init?.method === 'PUT'
    ? new Promise<Response>((resolve) => { finish = resolve; })
    : Response.json({ enabled: false }));
  const { container, unmount } = await render();
  await act(async () => button(container, 'Save').click());
  unmount();
  await act(async () => finish(Response.json({ enabled: true })));
  expect(getSettingsSaveState()).toBe('idle');
});

test('an enabled setting can still be disabled after an account is removed', async () => {
  serve(async (_input, init) => Response.json({ enabled: init?.method !== 'PUT' }));
  const { container } = await render('/repo', [accounts[0]]);
  await act(async () => row(container, 'Switch to the next account').click());
  expect(button(container, 'Save').disabled).toBe(false);
  await act(async () => button(container, 'Save').click());
  expect(container.textContent).toBe('');
});
