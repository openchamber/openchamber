import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

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

/** Renders the grid with one configured server and the runtime-added Console one. */
const renderGrid = async (options?: { configsLoaded?: boolean }): Promise<string> => {
  await act(async () => root?.unmount());
  useMcpConfigStore.setState({
    selectedMcpName: null,
    mcpDraft: null,
    isLoading: false,
    loadMcpConfigs: async () => true,
    // An absent key means the directory's config catalog has not been read yet.
    serversByDirectory: options?.configsLoaded === false ? {} : { __default__: [configuredServer] },
  });
  useMcpStore.setState({
    refresh: async () => {},
    getStatusForDirectory: () => runtimeStatuses,
    diagnosticsByDirectory: {},
  });
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  const page = root;
  await act(async () => { page.render(<I18nProvider><ThemeSystemProvider><McpGrid /></ThemeSystemProvider></I18nProvider>); });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container.textContent ?? '';
};

test('a server OpenCode added at runtime gets a read-only row beside the configured ones', async () => {
  const body = await renderGrid();
  expect(body).toContain('context7');
  expect(body).toContain('opencode_console');
});

test('the runtime row opens nothing and offers no delete', async () => {
  await renderGrid();
  const buttons = [...document.body.querySelectorAll('button')];
  // The configured card is a button that opens the detail page; the runtime
  // card has no config to open and no delete action to offer.
  expect(buttons.some((button) => button.textContent?.includes('opencode_console'))).toBe(false);
  expect(buttons.some((button) => (button.getAttribute('aria-label') ?? '').includes('opencode_console'))).toBe(false);
});

test('a runtime row waits for the config catalog instead of flashing read-only rows', async () => {
  // The status map can be populated from elsewhere while this directory's
  // config is still loading; every server would then read as runtime-only.
  const body = await renderGrid({ configsLoaded: false });
  expect(body).not.toContain('opencode_console');
});