import { afterEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

type RecordedRequest = { url: string; method: string; body: unknown };
const requests: RecordedRequest[] = [];
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  requests.push({ url, method, body: init?.body ?? null });
  return Response.json({ configured: false });
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { QUOTA_PROVIDERS } = await import('@/lib/quota');
const { QuotaCredentials } = await import('./QuotaCredentials');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

afterEach(async () => {
  await act(async () => root.unmount());
  fetchSpy.mockRestore();
  browser.close();
});

test('opendesign is listed and its unconfigured form saves cookie and workspace id', async () => {
  expect(QUOTA_PROVIDERS.some((provider) => provider.id === 'opendesign' && provider.name === 'Open Design')).toBe(true);

  await act(async () => {
    root.render(<I18nProvider><QuotaCredentials providerId="opendesign" providerName="Open Design" /></I18nProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  // The status read went to the managed-credential route and reports unconfigured.
  expect(requests.some((request) => request.method === 'GET' && request.url.includes('/api/quota/credentials/opendesign'))).toBe(true);
  expect(container.textContent).toContain('Session cookie');
  expect(container.textContent).toContain('Workspace ID');

  const inputs = [...container.querySelectorAll<HTMLInputElement>('input')];
  const cookieInput = inputs.find((input) => input.type === 'password');
  const workspaceInput = inputs.find((input) => input.type === 'text');
  if (!cookieInput || !workspaceInput) throw new Error('Missing opendesign credential fields');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing input setter');
  await act(async () => { setValue.call(cookieInput, 'better-auth.session_token=test-token'); cookieInput.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { setValue.call(workspaceInput, 'ws-123'); workspaceInput.dispatchEvent(new Event('input', { bubbles: true })); });

  const saveButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('Save'));
  if (!saveButton) throw new Error('Missing save button');
  await act(async () => { saveButton.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

  const put = requests.find((request) => request.method === 'PUT');
  if (!put) throw new Error('Save did not PUT the credential');
  expect(put.url.includes('/api/quota/credentials/opendesign')).toBe(true);
  expect(JSON.parse(String(put.body ?? '{}'))).toEqual({ cookie: 'better-auth.session_token=test-token', workspaceId: 'ws-123' });
});

test('google quota provider carries the Code Assist per-model label (#1042)', () => {
  // The Usage surfaces take the displayed name from this static metadata, so
  // the clarified label has to live here, not only in the server response.
  expect(QUOTA_PROVIDERS.some((provider) => provider.id === 'google' && provider.name === 'Google (Code Assist, per-model)')).toBe(true);
});

test('mistral quota provider is listed for the Usage page', () => {
  expect(QUOTA_PROVIDERS.some((provider) => provider.id === 'mistral' && provider.name === 'Mistral AI')).toBe(true);
});
