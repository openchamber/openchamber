import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { IntegrationInfo } from '@opencode/client';
import type { McpServerStatus } from '@/lib/opencode/model';

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
const projects = [{ id: 'demo', path: '/test' }];
// Startup saves the home directory to settings, and the page follows the projects in the answer.
let answerStartupSave!: () => void;
const startupSaveHeld = new Promise<void>((resolve) => { answerStartupSave = resolve; });
const startupSaved = new Promise<void>((resolve) => {
  browser.addEventListener('openchamber:settings-synced', () => resolve(), { once: true });
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
  async (input: string | URL | Request) => {
    if (!String(input instanceof Request ? input.url : input).includes('/api/config/settings')) return Response.json({ home: '/test' });
    await startupSaveHeld;
    return Response.json({ projects, activeProjectId: 'demo' });
  },
  { preconnect: () => undefined },
));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { McpPage } = await import('./McpPage');
const initialProjectSelection = {
  projects: useProjectsStore.getState().projects,
  activeProjectId: useProjectsStore.getState().activeProjectId,
};
let reads: Promise<unknown>[] = [];
const answer = <T,>(read: Promise<T>): Promise<T> => {
  reads.push(read);
  return read;
};
const turn = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
/** Lets the page act on every policy and integration read it has started. */
const settle = async () => {
  await act(async () => { await Promise.all(reads); });
  for (let left = 3; left > 0; left -= 1) await turn();
};
const policies = spyOn(opencodeClient, 'getIntegrationPolicies').mockImplementation(() => answer(Promise.resolve([])));
const listMcp = spyOn(opencodeClient, 'listMcpServers');
const connect = spyOn(useMcpStore.getState(), 'connect').mockResolvedValue(undefined);

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
const list = spyOn(sdk.integration, 'list').mockImplementation(() => answer(Promise.resolve({ location: { directory: '/test' }, data: integrations })));

let root: ReturnType<typeof createRoot> | null = null;
afterAll(async () => {
  await act(async () => root?.unmount());
  list.mockRestore();
  scoped.mockRestore();
  policies.mockRestore();
  listMcp.mockRestore();
  connect.mockRestore();
  fetchSpy.mockRestore();
  useProjectsStore.setState(initialProjectSelection);
  browser.close();
});

type ServerStatus = McpServerStatus['status'];
const failed: ServerStatus = { status: 'failed', error: 'Token refresh was rejected (access_denied)' };

/** Renders the page for a `docs` server and returns the button labels on it. */
const renderServer = async (
  integration: IntegrationInfo | null,
  status: ServerStatus = failed,
  disabled = false,
  freshStatus = status,
  pendingRead?: Promise<McpServerStatus[]>,
): Promise<string[]> => {
  // Leaving the page clears the selection, so the previous page goes first.
  await act(async () => root?.unmount());
  reads = [];
  connect.mockReset();
  connect.mockResolvedValue(undefined);
  listMcp.mockReset();
  integrations = integration ? [integration] : [];
  const statuses = { docs: { name: 'docs', status, integrationID: oauthIntegration.id } };
  if (pendingRead) listMcp.mockReturnValue(pendingRead);
  else listMcp.mockResolvedValue([{ ...statuses.docs, status: freshStatus }]);
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  const page = root;
  await act(async () => {
    useProjectsStore.setState({ projects, activeProjectId: 'demo' });
    useMcpStore.setState({ refresh: async () => {}, getStatusForDirectory: () => statuses });
    useMcpConfigStore.setState({
      selectedMcpName: 'docs',
      serversByDirectory: { __default__: [{ name: 'docs', type: 'remote', url: 'https://docs.test/mcp', disabled }] },
      getMcpByName: () => useMcpConfigStore.getState().serversByDirectory.__default__?.[0] ?? null,
    });
    page.render(<I18nProvider><McpPage /></I18nProvider>);
  });
  await settle();
  return [...container.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
};

test('a failed server with a browser sign-in offers Sign in again in place of Connect', async () => {
  const buttons = await renderServer(oauthIntegration);
  expect(buttons).toContain('Sign in again');
  expect(buttons).not.toContain('Connect');
  expect(buttons).toContain('Test connection');
  expect(connect).not.toHaveBeenCalled();
});

test('a failed server without a browser sign-in keeps Connect', async () => {
  const buttons = await renderServer(null);
  expect(buttons).toContain('Connect');
  expect(buttons).not.toContain('Sign in again');
  expect(buttons).toContain('Test connection');
});

test('a server waiting for sign-in tells its retry Connect apart from its Sign in', async () => {
  const buttons = await renderServer(oauthIntegration, { status: 'needs_auth', error: 'Authorization required' });
  expect(buttons.filter((label) => label === 'Connect')).toHaveLength(1);
  expect(buttons).toContain('Sign in');
  expect(connect).not.toHaveBeenCalled();
});

const savedOAuthIntegration: IntegrationInfo = {
  ...oauthIntegration,
  connections: [{ type: 'credential', id: 'cred_demo', label: 'Demo', method: 'oauth' }],
};

const staleStatuses: ServerStatus[] = [failed, { status: 'needs_auth', error: 'Authorization required' }];
for (const status of staleStatuses) {
  test(`retries a stale ${status.status} runtime once when another OpenCode process has saved OAuth`, async () => {
    // The startup settings save lands on the open page before the reconnect can start.
    policies.mockImplementationOnce(() => {
      answerStartupSave();
      return answer(startupSaved.then(() => []));
    });
    await renderServer(savedOAuthIntegration, status);
    expect(connect.mock.calls).toEqual([['docs', '/test']]);
  });
}

test('does not reconnect a disabled server with a saved OAuth credential', async () => {
  await renderServer(savedOAuthIntegration, failed, true);
  expect(connect).not.toHaveBeenCalled();
});

test('does not reconnect when an authoritative read reports an intentional runtime disconnect', async () => {
  await renderServer(savedOAuthIntegration, failed, false, { status: 'disabled' });
  expect(listMcp.mock.calls).toEqual([['/test']]);
  expect(connect).not.toHaveBeenCalled();
});

test('switching the server off while the saved OAuth status read is pending cancels the reconnect', async () => {
  let reply!: (servers: McpServerStatus[]) => void;
  const pendingRead = new Promise<McpServerStatus[]>((resolve) => { reply = resolve; });
  await renderServer(savedOAuthIntegration, failed, false, failed, pendingRead);
  expect(listMcp.mock.calls).toEqual([['/test']]);

  const switchedOff = [{ name: 'docs', type: 'remote' as const, url: 'https://docs.test/mcp', disabled: true }];
  await act(async () => {
    useMcpConfigStore.setState({ serversByDirectory: { __default__: switchedOff, '/test': switchedOff } });
  });
  await act(async () => {
    reply([{ name: 'docs', status: failed, integrationID: oauthIntegration.id }]);
    await pendingRead;
  });

  expect(connect).not.toHaveBeenCalled();
});

test('unchecking Enable while the saved OAuth status read is pending cancels the reconnect before autosave lands', async () => {
  let reply!: (servers: McpServerStatus[]) => void;
  const pendingRead = new Promise<McpServerStatus[]>((resolve) => { reply = resolve; });
  const updateMcp = useMcpConfigStore.getState().updateMcp;
  let writes = 0;
  await act(async () => useMcpConfigStore.setState({ updateMcp: () => { writes += 1; return new Promise<never>(() => {}); } }));
  try {
    await renderServer(savedOAuthIntegration, failed, false, failed, pendingRead);
    expect(listMcp.mock.calls).toEqual([['/test']]);

    const row = document.querySelector('[aria-label="Enable server"]')?.closest<HTMLElement>('[role="button"]');
    expect(row?.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { row?.click(); });
    expect(row?.getAttribute('aria-pressed')).toBe('false');
    expect(useMcpConfigStore.getState().serversByDirectory.__default__?.[0]?.disabled).toBe(false);

    await act(async () => {
      reply([{ name: 'docs', status: failed, integrationID: oauthIntegration.id }]);
      await pendingRead;
    });
    expect(connect).not.toHaveBeenCalled();
    expect(writes).toBe(1);
  } finally {
    await act(async () => useMcpConfigStore.setState({ updateMcp }));
  }
});
