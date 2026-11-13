import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { dict } from '@/lib/i18n/messages/en';
import type { McpServerStatus } from '@/lib/opencode/model';
import type { ProtectedMcpStatus, useProtectedMcp } from './protectedMcp';

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
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  return Response.json(url.includes('/api/config') ? [] : { home: '/test' });
});
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { McpGrid } = await import('./McpGrid');

let root: ReturnType<typeof createRoot> | null = null;
afterAll(async () => {
  await act(async () => root?.unmount());
  fetchSpy.mockRestore();
  browser.close();
});

const configuredServer = { name: 'context7', type: 'remote' as const, url: 'https://mcp.context7.com/mcp', scope: 'user' as const };
const runtimeStatuses = {
  context7: { name: 'context7', status: { status: 'connected' as const } },
  opencode_console: { name: 'opencode_console', status: { status: 'connected' as const } },
};

const protectedStatus: ProtectedMcpStatus = {
  host: { supported: true },
  service: { state: 'available', status: {
    administration: 'separate', enforcement: { status: 'protected', findings: [] },
    connections: [{ id: 'private-github', name: 'private-github', revision: 3, enabled: true,
      transport: 'stdio', target: { kind: 'command', label: '/usr/bin/fixture' }, credential: 'stored' }],
  } },
  selections: { global: { github: { connection: 'private-github' } }, project: null, effective: { github: { connection: 'private-github' } } },
  selectionsError: null,
};

/** Renders configured, protected and runtime-reported servers together. */
const renderGrid = async (options?: {
  readonly configsLoaded?: boolean;
  readonly servers?: ReturnType<typeof useMcpConfigStore.getState>['mcpServers'];
  readonly statuses?: Record<string, McpServerStatus>;
  readonly protectedState?: ReturnType<typeof useProtectedMcp>['state'];
}): Promise<string> => {
  await act(async () => root?.unmount());
  useMcpConfigStore.setState({
    selectedMcpName: null,
    selectedProtectedId: null,
    mcpDraft: null,
    isLoading: false,
    loadMcpConfigs: async () => true,
    // An absent key means the directory's config catalog has not been read yet.
    serversByDirectory: options?.configsLoaded === false ? {} : { __default__: options?.servers ?? [configuredServer] },
  });
  useMcpStore.setState({
    refresh: async () => {},
    getStatusForDirectory: () => options?.statuses ?? runtimeStatuses,
    diagnosticsByDirectory: {},
  });
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  const page = root;
  await act(async () => { page.render(<I18nProvider><ThemeSystemProvider><McpGrid protectedMcp={{
    state: options?.protectedState ?? { kind: 'unsupported' }, reload: async () => {}, change: async () => {},
  }} /></ThemeSystemProvider></I18nProvider>); });
  return container.textContent ?? '';
};

test('a server OpenCode added at runtime gets a read-only row beside the configured ones', async () => {
  // Given the runtime also reports the configured server.
  // When
  const body = await renderGrid();
  // Then
  expect(document.querySelectorAll('[title="context7"]')).toHaveLength(1);
  expect(body).toContain('opencode_console');
});

test('the runtime row opens nothing and offers no delete', async () => {
  // Given
  // When
  await renderGrid();
  // Then
  expect(document.querySelector('[title="opencode_console"]')?.closest('.oc-tile')?.tagName).toBe('DIV');
  const buttons = [...document.body.querySelectorAll('button')];
  // The configured card is a button that opens the detail page; the runtime
  // card has no config to open and no delete action to offer.
  expect(buttons.some((button) => button.textContent?.includes('opencode_console'))).toBe(false);
  expect(buttons.some((button) => (button.getAttribute('aria-label') ?? '').includes('opencode_console'))).toBe(false);
});

test('a runtime row waits for the config catalog instead of flashing read-only rows', async () => {
  // Given the status map is populated from elsewhere while this directory's
  // config is still loading; every server would then read as runtime-only.
  // When
  const body = await renderGrid({ configsLoaded: false });
  // Then
  expect(body).not.toContain('opencode_console');
});

test('runtime-only servers keep search visible without a configured or protected card', async () => {
  // Given a successful empty config read.
  // When
  const body = await renderGrid({ servers: [], statuses: { opencode_console: runtimeStatuses.opencode_console } });
  // Then
  expect(document.querySelector('[title="opencode_console"]')).not.toBeNull();
  expect(document.querySelector(`input[placeholder="${dict['settings.mcp.grid.searchPlaceholder']}"]`)).not.toBeNull();
  expect(body).not.toContain(dict['settings.mcp.grid.empty']);
});

test('a protected runtime alias keeps one editable card owned by its connection', async () => {
  // Given a protected selection with a different name from its connection.
  const statuses = { ...runtimeStatuses, github: { name: 'github', status: { status: 'connected' as const } } };
  // When
  await renderGrid({ statuses, protectedState: { kind: 'ready', status: protectedStatus } });
  // Then
  expect(document.querySelectorAll('[title="github"]')).toHaveLength(1);
  const card = document.querySelector<HTMLButtonElement>('button.oc-tile:has([title="github"])');
  expect(card?.textContent).toContain(dict['settings.mcp.grid.scope.user']);
  expect(card?.textContent).toContain(dict['settings.mcp.page.scope.protected']);
  await act(async () => { card?.click(); });
  expect(useMcpConfigStore.getState().selectedProtectedId).toBe('private-github');
  expect(useMcpConfigStore.getState().selectedMcpName).toBeNull();
});

test('a protected runtime alias waits for protected discovery before its editable card appears', async () => {
  // Given ordinary configs have loaded while protected discovery is pending.
  const statuses = { ...runtimeStatuses, github: { name: 'github', status: { status: 'connected' as const } } };
  await renderGrid({ statuses, protectedState: { kind: 'loading' } });
  expect(document.querySelector('[title="github"]')).toBeNull();
  expect(document.querySelector('[title="opencode_console"]')).toBeNull();
  // When protected discovery completes for the same grid.
  await act(async () => { root?.render(<I18nProvider><ThemeSystemProvider><McpGrid protectedMcp={{
    state: { kind: 'ready', status: protectedStatus }, reload: async () => {}, change: async () => {},
  }} /></ThemeSystemProvider></I18nProvider>); });
  // Then the alias is editable through its protected connection and runtime-only rows appear.
  expect(document.querySelectorAll('[title="github"]')).toHaveLength(1);
  expect(document.querySelector('button.oc-tile:has([title="github"])')).not.toBeNull();
  expect(document.querySelector('[title="opencode_console"]')?.closest('.oc-tile')?.tagName).toBe('DIV');
});

test('an orphaned protected runtime name keeps only its unavailable cleanup card', async () => {
  // Given a global selection whose connection no longer exists.
  const status: ProtectedMcpStatus = { ...protectedStatus, service: { state: 'unreachable' } };
  const statuses = { ...runtimeStatuses, github: { name: 'github', status: { status: 'failed' as const, error: 'Unavailable' } } };
  // When
  await renderGrid({ statuses, protectedState: { kind: 'ready', status } });
  // Then
  expect(document.querySelectorAll('[title="github"]')).toHaveLength(1);
  const card = document.querySelector('[title="github"]')?.closest('.oc-tile');
  expect(card?.tagName).toBe('DIV');
  expect(card?.textContent).toContain(dict['settings.mcp.protected.unavailable']);
  expect([...document.querySelectorAll('button')].some((button) => button.getAttribute('aria-label') === dict['settings.mcp.grid.actionsAria'].replace('{name}', 'github'))).toBe(true);
});
