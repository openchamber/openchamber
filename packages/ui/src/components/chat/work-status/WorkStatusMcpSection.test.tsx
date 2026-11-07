import { afterAll, afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { IntegrationInfo } from '@opencode/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement, HTMLInputElement: browser.HTMLInputElement,
  Event: browser.Event, PointerEvent: browser.PointerEvent, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
  FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/proj-a' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { toast } = await import('sonner');
const { I18nProvider } = await import('@/lib/i18n');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { WorkStatusMcpSection } = await import('./WorkStatusMcpSection');

const integrationFor = (name: string): IntegrationInfo => ({
  id: `mcp_${name}`,
  name,
  metadata: { source: 'mcp' },
  methods: [{ id: `mcp_${name}`, type: 'oauth', label: name }],
  connections: [],
});

const sdk = opencodeClient.getSdkClient();
let attempts = 0;
/** Fresh spies per test: the trimmed bun:test types have no mockClear. */
const spyOnSdk = () => ({
  scoped: spyOn(opencodeClient, 'getScopedSdkClient').mockImplementation(() => sdk),
  list: spyOn(sdk.integration, 'list').mockImplementation(async () => ({
    location: { directory: '/proj-a' },
    data: [integrationFor('docs')],
  })),
  // A `code` attempt with no link: nothing opens a browser and nothing polls.
  oauthConnect: spyOn(sdk.integration.oauth, 'connect').mockImplementation(async () => {
    attempts += 1;
    return {
      location: { directory: '/proj-a' },
      data: { attemptID: `attempt-${attempts}`, mode: 'code' as const, url: '', instructions: '', time: { created: 0, expires: 0 } },
    };
  }),
  oauthComplete: spyOn(sdk.integration.oauth, 'complete').mockImplementation(async () => undefined),
  oauthCancel: spyOn(sdk.integration.oauth, 'cancel').mockImplementation(async () => undefined),
  toastMessage: spyOn(toast, 'message').mockImplementation(() => 'toast'),
});
let spies: ReturnType<typeof spyOnSdk>;
const connectCalls: Array<[string, string | null | undefined]> = [];
const connect = async (name: string, directory?: string | null) => { connectCalls.push([name, directory]); };
const setEnabledCalls: string[] = [];
const setEnabled = async (name: string) => { setEnabledCalls.push(name); };

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;

const needsAuth = { status: 'needs_auth' as const, error: 'Authorization required' };

beforeEach(() => {
  attempts = 0;
  spies = spyOnSdk();
  connectCalls.length = 0;
  setEnabledCalls.length = 0;
  useUIStore.setState({ workStatusExpandedSections: { mcp: true } });
  useMcpStore.setState({
    byDirectory: {
      '/proj-a': { docs: { name: 'docs', status: needsAuth } },
      '/proj-b': { docs: { name: 'docs', status: needsAuth } },
    },
    // Fresh status, so the section reads nothing on mount.
    refreshedAtKeys: { '/proj-a': Date.now(), '/proj-b': Date.now() },
    connect,
    setEnabled,
  });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  await act(async () => mounted?.unmount());
  for (const spy of Object.values(spies)) spy.mockRestore();
});

afterAll(() => {
  fetchSpy.mockRestore();
  browser.close();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const render = async (directory = '/proj-a') => {
  const mounted = root;
  await act(async () => {
    mounted?.render(<I18nProvider><WorkStatusMcpSection sessionId="session-1" directory={directory} /></I18nProvider>);
  });
  await settle();
};

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text);
  if (!found) throw new Error(`No "${text}" button`);
  return found;
};

const press = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};

test('the Sign in pill starts the server sign-in instead of pointing at Settings', async () => {
  await render();
  await press(buttonByText('Sign in'));

  expect(spies.oauthConnect.mock.calls.length).toBe(1);
  expect(spies.oauthConnect.mock.calls[0]?.[0]).toMatchObject({ integrationID: 'mcp_docs', methodID: 'mcp_docs' });
  // The server's integration exists only in the directory that declares it.
  expect(new Set(spies.scoped.mock.calls.map(([directory]) => directory))).toEqual(new Set(['/proj-a']));
  expect(spies.toastMessage.mock.calls.length).toBe(0);
});

test('switching on a server that needs sign-in starts the sign-in', async () => {
  await render();
  const toggle = container.querySelector<HTMLElement>('[aria-label="Toggle docs"]');
  if (!toggle) throw new Error('No switch');
  await press(toggle);

  expect(spies.oauthConnect.mock.calls.length).toBe(1);
  expect(setEnabledCalls).toEqual([]);
});

test('a finished sign-in reconnects the server in its directory', async () => {
  await render();
  await press(buttonByText('Sign in'));

  const input = container.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([readonly])');
  if (!input) throw new Error('No code field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, 'the-code');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await press(buttonByText('Complete'));

  expect(spies.oauthComplete.mock.calls[0]?.[0]).toMatchObject({ integrationID: 'mcp_docs', attemptID: 'attempt-1', code: 'the-code' });
  expect(connectCalls).toEqual([['docs', '/proj-a']]);
});

test('folding and reopening the section does not start another sign-in', async () => {
  await render();
  await press(buttonByText('Sign in'));
  expect(spies.oauthConnect.mock.calls.length).toBe(1);

  const heading = container.querySelector<HTMLElement>('[aria-expanded]');
  if (!heading) throw new Error('No section heading');
  await press(heading);
  // Folding unmounts the attempt, which cancels it upstream.
  expect(spies.oauthCancel.mock.calls.length).toBe(1);
  await press(container.querySelector<HTMLElement>('[aria-expanded]')!);

  expect(spies.oauthConnect.mock.calls.length).toBe(1);
});

test('a sign-in started in one directory does not start again in another', async () => {
  await render('/proj-a');
  await press(buttonByText('Sign in'));
  expect(spies.oauthConnect.mock.calls.length).toBe(1);

  await render('/proj-b');
  // The attempt belongs to the first directory; it ends there.
  expect(spies.oauthCancel.mock.calls.length).toBe(1);
  await render('/proj-a');

  expect(spies.oauthConnect.mock.calls.length).toBe(1);
});

test('a server that leaves needs_auth and comes back does not start another sign-in', async () => {
  await render();
  await press(buttonByText('Sign in'));
  expect(spies.oauthConnect.mock.calls.length).toBe(1);

  // OpenCode reconnects on its own once a credential is stored; a later
  // failure can put the server back in needs_auth.
  const setStatus = async (status: { status: 'pending' } | typeof needsAuth) => {
    await act(async () => useMcpStore.setState((state) => ({
      byDirectory: { ...state.byDirectory, '/proj-a': { docs: { name: 'docs', status } } },
    })));
    await settle();
  };
  await setStatus({ status: 'pending' });
  await setStatus(needsAuth);

  expect(spies.oauthConnect.mock.calls.length).toBe(1);
});

test('a sign-in whose lookup keeps failing points at Settings instead of doing nothing', async () => {
  spies.list.mockImplementation(async () => { throw new Error('offline'); });
  const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
  const flush = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };
  await render();
  // The lookup retries every 750 ms; run the retries on a fake clock.
  jest.useFakeTimers();
  try {
    await act(async () => { buttonByText('Sign in').click(); await flush(); });
    for (let retry = 0; retry < 10; retry += 1) {
      await act(async () => { jest.advanceTimersByTime(750); await flush(); });
    }

    expect(spies.list.mock.calls.length).toBe(9);
    expect(spies.oauthConnect.mock.calls.length).toBe(0);
    expect(spies.toastMessage.mock.calls).toEqual([['Sign in to this MCP server from Settings → MCP.']]);
  } finally {
    jest.useRealTimers();
    consoleError.mockRestore();
  }
});

test('a server with several sign-in methods lets the user pick one', async () => {
  const twoMethods: IntegrationInfo = {
    ...integrationFor('docs'),
    methods: [
      { id: 'mcp_docs', type: 'oauth', label: 'Browser' },
      { id: 'mcp_docs_device', type: 'oauth', label: 'Device code' },
    ],
  };
  spies.list.mockImplementation(async () => ({ location: { directory: '/proj-a' }, data: [twoMethods] }));
  await render();
  await press(buttonByText('Sign in'));

  expect(spies.oauthConnect.mock.calls.length).toBe(0);
  expect(container.textContent).toContain('Browser');
  expect(container.textContent).toContain('Device code');
});
