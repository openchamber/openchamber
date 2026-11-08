import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { IntegrationInfo } from '@opencode/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { McpPage } = await import('./McpPage');

const oauthIntegration: IntegrationInfo = {
  id: 'mcp_0123456789abcdef',
  name: 'docs',
  metadata: { source: 'mcp' },
  methods: [{ id: 'mcp_0123456789abcdef', type: 'oauth', label: 'docs' }],
  connections: [],
};
const sdk = opencodeClient.getSdkClient();
const scoped = spyOn(opencodeClient, 'getScopedSdkClient').mockImplementation(() => sdk);
let integrations: IntegrationInfo[] = [];
const list = spyOn(sdk.integration, 'list').mockImplementation(async () => ({ location: { directory: '/test' }, data: integrations }));

let root: ReturnType<typeof createRoot> | null = null;
afterAll(async () => {
  await act(async () => root?.unmount());
  list.mockRestore();
  scoped.mockRestore();
  fetchSpy.mockRestore();
  browser.close();
});

/** Renders the page for a failed `docs` server and returns the button labels on it. */
const renderFailedServer = async (withOAuth: boolean): Promise<string[]> => {
  // Leaving the page clears the selection, so the previous page goes first.
  await act(async () => root?.unmount());
  integrations = withOAuth ? [oauthIntegration] : [];
  const statuses = { docs: { name: 'docs', status: { status: 'failed' as const, error: 'Token refresh was rejected (access_denied)' } } };
  useMcpStore.setState({ refresh: async () => {}, getStatusForDirectory: () => statuses });
  useMcpConfigStore.setState({
    selectedMcpName: 'docs',
    serversByDirectory: { __default__: [{ name: 'docs', type: 'remote', url: 'https://docs.test/mcp' }] },
    getMcpByName: () => useMcpConfigStore.getState().serversByDirectory.__default__?.[0] ?? null,
  });
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  const page = root;
  await act(async () => { page.render(<I18nProvider><McpPage /></I18nProvider>); });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
};

test('a failed server with a browser sign-in offers Sign in again in place of Connect', async () => {
  const buttons = await renderFailedServer(true);
  expect(buttons).toContain('Sign in again');
  expect(buttons).not.toContain('Connect');
  expect(buttons).toContain('Test connection');
});

test('a failed server without a browser sign-in keeps Connect', async () => {
  const buttons = await renderFailedServer(false);
  expect(buttons).toContain('Connect');
  expect(buttons).not.toContain('Sign in again');
  expect(buttons).toContain('Test connection');
});
