import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { McpDraft } from '@/stores/useMcpConfigStore';
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
// Import-time Settings reads must preserve the project used by this scenario.
const projectSettings = { home: '/test', projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' };
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(projectSettings));
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { useMcpConfigStore } = await import('@/stores/useMcpConfigStore');
const { useMcpStore } = await import('@/stores/useMcpStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { McpPage } = await import('./McpPage');
const initialConfigState = useMcpConfigStore.getState();
const initialRuntimeState = useMcpStore.getState();
const container = document.createElement('div');
document.body.appendChild(container);
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  root = createRoot(container);
  useMcpConfigStore.setState(initialConfigState);
  useMcpStore.setState({ ...initialRuntimeState, refresh: async () => {} });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }], activeProjectId: 'project' });
});
afterEach(async () => { await act(async () => root.unmount()); });
afterAll(() => { fetchSpy.mockRestore(); browser.close(); });

/** DOM click() omits the hover and pointer events that Base UI uses for selection. */
const clickWithPointer = async (target: HTMLElement, pointerType: 'mouse' | 'touch') => {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType }));
    target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType }));
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    if (pointerType === 'mouse') target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
  if (pointerType === 'mouse' && target.getAttribute('role') === 'option') {
    expect(target.hasAttribute('data-highlighted')).toBe(true);
  }
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType, button: 0, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
    // The shared select opens from mousedown on its next animation frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType, button: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }));
  });
};

for (const pointerType of ['mouse', 'touch'] as const) {
  test(`selecting Local project with ${pointerType} creates through the real store with local scope`, async () => {
    // Given a Global draft so ignoring the selection would send the wrong owner.
    const draft: McpDraft = {
      name: 'scope-pointer-probe', scope: 'user', type: 'remote', command: [], url: 'https://mcp.test',
      environment: [], headers: [], oauthEnabled: false, oauthClientId: '', oauthClientSecret: '',
      oauthScope: '', oauthRedirectUri: '', oauthCallbackPort: '', oauthAuthServerMetadataUrl: '',
      protocol: 'legacy', timeoutStartup: '', timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
    };
    const posts: Request[] = [];
    let markCapabilityConsumed = () => {};
    const capabilityConsumed = new Promise<void>((resolve) => { markCapabilityConsumed = resolve; });
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/config/mcp-capabilities') {
        const response = Response.json({ projectLocal: true });
        const readJson = response.json.bind(response);
        spyOn(response, 'json').mockImplementation(async () => {
          const body: unknown = await readJson();
          markCapabilityConsumed();
          return body;
        });
        return response;
      }
      if (path === '/api/config') return Response.json([]);
      if (path === `/api/config/mcp/${draft.name}` && request.method === 'POST') {
        posts.push(request);
        return Response.json({ success: true });
      }
      if (path === '/api/config/mcp') return Response.json(posts.length === 0 ? [] : [{
        name: draft.name, scope: 'local', type: 'remote', url: draft.url,
      }]);
      return Response.json(projectSettings);
    });
    useMcpConfigStore.setState({ selectedMcpName: draft.name, mcpDraft: draft });
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    // Body parsing can outlast popup opening; commit capability before choosing a scope.
    await act(async () => { await capabilityConsumed; });
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
    if (!trigger) throw new Error('Missing scope selector');

    // When the person chooses the local scope and confirms creation.
    await clickWithPointer(trigger, pointerType);
    const local = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
      .find((item) => item.textContent?.includes(dict['settings.mcp.grid.scope.local']));
    if (!local) throw new Error('Missing Local project option');
    expect(local.getAttribute('aria-disabled')).not.toBe('true');
    await clickWithPointer(local, pointerType);
    expect(trigger.textContent).toContain(dict['settings.mcp.grid.scope.local']);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const create = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === dict['settings.common.actions.create']);
    if (!create) throw new Error('Missing create action');
    await clickWithPointer(create, pointerType);

    // Then the real page, store, and runtimeFetch serialize the selected owner.
    expect(posts).toHaveLength(1);
    const post = posts[0];
    if (!post) throw new Error('Missing create request');
    expect(new URL(post.url).pathname).toBe(`/api/config/mcp/${draft.name}`);
    expect(new URL(post.url).searchParams.get('directory')).toBe('/project');
    expect(post.headers.get('x-opencode-directory')).toBe('/project');
    const body: unknown = await post.json();
    expect(body).toMatchObject({ scope: 'local', type: 'remote', url: draft.url });
  });
}

const protectedDraft: McpDraft = {
  name: 'protected-scope-probe', scope: 'user', type: 'remote', command: [], url: 'https://mcp.test',
  environment: [], headers: [], oauthEnabled: false, oauthClientId: '', oauthClientSecret: '',
  oauthScope: '', oauthRedirectUri: '', oauthCallbackPort: '', oauthAuthServerMetadataUrl: '',
  protocol: 'legacy', timeoutStartup: '', timeoutCatalog: '', timeoutExecution: '', codemode: 'default', disabled: false,
};

const protectRow = () => [...container.querySelectorAll<HTMLElement>('[role="button"]')]
  .find((entry) => entry.textContent?.includes(dict['settings.mcp.page.server.protect']));
const scopeOption = (label: string) => [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')]
  .find((entry) => entry.textContent?.includes(label));
const scopeTrigger = () => {
  const trigger = container.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
  if (!trigger) throw new Error('Missing scope selector');
  return trigger;
};

for (const service of ['unsupported', 'not_installed', 'unreachable', 'available'] as const) {
  test(`Protect credentials ${service} controls availability and keeps the OpenCode scopes`, async () => {
    // Given a new server and the connected host's protected-service status.
    useMcpConfigStore.setState({ selectedMcpName: protectedDraft.name, selectedProtectedId: null, mcpDraft: protectedDraft });
    let capabilityReads = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/config/mcp-capabilities') { capabilityReads += 1; return Response.json({ projectLocal: true }); }
      if (path === '/api/config') return Response.json([]);
      if (path === '/api/protected-mcp/status') {
        if (service === 'unsupported') return Response.json({ code: 'unsupported_host' }, { status: 501 });
        return Response.json({
          host: { supported: true },
          service: service === 'available' ? { state: 'available', status: {
            administration: 'shared', enforcement: { status: 'protected', findings: [] }, connections: [],
          } } : { state: service },
          selections: { global: {}, project: {}, effective: {} }, selectionsError: null,
        });
      }
      return Response.json(projectSettings);
    });
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    // When the person looks for protection under the name and scope.
    const row = protectRow();
    // Then unsupported or missing services hide it, and an unreachable one says why it is off.
    if (service === 'unsupported' || service === 'not_installed') {
      expect(row).toBeUndefined();
      return;
    }
    if (!row) throw new Error('Missing Protect credentials');
    if (service === 'unreachable') {
      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(container.textContent).toContain(dict['settings.mcp.protected.service.unreachable']);
      return;
    }
    expect(row.getAttribute('aria-pressed')).toBe('false');
    // When the person presses Enter on the row's info button.
    const info = row.querySelector('button');
    if (!info) throw new Error('Missing info button');
    await act(async () => { info.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    // Then the key belongs to the info button and protection stays off.
    expect(protectRow()?.getAttribute('aria-pressed')).toBe('false');
    expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    const readsBeforeProtect = capabilityReads;
    // When the person checks it.
    await act(async () => { row.click(); });
    // Then the protected form keeps the name, transport and scope, warns about shared administration and asks nothing else about projects.
    expect(container.textContent).toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    expect(document.activeElement?.getAttribute('data-settings-item')).toBe('mcp.protect');
    expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
    expect(capabilityReads).toBe(readsBeforeProtect);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Server name"]')?.value).toBe(protectedDraft.name);
    expect(container.querySelector('input[aria-label="Server name"]')?.getAttribute('dir')).toBe('ltr');
    expect(container.querySelector('input[aria-label="URL"]')).not.toBeNull();
    expect(container.textContent).toContain(dict['settings.mcp.page.scope.sharedAdministration']);
    expect(container.textContent).not.toContain('Use in');
    expect(scopeTrigger().textContent).toContain(dict['settings.mcp.grid.scope.user']);
    // When the person opens the scope picker and chooses Local project.
    await clickWithPointer(scopeTrigger(), 'mouse');
    expect(scopeOption(dict['settings.mcp.grid.scope.project'])?.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain(dict['settings.mcp.page.scope.projectUnavailableProtected']);
    const local = scopeOption(dict['settings.mcp.grid.scope.local']);
    if (!local) throw new Error('Missing Local project option');
    expect(local.getAttribute('aria-disabled')).not.toBe('true');
    await clickWithPointer(local, 'mouse');
    expect(scopeTrigger().textContent).toContain(dict['settings.mcp.grid.scope.local']);
    // When the person unchecks protection.
    const checked = protectRow();
    if (!checked) throw new Error('Missing checked Protect credentials');
    expect(checked.getAttribute('aria-pressed')).toBe('true');
    await act(async () => { checked.click(); });
    // Then the ordinary form keeps the name, transport and chosen scope, and the checkbox keeps focus.
    expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    const name = [...container.querySelectorAll<HTMLInputElement>('input')].find((entry) => entry.value === protectedDraft.name);
    expect(name?.getAttribute('dir')).toBe('ltr');
    expect(container.textContent).toContain(dict['settings.mcp.page.connection.kindLink']);
    expect(scopeTrigger().textContent).toContain(dict['settings.mcp.grid.scope.local']);
    expect(protectRow()?.getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(protectRow() ?? null);
  });
}

const availableStatus = (administration: 'shared' | 'separate') => Response.json({
  host: { supported: true }, service: { state: 'available', status: {
    administration, enforcement: { status: 'protected', findings: [] }, connections: [],
  } }, selections: { global: {}, project: {}, effective: {} }, selectionsError: null,
});

test('a new draft opens the ordinary form even while the previous one was protected', async () => {
  // Given a protected draft.
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
    const path = new URL(request.url).pathname;
    if (path === '/api/config/mcp-capabilities') return Response.json({ projectLocal: true });
    if (path === '/api/config' || path === '/api/config/mcp') return Response.json([]);
    if (path === '/api/protected-mcp/status') return availableStatus('separate');
    return Response.json(projectSettings);
  });
  useMcpConfigStore.setState({ selectedMcpName: protectedDraft.name, selectedProtectedId: null, mcpDraft: { ...protectedDraft, scope: 'local' } });
  await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
  const row = protectRow();
  if (!row) throw new Error('Missing Protect credentials');
  await act(async () => { row.click(); });
  expect(container.textContent).toContain(dict['settings.mcp.protectedPage.hiddenTools']);
  // When Settings search or Add server replaces the draft.
  await act(async () => { useMcpConfigStore.setState({ selectedMcpName: 'next-server', mcpDraft: { ...protectedDraft, name: 'next-server' } }); });
  // Then the new draft starts unprotected on its own name and scope.
  expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.hiddenTools']);
  expect(protectRow()?.getAttribute('aria-pressed')).toBe('false');
  expect([...container.querySelectorAll<HTMLInputElement>('input')].some((entry) => entry.value === 'next-server')).toBe(true);
  expect(scopeTrigger().textContent).toContain(dict['settings.mcp.grid.scope.user']);
});

test('another Settings project ends protection, and coming back does not restore it', async () => {
  // Given two projects and a protected draft in the first.
  fetchSpy.mockImplementation(async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
    const path = new URL(request.url).pathname;
    if (path === '/api/config/mcp-capabilities') return Response.json({ projectLocal: true });
    if (path === '/api/config' || path === '/api/config/mcp') return Response.json([]);
    if (path === '/api/protected-mcp/status') return availableStatus('separate');
    return Response.json(projectSettings);
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/project' }, { id: 'other', path: '/other' }], activeProjectId: 'project' });
  useMcpConfigStore.setState({ selectedMcpName: protectedDraft.name, selectedProtectedId: null, mcpDraft: protectedDraft });
  try {
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    const row = protectRow();
    if (!row) throw new Error('Missing Protect credentials');
    await act(async () => { row.click(); });
    expect(container.textContent).toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    // When Settings switches to the other project and back.
    await act(async () => { useUIStore.setState({ settingsProjectPath: '/other' }); });
    // Then the other project shows the ordinary form, and so does the first one again.
    expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    await act(async () => { useUIStore.setState({ settingsProjectPath: '/project' }); });
    expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    expect(protectRow()?.getAttribute('aria-pressed')).toBe('false');
  } finally {
    useUIStore.setState({ settingsProjectPath: null });
  }
});

for (const projectLocal of [true, false] as const) {
  test(`checking Protect credentials on Shared project moves the scope to ${projectLocal ? 'Local project' : 'Global'}`, async () => {
    // Given a Shared project draft and the host's local project support.
    let markCapabilityConsumed = () => {};
    const capabilityConsumed = new Promise<void>((resolve) => { markCapabilityConsumed = resolve; });
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/config/mcp-capabilities') {
        const response = Response.json({ projectLocal });
        const readJson = response.json.bind(response);
        spyOn(response, 'json').mockImplementation(async () => {
          const body: unknown = await readJson();
          markCapabilityConsumed();
          return body;
        });
        return response;
      }
      if (path === '/api/config') return Response.json([]);
      if (path === '/api/protected-mcp/status') return Response.json({
        host: { supported: true }, service: { state: 'available', status: {
          administration: 'separate', enforcement: { status: 'protected', findings: [] }, connections: [],
        } }, selections: { global: {}, project: {}, effective: {} }, selectionsError: null,
      });
      return Response.json(projectSettings);
    });
    useMcpConfigStore.setState({ selectedMcpName: protectedDraft.name, selectedProtectedId: null, mcpDraft: { ...protectedDraft, scope: 'project' } });
    await act(async () => { root.render(<I18nProvider><McpPage /></I18nProvider>); });
    await act(async () => { await capabilityConsumed; });
    expect(scopeTrigger().textContent).toContain(dict['settings.mcp.grid.scope.project']);
    const row = protectRow();
    if (!row) throw new Error('Missing Protect credentials');
    // When the person checks Protect credentials.
    await act(async () => { row.click(); });
    // Then the protected form starts on the nearest scope a protected server can use.
    expect(container.textContent).toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    expect(scopeTrigger().textContent).toContain(dict[projectLocal ? 'settings.mcp.grid.scope.local' : 'settings.mcp.grid.scope.user']);
  });
}

for (const ending of ['cancel', 'create'] as const) {
  test(`a protected ${ending} resets protection and scope before the next ordinary draft mounts`, async () => {
    // Given a Local project draft protected through the checkbox.
    let capabilityReads = 0;
    const definition = { name: protectedDraft.name, enabled: true, transport: 'http', http: { url: 'https://mcp.test', headers: {} }, policy: {} };
    const view = { id: 'pmcp_created_scope', name: definition.name, revision: 1, enabled: true, transport: 'http', secrets: {}, credential: 'none', editable: definition };
    fetchSpy.mockImplementation(async (input, init) => {
      const request = new Request(input instanceof Request ? input : new URL(String(input), browser.location.href), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/config/mcp-capabilities') { capabilityReads += 1; return Response.json({ projectLocal: true }); }
      if (path === '/api/config' || path === '/api/config/mcp') return Response.json([]);
      if (path === '/api/protected-mcp/status') return Response.json({
        host: { supported: true }, service: { state: 'available', status: {
          administration: 'separate', enforcement: { status: 'protected', findings: [] }, connections: [],
        } }, selections: { global: {}, project: {}, effective: {} }, selectionsError: null,
      });
      if (path.startsWith('/api/protected-mcp/connections')) return Response.json({ connection: view });
      return Response.json(projectSettings);
    });
    useMcpConfigStore.setState({ selectedMcpName: protectedDraft.name, selectedProtectedId: null, mcpDraft: { ...protectedDraft, scope: 'local' } });
    await act(async () => { root.render(<ThemeSystemProvider><I18nProvider><McpPage /></I18nProvider></ThemeSystemProvider>); });
    const row = protectRow();
    if (!row) throw new Error('Missing Protect credentials');
    await act(async () => { row.click(); });
    expect(scopeTrigger().textContent).toContain(dict['settings.mcp.grid.scope.local']);
    const action = (label: string) => {
      const target = [...container.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label);
      if (!target) throw new Error(`Missing action ${label}`);
      return target;
    };
    if (ending === 'create') {
      const url = container.querySelector<HTMLInputElement>('input[aria-label="URL"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!url || !setter) throw new Error('Missing protected URL');
      await act(async () => { setter.call(url, 'https://mcp.test'); url.dispatchEvent(new Event('input', { bubbles: true })); });
    }
    // When this protected draft ends and another server is added.
    await act(async () => { action(dict[ending === 'create' ? 'settings.common.actions.create' : 'settings.common.actions.cancel']).click(); });
    if (ending === 'create') await act(async () => { action(dict['settings.mcp.page.back']).click(); });
    const readsBeforeNextDraft = capabilityReads;
    const add = container.querySelector<HTMLButtonElement>('[data-settings-item="mcp.create"]');
    if (!add) throw new Error('Missing Add server card');
    await act(async () => { add.click(); });
    // Then an ordinary Global draft mounts with protection off, never the protected editor.
    expect(container.textContent).not.toContain(dict['settings.mcp.protectedPage.hiddenTools']);
    expect(protectRow()?.getAttribute('aria-pressed')).toBe('false');
    expect(scopeTrigger().textContent).toContain(dict['settings.mcp.grid.scope.user']);
    expect(capabilityReads).toBe(readsBeforeNextDraft);
  });
}
