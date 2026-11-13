import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { dict } from '@/lib/i18n/messages/en';
import type { ProtectedConnection, ProtectedMcpStatus } from './protectedMcp';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLButtonElement: browser.HTMLButtonElement, ShadowRoot: browser.ShadowRoot,
  DocumentFragment: browser.DocumentFragment, KeyboardEvent: browser.KeyboardEvent,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ home: '/test' }));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { toast } = await import('@/components/ui');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { McpGrid } = await import('./McpGrid');
const { useProtectedMcp } = await import('./protectedMcp');
const initialConfig = useMcpConfigStore.getState();
const initialRuntime = useMcpStore.getState();
const initialProjects = useProjectsStore.getState();
const initialLocale = useI18nStore.getState();
const initialSettingsPath = useUIStore.getState().settingsProjectPath;
const warnings: string[] = [];
const errors: string[] = [];
const warningSpy = spyOn(toast, 'warning').mockImplementation((message) => { warnings.push(String(message)); return 'grid-warning'; });
const errorSpy = spyOn(toast, 'error').mockImplementation((message) => { errors.push(String(message)); return 'grid-error'; });
const container = document.createElement('div');
document.body.appendChild(container);
let root: ReturnType<typeof createRoot>;
let status: ProtectedMcpStatus;
const requests: Array<{ url: string; method: string; body: RequestInit['body'] }> = [];
const connection = (name: string, changes: Partial<ProtectedConnection> = {}): ProtectedConnection => ({
  id: `id-${name}`, name, revision: 7, enabled: true, transport: 'stdio',
  target: { kind: 'command', label: '/usr/bin/fixture' }, credential: 'stored', ...changes,
});
const statusWith = (connections: ProtectedConnection[]): ProtectedMcpStatus => ({
  host: { supported: true },
  service: { state: 'available', status: { administration: 'shared', enforcement: { status: 'protected', findings: [] }, connections } },
  selections: { global: {}, project: {}, effective: {} }, selectionsError: null,
});
function GridHarness() {
  const protectedMcp = useProtectedMcp('/project');
  return <McpGrid protectedMcp={protectedMcp} />;
}
const renderGrid = async () => {
  await act(async () => { root.render(<ThemeSystemProvider><I18nProvider><GridHarness /></I18nProvider></ThemeSystemProvider>); });
};
const cardFor = (name: string) => {
  const card = container.querySelector(`[title="${name}"]`)?.closest('.oc-tile');
  if (!card) throw new Error(`Missing card ${name}`);
  return card;
};
const clickMenuAction = async (name: string, label: string) => {
  const aria = dict['settings.mcp.grid.actionsAria'].replace('{name}', name);
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.getAttribute('aria-label') === aria);
  if (!trigger) throw new Error(`Missing actions for ${name}`);
  await act(async () => { trigger.click(); });
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === label);
  if (!action) throw new Error(`Missing action ${label}`);
  await act(async () => { action.click(); });
};
const confirmDelete = async () => {
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === dict['settings.common.actions.delete']);
  if (!confirm) throw new Error('Missing delete confirmation');
  await act(async () => { confirm.click(); });
};
const serveFixture = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
  if (url.includes('/api/protected-mcp/status')) return Response.json(status);
  if (url.includes('/api/protected-mcp/connections/')) {
    status = statusWith([]);
    return Response.json({ removed: true, selectionsRemoved: 1, selectionsNotUpdated: [] });
  }
  if (url.includes('/api/config')) return Response.json([]);
  return Response.json({ home: '/test' });
};

beforeEach(() => {
  root = createRoot(container);
  requests.length = 0;
  warnings.length = 0;
  errors.length = 0;
  status = statusWith([connection('fixture')]);
  useI18nStore.setState({ locale: 'en', dictionary: dict, loadingLocale: null });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' });
  useUIStore.setState({ settingsProjectPath: null });
  useMcpConfigStore.setState({ ...initialConfig, selectedMcpName: null, selectedProtectedId: null, mcpDraft: null, serversByDirectory: {}, loadMcpConfigs: async () => true });
  useMcpStore.setState({ ...initialRuntime, refresh: async () => {}, byDirectory: { '/project': { alias: { name: 'alias', status: { status: 'connected' } } } } });
  fetchSpy.mockImplementation(serveFixture);
});
afterEach(async () => {
  await act(async () => root.unmount());
  useMcpConfigStore.setState(initialConfig);
  useMcpStore.setState(initialRuntime);
  useProjectsStore.setState(initialProjects);
  useUIStore.setState({ settingsProjectPath: initialSettingsPath });
  useI18nStore.setState(initialLocale);
});
afterAll(() => { fetchSpy.mockRestore(); warningSpy.mockRestore(); errorSpy.mockRestore(); container.remove(); browser.close(); });

test('aliases, unused, off-here and orphan selections share the ordinary MCP grid', async () => {
  // Given
  status = statusWith([connection('original'), connection('unused', { transport: 'http', target: { kind: 'url', label: 'https://fixture.test/mcp' } }), connection('off')]);
  status.selections = {
    global: { off: { connection: 'id-off' } },
    project: { alias: { connection: 'id-original' }, off: { connection: 'id-off', disabled: true }, orphan: { connection: 'gone' } },
    effective: { alias: { connection: 'id-original' }, orphan: { connection: 'gone' } },
  };
  useMcpConfigStore.setState({ serversByDirectory: { '/project': [{ name: 'ordinary', type: 'local', command: ['ordinary'] }] } });
  // When
  await renderGrid();
  // Then
  const alias = cardFor('alias');
  expect(alias.textContent).toContain('original · /usr/bin/fixture');
  expect(alias.textContent).toContain('Connected');
  expect(alias.textContent).toContain('Local project');
  expect(alias.closest('.grid')).toBe(cardFor('ordinary').closest('.grid'));
  expect(cardFor('unused').textContent).toContain('https://fixture.test/mcp');
  expect(cardFor('unused').textContent).toContain('Ready');
  expect(cardFor('unused').textContent).toContain('Not in use');
  expect(cardFor('off').textContent).toContain('Off in this project');
  expect(cardFor('off').textContent).toContain('Ready');
  expect(cardFor('orphan').textContent).toContain('Unavailable');
  expect(cardFor('orphan').tagName).toBe('DIV');
  expect(container.textContent).not.toContain(dict['settings.mcp.grid.empty']);
});

test('opening a protected card selects the connection id and clears the ordinary selection', async () => {
  // Given
  useMcpConfigStore.setState({ selectedMcpName: 'ordinary' });
  await renderGrid();
  // When
  await act(async () => { cardFor('fixture').dispatchEvent(new Event('click', { bubbles: true })); });
  // Then
  expect(useMcpConfigStore.getState().selectedProtectedId).toBe('id-fixture');
  expect(useMcpConfigStore.getState().selectedMcpName).toBeNull();
});

for (const { enabled, credential, expected } of [
  { enabled: false, credential: 'missing', expected: 'Disabled' },
  { enabled: true, credential: 'missing', expected: 'Missing credential' },
  { enabled: true, credential: 'authorization_required', expected: 'Needs sign-in' },
  { enabled: true, credential: 'authorized', expected: 'Connected' },
] as const) {
  test(`effective badge is ${expected} for enabled=${enabled} and credential=${credential}`, async () => {
    // Given
    status = statusWith([connection('alias', { enabled, credential })]);
    status.selections = { global: {}, project: { alias: { connection: 'id-alias' } }, effective: { alias: { connection: 'id-alias' } } };
    // When
    await renderGrid();
    // Then
    const card = cardFor('alias');
    expect(card.textContent).toContain(expected);
    if (expected !== 'Connected') expect(card.textContent).not.toContain('Connected');
  });
}

test('an unverified notice explains known and unknown findings with the subject in code', async () => {
  // Given
  status.service = { state: 'available', status: { administration: 'shared', connections: [], enforcement: { status: 'unverified', findings: [
    { code: 'acl_not_inspected', level: 'unknown', subject: '/opt/protected <fixture>' },
    { code: 'future_check', level: 'unknown' },
  ] } } };
  // When
  await renderGrid();
  // Then
  const notice = container.querySelector('[role="status"]');
  expect(notice?.querySelector('p')?.textContent).toBe(dict['settings.mcp.protected.notice.unverifiedLead']);
  expect(notice?.textContent).not.toContain(dict['settings.mcp.protected.enforcement.unverifiedInfo']);
  expect(notice?.textContent).toContain('ACLs could not be checked for /opt/protected <fixture>: getfacl is not installed.');
  expect(notice?.textContent).toContain('The service reported future_check.');
  expect(notice?.querySelector('code')?.textContent).toBe('/opt/protected <fixture>');
  expect(notice?.querySelector('code')?.getAttribute('dir')).toBe('ltr');
  expect(notice?.querySelector('fixture')).toBeNull();
  expect(notice?.compareDocumentPosition(container.querySelector('.grid') ?? container)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test('an unprotected notice uses its lead separately from the pill tooltip', async () => {
  // Given
  status.service = { state: 'available', status: { administration: 'shared', connections: [], enforcement: {
    status: 'unprotected', findings: [{ code: 'engine_is_root', level: 'error' }],
  } } };
  // When
  await renderGrid();
  // Then
  const notice = container.querySelector('[role="status"]');
  expect(notice?.querySelector('p')?.textContent).toBe(dict['settings.mcp.protected.notice.unprotectedLead']);
  expect(notice?.textContent).not.toContain(dict['settings.mcp.protected.enforcement.unprotectedInfo']);
});

test('shared administration leaves a passing protection check quiet', async () => {
  // Given the shared account is independent of enforcement.
  // When
  await renderGrid();
  // Then
  expect(container.querySelector('[role="status"]')).toBeNull();
});

for (const service of ['unreachable', 'permission_denied', 'invalid_response', 'invalid_client_config', 'not_installed'] as const) {
  test(`a ${service} service keeps selection cleanup as an orphan card`, async () => {
    // Given
    status.service = { state: service };
    status.selections = { global: {}, project: { orphan: { connection: 'gone' } }, effective: { orphan: { connection: 'gone' } } };
    // When
    await renderGrid();
    // Then
    expect(container.querySelector('[role="status"]')?.textContent).toBeTruthy();
    expect(cardFor('orphan').textContent).toContain('Unavailable');
    expect(container.querySelector('[title="fixture"]')).toBeNull();
  });
}

test('an uninstalled service without selections has no notice or protected cards', async () => {
  // Given
  status.service = { state: 'not_installed' };
  // When
  await renderGrid();
  // Then
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('[title="fixture"]')).toBeNull();
});

test('a failed status read reports failure without offering stale connection deletion', async () => {
  // Given
  fetchSpy.mockImplementation(async () => Response.json({}, { status: 503 }));
  // When
  await renderGrid();
  // Then
  expect(container.querySelector('[role="status"]')?.textContent).toBe(dict['settings.mcp.protected.loadFailed']);
  expect(container.querySelector('[title="fixture"]')).toBeNull();
});

test('using a connection here writes the selection in the Settings directory and refreshes its chip', async () => {
  // Given
  fetchSpy.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/selections/fixture')) {
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
      status.selections = { global: {}, project: { fixture: { connection: 'id-fixture' } }, effective: { fixture: { connection: 'id-fixture' } } };
      return Response.json({});
    }
    return serveFixture(input, init);
  });
  await renderGrid();
  // When
  await clickMenuAction('fixture', dict['settings.mcp.protected.action.useHere']);
  // Then
  expect(requests.filter((request) => request.method === 'PUT')).toEqual([{
    url: '/api/protected-mcp/selections/fixture?directory=%2Fproject', method: 'PUT', body: JSON.stringify({ scope: 'project', connection: 'id-fixture' }),
  }]);
  expect(cardFor('fixture').textContent).toContain('Local project');
});

test('confirming server deletion sends the displayed revision and refreshes the grid', async () => {
  // Given
  await renderGrid();
  await clickMenuAction('fixture', dict['settings.mcp.protected.action.delete']);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(dict['settings.mcp.protected.delete.description']);
  expect(requests.some((request) => request.method === 'DELETE')).toBe(false);
  // When
  await confirmDelete();
  // Then
  expect(requests.filter((request) => request.method === 'DELETE')).toEqual([{
    url: '/api/protected-mcp/connections/id-fixture', method: 'DELETE', body: JSON.stringify({ expectedRevision: 7 }),
  }]);
  expect(container.querySelector('[title="fixture"]')).toBeNull();
});

test('a refused delete reloads its revision and closes confirmation before retry', async () => {
  // Given
  let attempts = 0;
  fetchSpy.mockImplementation(async (input, init) => {
    if (init?.method === 'DELETE' && attempts++ === 0) {
      status = statusWith([connection('fixture', { revision: 8 })]);
      return Response.json({ code: 'revision_conflict', error: 'revision_conflict' }, { status: 409 });
    }
    return serveFixture(input, init);
  });
  await renderGrid();
  await clickMenuAction('fixture', dict['settings.mcp.protected.action.delete']);
  // When
  // Avoid happy-dom's disabled-dialog focus trap while exercising the refused request.
  const focus = spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
  try { await confirmDelete(); } finally { focus.mockRestore(); }
  // Then
  expect(cardFor('fixture')).toBeTruthy();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(errors).toEqual([dict['settings.mcp.page.toast.deleteFailed']]);
  await clickMenuAction('fixture', dict['settings.mcp.protected.action.delete']);
  await confirmDelete();
  expect(requests.filter((request) => request.method === 'DELETE')).toEqual([{
    url: '/api/protected-mcp/connections/id-fixture', method: 'DELETE', body: JSON.stringify({ expectedRevision: 8 }),
  }]);
  expect(container.querySelector('[title="fixture"]')).toBeNull();
});

test('the grid consumes its parent status without a second protected read', async () => {
  // Given one protected-status owner in the wrapper.
  // When the grid mounts.
  await renderGrid();
  // Then only that owner reads the directory.
  expect(requests.filter((request) => request.url.includes('/api/protected-mcp/status'))).toHaveLength(1);
});

test('protected card markers have readable text for assistive technology', async () => {
  // Given a protected card whose icon is decorative.
  await renderGrid();
  // When its accessible content is read.
  const marker = cardFor('fixture').querySelector('.sr-only');
  // Then the protection marker has a localized text alternative outside the hidden icon.
  expect(marker?.textContent).toBe(dict['settings.mcp.page.scope.protected']);
  expect(marker?.closest('[aria-hidden="true"]')).toBeNull();
});

test('Refresh reloads protected cards as well as live OpenCode status', async () => {
  // Given a connection changed elsewhere after this grid loaded.
  await renderGrid();
  status = statusWith([connection('new-fixture')]);
  const refresh = container.querySelector<HTMLButtonElement>(`[aria-label="${dict['settings.mcp.sidebar.actions.refreshStatusAria']}"]`);
  if (!refresh) throw new Error('Missing Refresh');
  // When the person refreshes.
  await act(async () => { refresh.click(); });
  // Then protected status is re-read in the same directory.
  expect(cardFor('new-fixture')).toBeTruthy();
  expect(container.querySelector('[title="fixture"]')).toBeNull();
});

test('partial selection cleanup warns and leaves a removable orphan after deletion', async () => {
  // Given
  fetchSpy.mockImplementation(async (input, init) => {
    if (init?.method === 'DELETE') {
      status = statusWith([]);
      status.selections = { global: {}, project: { fixture: { connection: 'id-fixture' } }, effective: { fixture: { connection: 'id-fixture' } } };
      return Response.json({ removed: true, selectionsRemoved: 0, selectionsNotUpdated: ['project-unreadable.json'] });
    }
    return serveFixture(input, init);
  });
  await renderGrid();
  await clickMenuAction('fixture', dict['settings.mcp.protected.action.delete']);
  // When
  await confirmDelete();
  // Then
  expect(cardFor('fixture').textContent).toContain('Unavailable');
  expect(cardFor('fixture').tagName).toBe('DIV');
  expect(warnings).toEqual([dict['settings.mcp.protected.delete.selectionsNotUpdated']]);
});
