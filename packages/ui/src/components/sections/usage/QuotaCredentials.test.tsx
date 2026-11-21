import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  Event: browser.Event,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

// React's input-event support is detected when react-dom loads.
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { QuotaCredentials } = await import('./QuotaCredentials');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
const fetchSpy = spyOn(globalThis, 'fetch');

afterEach(async () => {
  await act(async () => root.unmount());
  fetchSpy.mockRestore();
  browser.close();
});

test('a token typed before the saved status arrives stays, and each provider starts with empty fields', async () => {
  type Status = { configured: boolean; secretMasked?: string };
  const statusReads = new Map<string, (status: Status) => void>();
  const writes: Array<(status: Status) => void> = [];
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(input, window.location.href), init);
    const provider = /^\/api\/quota\/credentials\/([a-z-]+)$/.exec(new URL(request.url).pathname)?.[1];
    if (!provider) throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    return new Promise<Response>((resolve) => {
      const finish = (status: Status) => resolve(Response.json(status));
      if (request.method === 'GET') statusReads.set(provider, finish);
      else writes.push(finish);
    });
  });
  const settle = async () => {
    for (let turn = 0; turn < 5; turn += 1) await act(async () => { await Promise.resolve(); });
  };
  const show = async (providerId: 'cursor' | 'exe-dev') => {
    await act(async () => { root.render(<I18nProvider><QuotaCredentials providerId={providerId} providerName={providerId} /></I18nProvider>); });
    await settle();
  };
  const fields = () => [...container.querySelectorAll<HTMLInputElement>('input[type="password"]')];
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing native input setter');
  const type = async (field: HTMLInputElement, value: string) => {
    await act(async () => {
      setValue.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const answer = async (provider: string, status: Status) => {
    const finish = statusReads.get(provider);
    if (!finish) throw new Error(`No status read for ${provider}`);
    await act(async () => { finish(status); });
    await settle();
  };

  await show('cursor');
  await type(fields()[0], 'typed-access');
  await answer('cursor', { configured: true, secretMasked: 'cur•••' });
  expect(fields().map((field) => field.value)).toEqual(['typed-access', '']);
  expect(fields()[1].placeholder).toBe('cur•••');

  await show('exe-dev');
  expect(fields().map((field) => field.value)).toEqual(['']);
  await show('cursor');
  expect(fields().map((field) => field.value)).toEqual(['', '']);

  // The exe.dev read is still open; its late answer must not describe Cursor.
  await answer('exe-dev', { configured: true, secretMasked: 'exe•••' });
  expect(fields().map((field) => field.placeholder)).not.toContain('exe•••');

  // A save still running when the user leaves and returns keeps the form busy.
  // Its answer never lands on another provider's form, keeps a draft typed
  // after it was sent, and wins over a status read that started before it.
  const buttons = () => [...container.querySelectorAll('button')];
  await type(fields()[0], 'new-access');
  await act(async () => { buttons()[0].click(); });
  await show('exe-dev');
  expect(buttons().every((button) => button.disabled)).toBe(true);
  await show('cursor');
  await type(fields()[1], 'later-refresh');
  await act(async () => { writes[0]({ configured: true, secretMasked: 'new•••' }); });
  await settle();
  await answer('cursor', { configured: false });
  expect(fields().map((field) => field.value)).toEqual(['', 'later-refresh']);
  expect(fields().map((field) => field.placeholder)).toEqual(['new•••', 'new•••']);
  expect(buttons().some((button) => button.disabled)).toBe(false);

  await show('exe-dev');
  await answer('exe-dev', { configured: false });
  expect(fields().map((field) => field.placeholder)).not.toContain('new•••');
});
