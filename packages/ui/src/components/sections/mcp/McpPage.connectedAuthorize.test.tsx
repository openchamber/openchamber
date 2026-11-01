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
  name: 'gmail',
  metadata: { source: 'mcp' },
  methods: [{ id: 'mcp_0123456789abcdef', type: 'oauth', label: 'gmail' }],
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

/** Renders the page for a connected `gmail` server and returns its button labels. */
const renderConnectedServer = async (withOAuth: boolean): Promise<string[]> => {
  // Leaving the page clears the selection, so the previous page goes first.
  await act(async () => root?.unmount());
  integrations = withOAuth ? [oauthIntegration] : [];
  const statuses = { gmail: { name: 'gmail', status: { status: 'connected' as const } } };
  useMcpStore.setState({ refresh: async () => {}, getStatusForDirectory: () => statuses });
  useMcpConfigStore.setState({
    selectedMcpName: 'gmail',
    serversByDirectory: { __default__: [{ name: 'gmail', type: 'remote', url: 'https://gmailmcp.googleapis.com/mcp/v1' }] },
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

test('a connected server with a browser sign-in offers Authorize beside Disconnect', async () => {
  const buttons = await renderConnectedServer(true);
  expect(buttons).toContain('Authorize');
  expect(buttons).toContain('Disconnect');
  expect(buttons).toContain('Test');
});

test('a connected server without a browser sign-in keeps its plain actions', async () => {
  const buttons = await renderConnectedServer(false);
  expect(buttons).not.toContain('Authorize');
  expect(buttons).toContain('Disconnect');
});

test('Authorize opens the sign-in on the connected server', async () => {
  const buttons = await renderConnectedServer(true);
  const authorize = [...document.body.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Authorize',
  );
  if (!authorize) throw new Error(`Authorize button missing; buttons: ${buttons.join(', ')}`);
  // The OAuth start fails against the offline test runtime; the flow renders
  // that failure as state, which is what proves the sign-in mounted.
  const connect = spyOn(sdk.integration.oauth, 'connect').mockImplementation(async () => {
    throw new Error('offline test runtime');
  });
  try {
    await act(async () => { authorize.click(); });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.body.textContent).toContain('Runtime status');
  } finally {
    connect.mockRestore();
  }
});