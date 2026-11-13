import { afterAll, afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ProtectedDefinition, ProtectedMcpStatus, getProtectedOAuthAttempt } from './protectedMcp';
import type { McpScope } from '@/stores/mcpConfigResponse';
import { dict } from '@/lib/i18n/messages/en';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLButtonElement: browser.HTMLButtonElement, ShadowRoot: browser.ShadowRoot,
  DocumentFragment: browser.DocumentFragment, KeyboardEvent: browser.KeyboardEvent,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
Object.assign(browser.document, { execCommand: () => false });
const projectSettings = { home: '/test', projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' };
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(projectSettings));
const openSpy = spyOn(browser, 'open').mockImplementation(() => null);
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { toast } = await import('@/components/ui');
const { ProtectedMcpPage } = await import('./ProtectedMcpPage');
const { useProtectedMcp } = await import('./protectedMcp');
const { getProtectedConnection } = await import('./protectedMcp');
const { definitionFromForm, formFromConnection } = await import('./protectedMcpForm');
const initialConfigState = useMcpConfigStore.getState();
const initialRuntimeState = useMcpStore.getState();
const container = document.createElement('div');
document.body.appendChild(container);
let root: ReturnType<typeof createRoot>;

const id = 'pmcp_00000000000000a1';
const migrated: ProtectedDefinition = {
  name: 'qa-migrated', enabled: true, transport: 'stdio',
  stdio: {
    command: '/opt/mcp/bin/server', args: ['serve', { state: 'session' }],
    env: { TOKEN_FILE: { secretFile: 'token' }, CACHE_DIR: { state: 'cache' }, MODE: 'read' },
  },
  policy: { denyTools: ['delete_everything'], defaultArguments: { greeting: 'qa' } },
};
const oauth: ProtectedDefinition = {
  name: 'qa-oauth', enabled: true, transport: 'http',
  http: { url: 'https://mcp.test', headers: {}, oauth: { scopes: ['read'] } }, policy: {},
};
const fixedOAuth: ProtectedDefinition = {
  ...oauth, http: { ...oauth.http, oauth: { scopes: ['read'], redirectUri: 'http://127.0.0.1:9/callback' } },
};
const oauthWithClientSecret: ProtectedDefinition = {
  ...oauth, http: { ...oauth.http, oauth: { scopes: [], clientId: 'registered-client', clientSecret: { secret: 'oauth_client_secret' } } },
  policy: { denyTools: ['delete_everything'] },
};
const httpWithEmptyPrefix: ProtectedDefinition = {
  name: 'qa-header', enabled: true, transport: 'http',
  http: {
    url: 'https://mcp.test', headers: { 'X-Api-Key': { secret: 'token', prefix: '' }, 'X-Team': 'blue' },
    oauth: { scopes: [], clientId: '', issuer: 'https://issuer.test/', redirectUri: 'https://fixed.test/callback' },
  },
  policy: { allowTools: [], denyTools: ['delete_everything'], defaultArguments: {} },
};
const npmPackage: ProtectedDefinition = {
  name: 'qa-package', enabled: true, transport: 'stdio',
  stdio: { command: { package: '@scope/mcp', version: '1.2.3', bin: 'mcp' }, args: ['--cache', { state: 'cache' }, ''], env: { TOKEN: { secret: 'token' }, TOKEN_FILE: { secretFile: 'token_file' }, CACHE_DIR: { state: 'cache' }, MODE: '' } },
  policy: { allowTools: [], denyTools: [], defaultArguments: {} },
};
const createdStdio: ProtectedDefinition = {
  name: 'qa-new', enabled: true, transport: 'stdio',
  stdio: { command: '/opt/mcp/bin/server', args: [], env: { TOKEN: { secret: 'token' } } }, policy: {},
};
let definition: ProtectedDefinition;
let updatedDefinition: ProtectedDefinition | null;
let revision: number;
let authorized: boolean;
let secretsSet: boolean;
let httpSlots: string[];
let requests: Request[];
let loadStatus: number;
let writeError: { code: string; error: string; status: number } | null;
let pollResult: Awaited<ReturnType<typeof getProtectedOAuthAttempt>>;
let getCount: number;
let cancelCount: number;
let createScope: McpScope;
const unprotected: Array<{ name: string; transport: string }> = [];
let selections: ProtectedMcpStatus['selections'];
let pollFailures: number;
let completeOutcome: string;
const runtimeActions: Array<{ action: 'disconnect' | 'connect'; name: string; directory: string | null | undefined }> = [];
const refreshes: Array<string | null | undefined> = [];
const errors: string[] = [];
const successes: string[] = [];
const disconnectSpy = spyOn(opencodeClient, 'disconnectMcpServer');
const connectSpy = spyOn(opencodeClient, 'connectMcpServer');
const clipboardSpy = spyOn(browser.navigator.clipboard, 'writeText');
const errorSpy = spyOn(toast, 'error').mockImplementation((message) => { errors.push(String(message)); return 'page-error'; });
const successSpy = spyOn(toast, 'success').mockImplementation((message) => { successes.push(String(message)); return 'page-success'; });

const answer = () => ({ connection: {
  id, name: definition.name, revision, enabled: definition.enabled, transport: definition.transport,
  secrets: Object.fromEntries((definition.transport === 'stdio' ? ['token'] : httpSlots).map((slot) => [slot, { set: secretsSet }])),
  credential: !secretsSet && (definition.transport === 'stdio' || httpSlots.length > 0) ? 'missing'
    : definition.transport === 'http' ? authorized ? 'authorized' : 'authorization_required' : 'stored',
  oauth: definition.transport === 'http' ? { authorized, expiresAt: authorized ? 2000000000000 : null, scope: 'read' } : undefined,
  editable: definition, runtime: 'ready',
} });
const statusAnswer = () => ({
  host: { supported: true }, service: { state: 'available', status: {
    administration: 'shared', enforcement: { status: 'protected', findings: [] }, connections: [{
      id, name: definition.name, revision, enabled: definition.enabled, transport: definition.transport,
      target: { kind: definition.transport === 'stdio' ? 'command' : 'url', label: 'fixture' }, credential: 'stored',
    }],
  } }, selections, selectionsError: null,
});
const handleRequest = async (request: Request) => {
  const path = new URL(request.url).pathname;
  if (path === '/api/protected-mcp/status') return Response.json(statusAnswer());
  if (path === '/api/config/mcp-capabilities') return Response.json({ projectLocal: true });
  if (path === `/api/protected-mcp/connections/${id}` && request.method === 'GET') {
    getCount += 1;
    return loadStatus === 404 ? Response.json({ code: 'connection_not_found', error: 'connection_not_found' }, { status: 404 }) : Response.json(answer());
  }
  if (path.startsWith('/api/protected-mcp/')) {
    requests.push(request);
    if (request.method !== 'GET' && writeError) return Response.json({ code: writeError.code, error: writeError.error }, { status: writeError.status });
    if (path.endsWith('/oauth') && request.method === 'POST') return Response.json({ attempt: 'attempt-fixture', authorizationUrl: 'https://signin.test/authorize?state=fixture' });
    if (path.includes('/oauth/attempts/')) {
      if (pollFailures > 0) { pollFailures -= 1; return Response.json({ code: 'service_unavailable' }, { status: 503 }); }
      if (pollResult.outcome === 'authorized') authorized = true;
      return Response.json(pollResult);
    }
    if (path === '/api/protected-mcp/oauth/complete') { authorized = completeOutcome === 'authorized'; return Response.json({ outcome: completeOutcome, name: definition.name }); }
    if (request.method === 'DELETE') return Response.json({ removed: true, selectionsNotUpdated: [] });
    if (path.endsWith('/revoke')) { secretsSet = false; authorized = false; }
    if (updatedDefinition) definition = updatedDefinition;
    revision += 1;
    return Response.json(answer());
  }
  return Response.json(projectSettings);
};

beforeEach(() => {
  root = createRoot(container);
  definition = migrated;
  updatedDefinition = null;
  revision = 3;
  authorized = false;
  secretsSet = true;
  httpSlots = [];
  requests = [];
  loadStatus = 200;
  writeError = null;
  pollResult = { status: 'pending' };
  getCount = 0;
  cancelCount = 0;
  createScope = 'local';
  unprotected.length = 0;
  selections = { global: {}, project: {}, effective: {} };
  pollFailures = 0;
  completeOutcome = 'authorized';
  runtimeActions.length = 0;
  refreshes.length = 0;
  errors.length = 0;
  successes.length = 0;
  openSpy.mockReset();
  openSpy.mockImplementation(() => null);
  disconnectSpy.mockImplementation(async (name, directory) => { runtimeActions.push({ action: 'disconnect', name, directory }); });
  connectSpy.mockImplementation(async (name, directory) => { runtimeActions.push({ action: 'connect', name, directory }); });
  clipboardSpy.mockReset();
  clipboardSpy.mockResolvedValue(undefined);
  useMcpConfigStore.setState(initialConfigState);
  useMcpStore.setState({ ...initialRuntimeState, refresh: async (options) => { refreshes.push(options?.directory); } });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' });
  fetchSpy.mockImplementation(async (input, init) => handleRequest(new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init)));
});
afterEach(async () => { await act(async () => root.unmount()); jest.useRealTimers(); });
afterAll(() => {
  fetchSpy.mockRestore(); openSpy.mockRestore(); disconnectSpy.mockRestore(); connectSpy.mockRestore();
  clipboardSpy.mockRestore(); errorSpy.mockRestore(); successSpy.mockRestore(); browser.close();
});

function Harness({ create = false }: { readonly create?: boolean }) {
  const protectedMcp = useProtectedMcp('/project');
  return <ProtectedMcpPage protectedMcp={protectedMcp} directory="/project" mode={create
    ? { kind: 'create', name: 'qa-new', transport: 'stdio', scope: createScope, projectLocal: true, onScopeChange: () => {},
      onUnprotect: (name, transport) => { unprotected.push({ name, transport }); }, onCancel: () => { cancelCount += 1; }, onCreated: () => {} }
    : { kind: 'edit', id }} />;
}
const mount = async (create = false) => { await act(async () => { root.render(<I18nProvider><Harness create={create} /></I18nProvider>); }); };
const button = (text: string, scope: ParentNode = container) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};
const field = (label: string) => {
  const found = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find((entry) => entry.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing input ${label}`);
  return found;
};
const edit = async (target: HTMLInputElement | HTMLTextAreaElement, value: string, blur = false) => {
  const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native value setter');
  await act(async () => { setter.call(target, value); target.dispatchEvent(new Event('input', { bubbles: true })); });
  if (blur) await act(async () => { target.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
};
const click = async (target: HTMLElement) => { await act(async () => target.click()); };
const tick = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };
const changedRequests = () => requests.filter((request) => request.method !== 'GET');

test('creating posts a raw stdio definition with the typed secret and project use without retaining it', async () => {
  // Given a new protected form with a write-only TOKEN row.
  await mount(true);
  await edit(field(dict['settings.mcp.protectedPage.executable']), '/opt/mcp/bin/server');
  await click(button(dict['settings.mcp.page.env.addEnvironmentVariable']));
  await edit(field(dict['settings.mcp.page.env.key']), 'TOKEN');
  const sentinel = 'pmcp-sentinel-7-never-in-engine';
  await edit(field('TOKEN'), sentinel);
  // When the person confirms creation.
  await click(button(dict['settings.common.actions.create']));
  // Then only the request carries the value, using the broker grammar.
  const request = changedRequests()[0];
  if (!request) throw new Error('Missing create request');
  expect(new URL(request.url).searchParams.get('directory')).toBe('/project');
  expect(request.headers.get('x-opencode-directory')).toBe('/project');
  expect(await request.json()).toEqual({
    definition: createdStdio,
    secrets: { token: sentinel }, use: { scope: 'project' },
  });
  expect(useMcpConfigStore.getState().selectedProtectedId).toBe(id);
  expect(JSON.stringify(useMcpConfigStore.getState())).not.toContain(sentinel);
  expect(JSON.stringify(browser.localStorage)).not.toContain(sentinel);
  expect([...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].some((entry) => entry.value === sentinel)).toBe(false);
});

test('creating with the Global scope selects the connection for all projects', async () => {
  // Given a new protected form whose scope is Global.
  createScope = 'user';
  await mount(true);
  await edit(field(dict['settings.mcp.protectedPage.executable']), '/opt/mcp/bin/server');
  // When the person confirms creation.
  await click(button(dict['settings.common.actions.create']));
  // Then the route receives a selection for all projects.
  const request = changedRequests()[0];
  if (!request) throw new Error('Missing create request');
  expect(await request.json()).toMatchObject({ use: { scope: 'global' } });
});

test('a Shared project scope cannot create a protected server', async () => {
  // Given a complete protected form whose scope would be repository config.
  createScope = 'project';
  await mount(true);
  await edit(field(dict['settings.mcp.protectedPage.executable']), '/opt/mcp/bin/server');
  // When the person tries to create it.
  const create = button(dict['settings.common.actions.create']);
  await click(create);
  // Then Create stays disabled and nothing reaches the service.
  expect(create.disabled).toBe(true);
  expect(changedRequests()).toEqual([]);
});

test('Protect credentials stays disabled while the create request runs', async () => {
  // Given a create request the service has not answered yet.
  await mount(true);
  await edit(field(dict['settings.mcp.protectedPage.executable']), '/opt/mcp/bin/server');
  let answerCreate = () => {};
  const answered = new Promise<void>((resolve) => { answerCreate = resolve; });
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/protected-mcp/connections') await answered;
    return handleRequest(request);
  });
  await click(button(dict['settings.common.actions.create']));
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((entry) => entry.textContent?.includes(dict['settings.mcp.page.server.protect']));
  if (!row) throw new Error('Missing Protect credentials');
  // When the person tries to uncheck it before the answer.
  await click(row);
  // Then the form stays, and the answer still selects the new connection.
  expect(row.getAttribute('aria-disabled')).toBe('true');
  expect(unprotected).toEqual([]);
  await act(async () => { answerCreate(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(useMcpConfigStore.getState().selectedProtectedId).toBe(id);
});

test('unchecking Protect credentials hands the typed name and transport back without writing', async () => {
  // Given a new protected form with an edited name and the Link type.
  await mount(true);
  await edit(field(dict['settings.mcp.page.server.name']), 'renamed-server');
  await click(button(dict['settings.mcp.page.connection.kindLink']));
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((entry) => entry.textContent?.includes(dict['settings.mcp.page.server.protect']));
  if (!row) throw new Error('Missing Protect credentials');
  expect(row.getAttribute('aria-pressed')).toBe('true');
  // When the person unchecks protection.
  await click(row);
  // Then the ordinary form gets the current name and transport, and nothing reached the service.
  expect(unprotected).toEqual([{ name: 'renamed-server', transport: 'http' }]);
  expect(changedRequests()).toEqual([]);
});

test('a broker field refusal appears under its environment row and focuses its input', async () => {
  // Given syntactically complete input whose key only the broker rejects.
  await mount(true);
  await edit(field(dict['settings.mcp.protectedPage.executable']), '/opt/mcp/bin/server');
  await click(button(dict['settings.mcp.page.env.addEnvironmentVariable']));
  await edit(field(dict['settings.mcp.page.env.key']), '1A');
  await edit(field('1A'), 'synthetic-secret');
  writeError = { code: 'invalid_definition', error: 'invalid_definition: stdio.env.1A', status: 400 };
  // When creation is refused.
  await click(button(dict['settings.common.actions.create']));
  // Then the row owns the translated refusal and focus.
  const row = container.querySelector('[data-protected-field="stdio.env.1A"]');
  expect(row?.querySelector('[role="alert"]')?.textContent).toBe(dict['settings.mcp.protectedPage.error.invalid_definition']);
  expect(row?.contains(document.activeElement)).toBe(true);
});

test('hidden tools autosave preserves the raw migrated destination, secret file and private paths', async () => {
  // Given a migrated definition with an existing policy.
  await mount();
  updatedDefinition = { ...migrated, policy: { ...migrated.policy, denyTools: ['danger_*'] } };
  // When the text field loses focus.
  await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'danger_*', true);
  // Then the update changes only policy and never submits credentials.
  const request = changedRequests()[0];
  if (!request) throw new Error('Missing autosave');
  expect(request.method).toBe('PUT');
  expect(await request.json()).toEqual({ expectedRevision: 3, definition: updatedDefinition, secrets: {} });
  expect(container.querySelector('[data-protected-save]')).toBeNull();
});

test('a destination edit names the stored secret and waits for retyping before explicit Save', async () => {
  // Given a stored secret file and a text environment value.
  await mount();
  updatedDefinition = { ...migrated, stdio: { ...migrated.stdio, env: { ...migrated.stdio.env, MODE: 'write' } } };
  // When the destination changes and the person supplies the required secret.
  await edit(field('MODE'), 'write', true);
  expect(changedRequests()).toHaveLength(0);
  expect(container.querySelector('[data-protected-save]')?.textContent).toContain('token');
  expect(button(dict['settings.mcp.protectedPage.actions.save']).disabled).toBe(true);
  await edit(field('TOKEN_FILE'), 'synthetic-file-content');
  expect(button(dict['settings.mcp.protectedPage.actions.save']).disabled).toBe(false);
  await click(button(dict['settings.mcp.protectedPage.actions.save']));
  // Then Save submits the new raw destination and clears every typed value.
  const request = changedRequests()[0];
  if (!request) throw new Error('Missing destination save');
  expect(await request.json()).toEqual({ expectedRevision: 3, definition: updatedDefinition, secrets: { token: 'synthetic-file-content' } });
  expect(container.querySelector('[data-protected-save]')).toBeNull();
  expect(container.querySelector('textarea')).toBeNull();
});

test('policy autosave uses the saved destination while destination edits and typed secrets remain local', async () => {
  // Given unsaved destination and secret changes.
  await mount();
  await edit(field('MODE'), 'write');
  await edit(field('TOKEN_FILE'), 'synthetic-local-only');
  updatedDefinition = { ...migrated, policy: { ...migrated.policy, denyTools: ['new_tool'] } };
  // When a tool policy change autosaves.
  await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'new_tool', true);
  // Then only policy reaches the server and the destination remains dirty.
  const request = changedRequests()[0];
  if (!request) throw new Error('Missing policy save');
  expect(await request.json()).toEqual({ expectedRevision: 3, definition: updatedDefinition, secrets: {} });
  expect(field('MODE').value).toBe('write');
  expect(field('TOKEN_FILE').value).toBe('synthetic-local-only');
  expect(container.querySelector('[data-protected-save]')).not.toBeNull();
});

test('enabled writes its dedicated endpoint and the next policy save uses its returned revision', async () => {
  // Given an existing enabled connection.
  await mount();
  updatedDefinition = { ...migrated, enabled: false };
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!toggle) throw new Error('Missing Enabled switch');
  // When enabled changes and then the tool policy is edited.
  await click(toggle);
  updatedDefinition = { ...migrated, enabled: false, policy: { ...migrated.policy, denyTools: ['new_tool'] } };
  await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'new_tool', true);
  // Then both writes use the authoritative revision in sequence.
  const [enabled, policy] = changedRequests();
  if (!enabled || !policy) throw new Error('Missing sequential writes');
  expect(new URL(enabled.url).pathname).toBe(`/api/protected-mcp/connections/${id}/enabled`);
  expect(await enabled.json()).toEqual({ expectedRevision: 3, enabled: false });
  expect(await policy.json()).toEqual({ expectedRevision: 4, definition: updatedDefinition, secrets: {} });
});

test('Discard restores the saved destination and clears a typed secret', async () => {
  // Given an edited destination and a retyped secret.
  await mount();
  await edit(field('MODE'), 'write');
  await edit(field('TOKEN_FILE'), 'discard-this-value');
  // When the person discards the edit.
  await click(button(dict['settings.mcp.protectedPage.actions.discard']));
  // Then neither change survives or reaches the server.
  expect(field('MODE').value).toBe('read');
  expect(container.querySelector('[data-protected-save]')).toBeNull();
  expect(container.querySelector('textarea')).toBeNull();
  expect(changedRequests()).toHaveLength(0);
});

test('a revision conflict keeps the draft and offers Reload to restore the authoritative view', async () => {
  // Given an explicit destination save refused by the broker.
  await mount();
  await edit(field('MODE'), 'write');
  await edit(field('TOKEN_FILE'), 'conflicting-value');
  writeError = { code: 'revision_conflict', error: 'revision_conflict', status: 409 };
  // When Save is refused and the person chooses Reload.
  await click(button(dict['settings.mcp.protectedPage.actions.save']));
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.error.revision_conflict']);
  expect(field('MODE').value).toBe('write');
  await click(button(dict['settings.mcp.protectedPage.actions.reload']));
  // Then the saved destination returns and the typed secret is cleared.
  expect(field('MODE').value).toBe('read');
  expect(container.querySelector('[data-protected-save]')).toBeNull();
});

test('Sign in opens the authorization URL and a completed poll reloads the redacted view', async () => {
  // Given an OAuth connection and a deterministic polling clock.
  jest.useFakeTimers();
  definition = oauth;
  await mount();
  pollResult = { status: 'done', outcome: 'authorized' };
  // When the person starts sign-in and the broker completes the attempt.
  await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
  expect(openSpy.mock.calls.at(-1)?.[0]).toBe('https://signin.test/authorize?state=fixture');
  await tick(1500);
  // Then the start revision and polling route are used and authorization is re-read.
  const start = changedRequests()[0];
  if (!start) throw new Error('Missing OAuth start');
  expect(await start.json()).toEqual({ expectedRevision: 3 });
  expect(requests.some((request) => new URL(request.url).pathname.endsWith('/oauth/attempts/attempt-fixture'))).toBe(true);
  expect(getCount).toBe(2);
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.credentials.until'].split('{time}')[0]);
  expect(container.querySelector('[data-busy-dots]')).toBeNull();
});

test('the fixed-redirect paste fallback submits the final address and refreshes authorization', async () => {
  // Given a client registered with a fixed address.
  definition = fixedOAuth;
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.redirectHelp']);
  const address = 'http://127.0.0.1:9/callback?state=fixture&code=synthetic-code';
  // When the person pastes the final address and finishes.
  await edit(field(dict['settings.mcp.protectedPage.address']), address);
  await click(button(dict['settings.mcp.protectedPage.actions.finish']));
  // Then only the complete route receives the address and the field disappears.
  const request = changedRequests().find((entry) => new URL(entry.url).pathname.endsWith('/oauth/complete'));
  expect(request ? await request.json() : null).toEqual({ address });
  expect(getCount).toBe(2);
  expect(container.querySelector('input[aria-label="Address the sign-in tab ended on"]')).toBeNull();
});

for (const ending of ['cancel', 'unknown', 'timeout', 'unmount'] as const) {
  test(`OAuth polling stops after ${ending}`, async () => {
    // Given a pending sign-in.
    jest.useFakeTimers();
    definition = oauth;
    await mount();
    await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
    // When this lifecycle ends the attempt.
    if (ending === 'cancel') await click(button(dict['settings.common.actions.cancel']));
    if (ending === 'unknown') { pollResult = { status: 'unknown' }; await tick(1500); }
    if (ending === 'timeout') await tick(600000);
    if (ending === 'unmount') await act(async () => { root.render(<I18nProvider><span /></I18nProvider>); });
    const count = requests.length;
    await tick(600000);
    // Then no further requests are made.
    expect(requests).toHaveLength(count);
    expect(container.querySelector('[data-busy-dots]')).toBeNull();
  });
}

test('loading a removed connection clears the persisted protected selection', async () => {
  // Given a persisted selection for a removed connection.
  loadStatus = 404;
  useMcpConfigStore.setState({ selectedProtectedId: id });
  // When the edit page reads it.
  await mount();
  // Then the next visit can return to the grid.
  expect(useMcpConfigStore.getState().selectedProtectedId).toBeNull();
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.error.connection_not_found']);
});

test('delete uses the shared confirmation and latest revision before clearing selection', async () => {
  // Given an existing connection selected for editing.
  useMcpConfigStore.setState({ selectedProtectedId: id });
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.delete']));
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Missing deletion confirmation');
  expect(dialog.textContent).toContain(dict['settings.mcp.protected.delete.description']);
  // When deletion is confirmed.
  await click(button(dict['settings.common.actions.delete'], dialog));
  // Then the revision-bearing request removes the selected server.
  const request = changedRequests()[0];
  expect(request?.method).toBe('DELETE');
  expect(request ? await request.json() : null).toEqual({ expectedRevision: 3 });
  expect(useMcpConfigStore.getState().selectedProtectedId).toBeNull();
});

test('Cancel clears a secret from a new form without writing it', async () => {
  // Given a new form containing an unsaved secret.
  await mount(true);
  await click(button(dict['settings.mcp.page.env.addEnvironmentVariable']));
  await edit(field(dict['settings.mcp.page.env.key']), 'TOKEN');
  await edit(field('TOKEN'), 'cancel-this-value');
  // When creation is cancelled.
  await click(button(dict['settings.common.actions.cancel']));
  // Then no write occurs and no input holds the value.
  expect(cancelCount).toBe(1);
  expect(changedRequests()).toHaveLength(0);
  expect([...container.querySelectorAll<HTMLInputElement>('input')].some((entry) => entry.value === 'cancel-this-value')).toBe(false);
});

test('switching locale preserves unsaved destination and secret input state', async () => {
  // Given a dirty form.
  await mount();
  await edit(field('MODE'), 'write');
  await edit(field('TOKEN_FILE'), 'locale-local-value');
  // When the locale changes while this page remains mounted.
  await act(async () => { await useI18nStore.getState().setLocale('pt-BR'); });
  // Then no reload or write drops the edit.
  expect(field('MODE').value).toBe('write');
  expect(field('TOKEN_FILE').value).toBe('locale-local-value');
  expect(getCount).toBe(1);
  expect(changedRequests()).toHaveLength(0);
  await act(async () => { await useI18nStore.getState().setLocale('en'); });
});

test('forgetting credentials requires confirmation and renders the returned missing state', async () => {
  // Given a connection with stored credentials.
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.forget']));
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Missing credential confirmation');
  expect(changedRequests()).toHaveLength(0);
  // When the person confirms forgetting them.
  await click(button(dict['settings.mcp.protectedPage.actions.forget'], dialog));
  // Then the server receives only the revision and the write-only input requests a new value.
  const request = changedRequests()[0];
  expect(request ? new URL(request.url).pathname : null).toBe(`/api/protected-mcp/connections/${id}/revoke`);
  expect(request ? await request.json() : null).toEqual({ expectedRevision: 3 });
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.credentials.missing'].replace('{labels}', 'token'));
  expect(field('TOKEN_FILE').value).toBe('');
});

for (const code of ['name_in_use', 'selections_unreadable', 'service_permission_denied', 'future_broker_code'] as const) {
  test(`creation reports ${code} without discarding the input or selecting a server`, async () => {
    // Given a complete form and a route refusal.
    await mount(true);
    await edit(field(dict['settings.mcp.protectedPage.executable']), '/opt/mcp/bin/server');
    writeError = { code, error: 'Future broker explanation', status: 409 };
    // When creation fails.
    await click(button(dict['settings.common.actions.create']));
    // Then known codes are localized and an unknown code preserves its explanation.
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(code === 'future_broker_code'
      ? 'Future broker explanation' : dict[`settings.mcp.protectedPage.error.${code}`]);
    expect(field(dict['settings.mcp.protectedPage.executable']).value).toBe('/opt/mcp/bin/server');
    expect(useMcpConfigStore.getState().selectedProtectedId).toBeNull();
  });
}

test('a sign-in read started before cancellation cannot overwrite a later destination edit', async () => {
  // Given a completed OAuth attempt whose detail read is still in flight.
  jest.useFakeTimers();
  definition = oauth;
  useEffectiveAliases();
  await mount();
  let finishRead: (response: Response) => void = () => {};
  let markRead = () => {};
  const response = new Promise<Response>((resolve) => { finishRead = resolve; });
  const started = new Promise<void>((resolve) => { markRead = resolve; });
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
    if (new URL(request.url).pathname === `/api/protected-mcp/connections/${id}` && request.method === 'GET') {
      markRead();
      return response;
    }
    return handleRequest(request);
  });
  pollResult = { status: 'done', outcome: 'authorized' };
  await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
  await tick(1500);
  await started;
  // When the person cancels and starts editing before the read completes.
  await click(button(dict['settings.common.actions.cancel']));
  await edit(field(dict['settings.mcp.protectedPage.url']), 'https://new-destination.test');
  await act(async () => { finishRead(Response.json(answer())); });
  // Then the old sign-in completion cannot replace the new destination.
  expect(field(dict['settings.mcp.protectedPage.url']).value).toBe('https://new-destination.test');
  expect(runtimeActions).toEqual([]);
});

test('V7-1: tools autosave after Forget preserves the configured OAuth client-secret reference', async () => {
  // Given a revoked client credential whose slot remains configured.
  definition = oauthWithClientSecret;
  httpSlots = ['oauth_client_secret'];
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.forget']));
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Missing credential confirmation');
  await click(button(dict['settings.mcp.protectedPage.actions.forget'], dialog));
  updatedDefinition = { ...oauthWithClientSecret, policy: { ...oauthWithClientSecret.policy, denyTools: ['danger_*'] } };
  // When Hidden tools autosaves.
  await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'danger_*', true);
  // Then the raw destination, including the missing client-secret slot, is unchanged.
  const request = changedRequests().find((entry) => entry.method === 'PUT');
  expect(request ? await request.json() : null).toEqual({ expectedRevision: 4, definition: updatedDefinition, secrets: {} });
  expect(container.querySelector('[data-protected-save]')).toBeNull();
  const persisted = await getProtectedConnection(id);
  expect(persisted.revision).toBe(5);
  expect(persisted.secrets).toEqual({ oauth_client_secret: { set: false } });
  expect(persisted.credential).toBe('missing');
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.credentials.missing'].replace('{labels}', 'oauth_client_secret'));
  expect(errors).toEqual([]);
});

test('a blocked automatic OAuth tab leaves a read-only link that opens from its own click', async () => {
  // Given window.open refuses the automatic attempt.
  definition = oauth;
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
  // When the person uses the retained authorization address.
  const link = field(dict['settings.providers.page.auth.oauth.linkLabel']);
  expect(link.readOnly).toBe(true);
  expect(link.value).toBe('https://signin.test/authorize?state=fixture');
  expect(openSpy.mock.calls).toHaveLength(1);
  await click(button(dict['settings.providers.page.actions.open']));
  // Then a new open attempt happens directly in that click without restarting OAuth.
  expect(openSpy.mock.calls).toHaveLength(2);
  expect(openSpy.mock.calls.at(-1)?.[0]).toBe(link.value);
  expect(changedRequests()).toHaveLength(1);
});

for (const copied of [true, false]) {
  test(`copying the OAuth authorization address reports ${copied ? 'success' : 'failure'}`, async () => {
    // Given a waiting attempt and the clipboard's result.
    definition = oauth;
    if (!copied) clipboardSpy.mockRejectedValue(new Error('Clipboard denied'));
    await mount();
    await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
    // When Copy is clicked.
    await click(button(dict['settings.providers.page.actions.copy']));
    // Then the authorization address is copied with the shared provider feedback.
    expect(clipboardSpy.mock.calls.at(-1)?.[0]).toBe('https://signin.test/authorize?state=fixture');
    expect(copied ? successes : errors).toEqual([dict[copied
      ? 'settings.providers.page.toast.oauthLinkCopied' : 'settings.providers.page.toast.oauthLinkCopyFailed']]);
  });
}

for (const code of ['secret_missing', 'unknown_secret', 'invalid_secret', 'credential_rebind_required'] as const) {
  test(`a bare ${code} slot is reported on its secret-file row after Save`, async () => {
    // Given a destination edit that includes the required credential.
    await mount();
    await edit(field('MODE'), 'write');
    await edit(field('TOKEN_FILE'), 'synthetic-retyped-value');
    writeError = { code, error: `${code}: token`, status: 400 };
    // When the broker refuses the slot.
    await click(button(dict['settings.mcp.protectedPage.actions.save']));
    // Then the rendered row owns the error and receives explicit-save focus.
    const row = container.querySelector('[data-protected-field="stdio.env.TOKEN_FILE"]');
    expect(row?.querySelector('[role="alert"]')?.textContent).toBe(dict[`settings.mcp.protectedPage.error.${code}`]);
    expect(row?.contains(document.activeElement)).toBe(true);
  });
}

test('a new secret slot refusal appears on its generated environment row during Create', async () => {
  // Given a new row whose generated slot differs from its visible label.
  await mount(true);
  await edit(field(dict['settings.mcp.protectedPage.executable']), '/opt/mcp/bin/server');
  await click(button(dict['settings.mcp.page.env.addEnvironmentVariable']));
  await edit(field(dict['settings.mcp.page.env.key']), 'NEW_TOKEN');
  await edit(field('NEW_TOKEN'), 'synthetic-create-value');
  writeError = { code: 'invalid_secret', error: 'invalid_secret: new_token', status: 400 };
  // When Create is refused.
  await click(button(dict['settings.common.actions.create']));
  // Then the generated slot resolves to the row in the current form.
  expect(container.querySelector('[data-protected-field="stdio.env.NEW_TOKEN"] [role="alert"]')?.textContent)
    .toBe(dict['settings.mcp.protectedPage.error.invalid_secret']);
});

for (const secret of ['header', 'oauth'] as const) {
  test(`a bare ${secret} secret slot appears on its HTTP field`, async () => {
    // Given a configured HTTP secret with a typed replacement.
    definition = secret === 'header' ? httpWithEmptyPrefix : oauthWithClientSecret;
    httpSlots = [secret === 'header' ? 'token' : 'oauth_client_secret'];
    await mount();
    await click(button(dict['settings.mcp.protectedPage.actions.replace']));
    await edit(field(secret === 'header' ? 'X-Api-Key' : dict['settings.mcp.protectedPage.clientSecret']), 'synthetic-replacement');
    writeError = { code: 'invalid_secret', error: `invalid_secret: ${httpSlots[0]}`, status: 400 };
    // When the replacement is refused.
    await click(button(dict['settings.mcp.protectedPage.actions.save']));
    // Then its HTTP field displays the translated error.
    const path = secret === 'header' ? 'http.headers.X-Api-Key' : 'http.oauth.clientSecret';
    expect(container.querySelector(`[data-protected-field="${path}"] [role="alert"]`)?.textContent)
      .toBe(dict['settings.mcp.protectedPage.error.invalid_secret']);
  });
}

test('an error naming an unrendered field remains visible in the page alert', async () => {
  // Given a broker field that this form does not render.
  await mount();
  writeError = { code: 'invalid_definition', error: 'invalid_definition: future.setting', status: 400 };
  // When tools autosave fails.
  await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'bad_tool', true);
  // Then the error is visible even though no row matches it.
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(dict['settings.mcp.protectedPage.error.invalid_definition']);
});

test('Discard waits for an enabled write and retains current enabled and policy choices', async () => {
  // Given an enabled autosave in flight beside unsaved destination and tool edits.
  await mount();
  let finishWrite = () => {};
  const writing = new Promise<void>((resolve) => { finishWrite = resolve; });
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
    const response = await handleRequest(request);
    if (new URL(request.url).pathname.endsWith('/enabled')) await writing;
    return response;
  });
  await edit(field('MODE'), 'write');
  await edit(field('TOKEN_FILE'), 'discard-in-flight');
  updatedDefinition = { ...migrated, enabled: false };
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
  if (!toggle) throw new Error('Missing Enabled switch');
  await click(toggle);
  await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'newer_tool');
  // When Discard is queued behind the write.
  await click(button(dict['settings.mcp.protectedPage.actions.discard']));
  const destinationWhileWriting = field('MODE').value;
  await act(async () => { finishWrite(); });
  // Then only destination and typed credentials revert to the completed baseline.
  expect(destinationWhileWriting).toBe('write');
  expect(field('MODE').value).toBe('read');
  expect(field(dict['settings.mcp.protectedPage.hiddenTools']).value).toBe('newer_tool');
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(container.querySelector('[data-protected-save]')).toBeNull();
  expect(changedRequests()).toHaveLength(1);
});

test('a failed tools autosave leaves focus on the field the person moved to', async () => {
  // Given a tool policy the broker refuses and another field already focused.
  await mount();
  writeError = { code: 'invalid_definition', error: 'invalid_definition: policy.denyTools', status: 400 };
  const destination = field('MODE');
  await act(async () => { destination.focus(); });
  const tools = field(dict['settings.mcp.protectedPage.hiddenTools']);
  // Observe a focus attempt without letting the regression create an endless blur/save loop.
  const focus = spyOn(tools, 'focus').mockImplementation(() => {});
  try {
    // When the tool edit loses focus and autosaves.
    await edit(tools, 'invalid tool', true);
    // Then the inline error leaves focus where the person put it.
    expect(container.querySelector('[data-protected-field="policy.denyTools"] [role="alert"]')).not.toBeNull();
    expect(focus.mock.calls).toEqual([]);
    expect(document.activeElement).toBe(destination);
  } finally { focus.mockRestore(); }
});

test('an invalid redirect address is translated on its field after Save', async () => {
  // Given an invalid fixed address submitted to the broker.
  definition = oauth;
  await mount();
  await edit(field(dict['settings.mcp.protectedPage.redirect']), 'file:///invalid');
  writeError = { code: 'invalid_redirect_uri', error: 'invalid_redirect_uri: http.oauth.redirectUri', status: 400 };
  // When Save is refused.
  await click(button(dict['settings.mcp.protectedPage.actions.save']));
  // Then the field displays a sentence and receives explicit-save focus.
  const row = container.querySelector('[data-protected-field="http.oauth.redirectUri"]');
  expect(row?.querySelector('[role="alert"]')?.textContent).not.toContain('invalid_redirect_uri');
  expect(row?.querySelector('[role="alert"]')?.textContent).toBe(dict['settings.mcp.protectedPage.error.invalid_redirect_uri']);
  expect(document.activeElement).toBe(field(dict['settings.mcp.protectedPage.redirect']));
});

for (const action of ['delete', 'forget'] as const) {
  test(`a ${action} revision conflict closes confirmation so Reload can recover`, async () => {
    // Given a stale confirmation and a newer broker revision.
    await mount();
    const label = dict[action === 'delete' ? 'settings.mcp.protectedPage.actions.delete' : 'settings.mcp.protectedPage.actions.forget'];
    await click(button(label));
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error('Missing confirmation');
    writeError = { code: 'revision_conflict', error: 'revision_conflict', status: 409 };
    // When the stale operation is refused.
    const focus = spyOn(HTMLElement.prototype, 'focus').mockImplementation(() => {});
    // Disabled-dialog focus trapping is not implemented by happy-dom; this case exercises revision recovery.
    try {
      await click(button(dict[action === 'delete' ? 'settings.common.actions.delete' : 'settings.mcp.protectedPage.actions.forget'], dialog));
    } finally { focus.mockRestore(); }
    // Then Reload is reachable and the next confirmation uses the new revision.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    revision = 8;
    writeError = null;
    await click(button(dict['settings.mcp.protectedPage.actions.reload']));
    await click(button(label));
    const retry = document.querySelector('[role="dialog"]');
    if (!retry) throw new Error('Missing retry confirmation');
    await click(button(dict[action === 'delete' ? 'settings.common.actions.delete' : 'settings.mcp.protectedPage.actions.forget'], retry));
    const request = changedRequests().at(-1);
    expect(request ? await request.json() : null).toEqual({ expectedRevision: 8 });
  });
}

test('OAuth polling recovers after a failed read while the attempt is still live', async () => {
  // Given an attempt whose first read fails and whose next read observes authorization.
  jest.useFakeTimers();
  definition = oauth;
  pollFailures = 1;
  pollResult = { status: 'done', outcome: 'authorized' };
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
  // When a transient read fails and polling reaches its next interval.
  await tick(1500);
  expect(container.querySelector('[data-busy-dots]')).not.toBeNull();
  await tick(1500);
  // Then the attempt completes and the connection is read again.
  expect(getCount).toBe(2);
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.credentials.until'].split('{time}')[0]);
  expect(container.querySelector('[data-busy-dots]')).toBeNull();
});

test('a replayed pasted address uses the attempt outcome when the callback already authorized it', async () => {
  // Given a callback that already consumed the state successfully.
  definition = fixedOAuth;
  useEffectiveAliases();
  completeOutcome = 'oauth_state_invalid';
  pollResult = { status: 'done', outcome: 'authorized' };
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
  await edit(field(dict['settings.mcp.protectedPage.address']), 'http://127.0.0.1:9/callback?state=fixture&code=synthetic');
  // When the pasted address cannot consume the state a second time.
  await click(button(dict['settings.mcp.protectedPage.actions.finish']));
  // Then the attempt's successful outcome wins over the replay response.
  expect(requests.filter((request) => new URL(request.url).pathname.includes('/oauth/attempts/'))).toHaveLength(1);
  expect(getCount).toBe(2);
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.credentials.until'].split('{time}')[0]);
  expectAliasReconnect();
});

test('a rejected pasted address keeps polling while its own attempt is pending', async () => {
  // Given a pasted address that does not belong to the live attempt.
  jest.useFakeTimers();
  definition = fixedOAuth;
  completeOutcome = 'oauth_state_invalid';
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
  await edit(field(dict['settings.mcp.protectedPage.address']), 'http://127.0.0.1:9/callback?state=other&code=synthetic');
  // When completion is refused but the attempt is still pending.
  await click(button(dict['settings.mcp.protectedPage.actions.finish']));
  expect(requests.filter((request) => new URL(request.url).pathname.includes('/oauth/attempts/'))).toHaveLength(1);
  expect(container.querySelector('[data-busy-dots]')).not.toBeNull();
  pollResult = { status: 'done', outcome: 'authorized' };
  await tick(1500);
  // Then a later authorization is still observed.
  expect(getCount).toBe(2);
  expect(container.querySelector('[data-busy-dots]')).toBeNull();
});

for (const final of ['oauth_denied', 'oauth_exchange_failed', 'unknown'] as const) {
  test(`OAuth ${final} reloads the connection after its final outcome`, async () => {
    // Given a pending attempt with a final broker outcome.
    jest.useFakeTimers();
    definition = oauth;
    await mount();
    await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
    pollResult = final === 'unknown' ? { status: 'unknown' } : { status: 'done', outcome: final };
    // When the final outcome is observed.
    await tick(1500);
    // Then even an unsuccessful attempt refreshes the redacted connection.
    expect(getCount).toBe(2);
    expect(container.querySelector('[data-busy-dots]')).toBeNull();
    expect(runtimeActions).toEqual([]);
  });
}

const useEffectiveAliases = () => {
  selections = {
    global: { first: { connection: id }, off: { connection: id } },
    project: { second: { connection: id }, off: { connection: id, disabled: true }, other: { connection: 'pmcp_other' } },
    effective: { first: { connection: id }, second: { connection: id }, off: { connection: id, disabled: true }, other: { connection: 'pmcp_other' } },
  };
};
const expectAliasReconnect = () => {
  expect(runtimeActions.filter(({ name }) => name === 'first')).toEqual([
    { action: 'disconnect', name: 'first', directory: '/project' }, { action: 'connect', name: 'first', directory: '/project' },
  ]);
  expect(runtimeActions.filter(({ name }) => name === 'second')).toEqual([
    { action: 'disconnect', name: 'second', directory: '/project' }, { action: 'connect', name: 'second', directory: '/project' },
  ]);
  expect(runtimeActions).toHaveLength(4);
  expect(refreshes.at(-1)).toBe('/project');
};

for (const change of ['destination', 'secret', 'enable', 'forget', 'oauth'] as const) {
  test(`${change} reconnects exactly the effective names in the Settings directory`, async () => {
    // Given effective aliases, an off-here alias and another connection's name.
    definition = change === 'oauth' ? oauth : change === 'enable' ? { ...migrated, enabled: false } : migrated;
    useEffectiveAliases();
    await mount();
    // When a successful operation invalidates live broker sessions.
    if (change === 'destination') {
      await edit(field('MODE'), 'write');
      await edit(field('TOKEN_FILE'), 'synthetic-new-destination');
      updatedDefinition = { ...migrated, stdio: { ...migrated.stdio, env: { ...migrated.stdio.env, MODE: 'write' } } };
      await click(button(dict['settings.mcp.protectedPage.actions.save']));
    } else if (change === 'secret') {
      await click(button(dict['settings.mcp.protectedPage.actions.replace']));
      await edit(field('TOKEN_FILE'), 'synthetic-replacement');
      await click(button(dict['settings.mcp.protectedPage.actions.save']));
    } else if (change === 'enable') {
      updatedDefinition = migrated;
      const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
      if (!toggle) throw new Error('Missing Enabled switch');
      await click(toggle);
    } else if (change === 'forget') {
      await click(button(dict['settings.mcp.protectedPage.actions.forget']));
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) throw new Error('Missing Forget confirmation');
      await click(button(dict['settings.mcp.protectedPage.actions.forget'], dialog));
    } else {
      jest.useFakeTimers();
      pollResult = { status: 'done', outcome: 'authorized' };
      await click(button(dict['settings.mcp.protectedPage.actions.signIn']));
      await tick(1500);
    }
    // Then both aliases disconnect before reconnecting, with no other name or directory touched.
    expectAliasReconnect();
  });
}

for (const change of ['tools', 'disabled-destination'] as const) {
  test(`${change} never reconnects effective aliases`, async () => {
    // Given selected aliases and either an enabled or disabled connection.
    definition = change === 'tools' ? migrated : { ...migrated, enabled: false };
    useEffectiveAliases();
    await mount();
    // When policy alone saves, or a disabled destination saves.
    if (change === 'tools') {
      updatedDefinition = { ...migrated, policy: { denyTools: ['new_tool'] } };
      await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'new_tool', true);
    } else {
      updatedDefinition = { ...migrated, enabled: false, stdio: { ...migrated.stdio, env: { ...migrated.stdio.env, MODE: 'write' } } };
      await edit(field('MODE'), 'write');
      await edit(field('TOKEN_FILE'), 'synthetic-disabled-value');
      await click(button(dict['settings.mcp.protectedPage.actions.save']));
    }
    // Then the applied write refreshes status without reconnecting anything.
    expect(changedRequests()).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(runtimeActions).toEqual([]);
  });
}

test('a reconnect failure leaves Save successful and reconnects the other effective name', async () => {
  // Given a stored replacement and one alias whose OpenCode connect fails.
  useEffectiveAliases();
  await mount();
  connectSpy.mockImplementationOnce(async (name, directory) => {
    runtimeActions.push({ action: 'connect', name, directory });
    throw new Error('Synthetic OpenCode connection failure');
  });
  await click(button(dict['settings.mcp.protectedPage.actions.replace']));
  await edit(field('TOKEN_FILE'), 'synthetic-reconnect-failure');
  // When Save applies but reconnection fails for one name.
  await click(button(dict['settings.mcp.protectedPage.actions.save']));
  // Then failures appear only in status, leaving the saved credential and other alias valid.
  expectAliasReconnect();
  expect(container.querySelector('[data-protected-save]')).toBeNull();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain(dict['settings.mcp.page.status.label.failed']);
  expect(errors).toEqual([]);
});

test('V7-1: a destination change after Forget requires the configured OAuth client secret again', async () => {
  // Given an OAuth client-secret slot with no stored value after revocation.
  definition = oauthWithClientSecret;
  httpSlots = ['oauth_client_secret'];
  await mount();
  await click(button(dict['settings.mcp.protectedPage.actions.forget']));
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error('Missing credential confirmation');
  await click(button(dict['settings.mcp.protectedPage.actions.forget'], dialog));
  // When the URL changes.
  await edit(field(dict['settings.mcp.protectedPage.url']), 'https://new-destination.test', true);
  // Then Save waits for that configured secret, and typing it enables Save.
  expect(container.querySelector('[data-protected-save]')?.textContent).toContain('oauth_client_secret');
  expect(button(dict['settings.mcp.protectedPage.actions.save']).disabled).toBe(true);
  await edit(field(dict['settings.mcp.protectedPage.clientSecret']), 'v7-synthetic-client-secret');
  expect(button(dict['settings.mcp.protectedPage.actions.save']).disabled).toBe(false);
  expect(changedRequests().filter((entry) => entry.method === 'PUT')).toHaveLength(0);
});

test('V7-2: tools autosave preserves an explicitly empty header prefix without a destination Save bar', async () => {
  // Given a stored header secret with an explicitly empty prefix.
  definition = httpWithEmptyPrefix;
  httpSlots = ['token'];
  await mount();
  updatedDefinition = { ...httpWithEmptyPrefix, policy: { ...httpWithEmptyPrefix.policy, denyTools: ['danger_*'] } };
  // When Hidden tools autosaves.
  await edit(field(dict['settings.mcp.protectedPage.hiddenTools']), 'danger_*', true);
  // Then the PUT keeps the exact raw destination and optional-field presence.
  const request = changedRequests()[0];
  expect(request ? await request.json() : null).toEqual({ expectedRevision: 3, definition: updatedDefinition, secrets: {} });
  expect(container.querySelector('[data-protected-save]')).toBeNull();
});

for (const raw of [migrated, oauth, fixedOAuth, oauthWithClientSecret, httpWithEmptyPrefix, npmPackage, createdStdio]) {
  test(`V7 round-trip: ${raw.name} retains the raw page fixture through view and form conversion`, async () => {
    // Given a raw fixture shared by the page scenarios.
    definition = raw;
    secretsSet = false;
    // When the real API parser and form conversion read it without edits.
    const form = formFromConnection(await getProtectedConnection(id));
    const result = definitionFromForm(form);
    // Then every field and reference survives, without submitting a secret value.
    expect(result).toEqual({ definition: raw, secrets: {} });
  });
}
