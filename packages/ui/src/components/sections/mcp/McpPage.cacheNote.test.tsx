import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

// Same page setup as McpPage.test.tsx. Kept in its own file because that file closes
// its window after its single test.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  PointerEvent: browser.PointerEvent, MouseEvent: browser.MouseEvent, KeyboardEvent: browser.KeyboardEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { settingsDict } = await import('@/lib/i18n/messages/en.settings');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
type McpDraft = import('@/stores/useMcpConfigStore').McpDraft;
const { useMcpStore } = await import('@/stores/useMcpStore');
const { McpPage } = await import('./McpPage');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterAll(async () => { await act(async () => root.unmount()); fetchSpy.mockRestore(); browser.close(); });

const enableNote = settingsDict['settings.mcp.page.server.enableCacheNote'];
const codemodeNote = settingsDict['settings.mcp.page.advanced.codemodeCacheNote'];
const enableDefaultNote = settingsDict['settings.mcp.page.server.enableCacheNoteDefault'];

const showServer = async (server: { name: string; type: 'remote'; url: string; codemode?: boolean; disabled?: boolean }) => {
  useMcpStore.setState({ refresh: async () => {} });
  useMcpConfigStore.setState({
    mcpDraft: null,
    selectedMcpName: server.name, serversByDirectory: { __default__: [server] },
    getMcpByName: () => useMcpConfigStore.getState().serversByDirectory.__default__?.[0] ?? null,
    updateMcp: async () => ({ ok: true }),
  });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
};

// A server with code mode off has its tools in the request's tool list, so enabling or
// disabling it costs a running session its prompt cache; with code mode On it never does.
test('the Enabled row warns for code mode Off and stays quiet for code mode On', async () => {
  await showServer({ name: 'direct', type: 'remote', url: 'https://direct.test', codemode: false });
  expect(container.textContent).toContain(enableNote);
  expect(container.textContent).not.toContain(enableDefaultNote);

  await act(async () => { root.render(null); });
  await showServer({ name: 'catalog', type: 'remote', url: 'https://catalog.test', codemode: true });
  expect(container.textContent).not.toContain(enableNote);
  expect(container.textContent).not.toContain(enableDefaultNote);
});

// Default can resolve to plain tools (OpenCode turns code mode off for servers with
// their own), and this page cannot see that decision, so it warns with "may"
// (PR #306 review 4354883743).
test('the Enabled row of a server on code mode Default says the cache may be lost', async () => {
  await act(async () => { root.render(null); });
  await showServer({ name: 'default', type: 'remote', url: 'https://default.test' });
  expect(container.textContent).toContain(enableDefaultNote);
  expect(container.textContent).not.toContain(enableNote);
});

test('the code mode selector of an enabled saved server carries the prompt cache note', async () => {
  await act(async () => { root.render(null); });
  await showServer({ name: 'catalog', type: 'remote', url: 'https://catalog.test' });
  await openAdvanced();
  expect(container.textContent).toContain(codemodeNote);
});

const openAdvanced = async () => {
  const trigger = [...container.querySelectorAll<HTMLElement>('button')]
    .find((button) => button.textContent?.includes(settingsDict['settings.mcp.page.advanced.configure']));
  if (!trigger) throw new Error('Missing advanced options trigger');
  await act(async () => { trigger.click(); });
  // Positive control: the selector the note belongs to is on screen.
  expect(container.querySelector(`[aria-label="${settingsDict['settings.mcp.page.advanced.codemode']}"]`)).not.toBeNull();
};

const draft = (overrides: Partial<McpDraft>): McpDraft => ({
  name: 'fresh', scope: 'user', type: 'remote', command: [], url: 'https://fresh.test',
  environment: [], headers: [], oauthEnabled: true, oauthClientId: '', oauthClientSecret: '',
  oauthScope: '', oauthRedirectUri: '', oauthCallbackPort: '', oauthAuthServerMetadataUrl: '',
  protocol: 'legacy', timeoutStartup: '', timeoutCatalog: '', timeoutExecution: '',
  codemode: 'default', disabled: false, ...overrides,
});

// A new server's draft reaches OpenCode only on Create, so neither switch touches a
// running session yet (PR #306 review 4354727385).
test('a new server draft shows neither cache note', async () => {
  await act(async () => { root.render(null); });
  useMcpStore.setState({ refresh: async () => {} });
  useMcpConfigStore.setState({
    mcpDraft: draft({ codemode: 'off' }), selectedMcpName: 'fresh', serversByDirectory: { __default__: [] },
    getMcpByName: () => undefined,
  });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
  expect(container.textContent).toContain(settingsDict['settings.mcp.page.server.enable']);
  expect(container.textContent).not.toContain(enableNote);
  expect(container.textContent).not.toContain(enableDefaultNote);
  await openAdvanced();
  expect(container.textContent).not.toContain(codemodeNote);
});

// A disabled server has no tools in any session, so changing its code mode changes
// nothing a running session sends (PR #306 review 4354727392).
test('a disabled saved server shows no code mode cache note', async () => {
  await act(async () => { root.render(null); });
  await showServer({ name: 'off', type: 'remote', url: 'https://off.test', disabled: true });
  await openAdvanced();
  expect(container.textContent).not.toContain(codemodeNote);
});
