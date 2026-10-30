import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import type { Root } from 'react-dom/client';
import type { Project } from '@/lib/opencode/model';
import type { DesktopSettings } from '@/lib/desktop';

const win = new Window({ url: 'http://localhost' });
win.localStorage.setItem('homeDirectory', '/home/test');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({ home: '/home/test', chatsRoot: '/chats' });
const globals = { window: win, document: win.document, navigator: win.navigator,
  HTMLElement: win.HTMLElement, Element: win.Element, Node: win.Node,
  CustomEvent: win.CustomEvent, localStorage: win.localStorage,
  MutationObserver: win.MutationObserver, getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true };
const previousGlobals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { OpenCodeProjectImport } = await import('./OpenCodeProjectImport');
const { I18nProvider } = await import('@/lib/i18n');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { parseSettingsDocument } = await import('@/lib/settings/registry');

// Keep the real dialog actions, import component, project store and settings
// queue. Only the runtime provider and overlay chrome are replaced.
const runtimeAPIs = { git: {}, sourceControl: {}, runtime: { isVSCode: false } };
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => runtimeAPIs }));
const passthrough = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
mock.module('@/components/ui/dialog', () => ({
  Dialog: passthrough, DialogContent: passthrough, DialogHeader: passthrough,
  DialogTitle: passthrough, DialogDescription: passthrough, DialogFooter: passthrough,
}));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: passthrough }));
const { DirectoryExplorerDialog } = await import('../DirectoryExplorerDialog');
const { useGitIdentitiesStore } = await import('@/stores/useGitIdentitiesStore');
const profiles = spyOn(useGitIdentitiesStore.getState(), 'loadProfiles').mockResolvedValue(true);
const globalIdentity = spyOn(useGitIdentitiesStore.getState(), 'loadGlobalIdentity').mockResolvedValue(true);
const defaultIdentity = spyOn(useGitIdentitiesStore.getState(), 'loadDefaultGitIdentityId').mockResolvedValue(true);
const directories = spyOn(opencodeClient, 'listLocalDirectory');

let root: Root;
let container: HTMLDivElement;
let runtimeNumber = 0;
let server: DesktopSettings;
let saves: DesktopSettings[];
let failSave = false;
let failLoad = false;
let pendingSave: Promise<void> | undefined;
const project = (worktree: string): Project => ({ id: worktree, worktree, sandboxes: [], time: { created: 1, updated: 1 } });
const catalog = spyOn(opencodeClient, 'listProjects');
const availability = spyOn(opencodeClient, 'getDirectoryAvailability');
const home = spyOn(opencodeClient, 'getFilesystemHomeInfo');
const icon = spyOn(useProjectsStore.getState(), 'discoverProjectIcon');
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const ImportDialog = () => {
  const [busy, setBusy] = React.useState(false);
  return <I18nProvider><OpenCodeProjectImport busy={busy} onBusyChange={setBusy} /></I18nProvider>;
};
const render = () => act(async () => { root.render(<ImportDialog />); });
const reopen = async () => { await act(async () => root.render(null)); await render(); await settle(); };
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 350)); });
};

beforeEach(async () => {
  server = { projects: [{ id: 'existing', path: '/existing', label: 'My project' }] };
  saves = [];
  failSave = false;
  failLoad = false;
  pendingSave = undefined;
  useProjectsStore.getState().synchronizeFromSettings(server);
  catalog.mockReset();
  catalog.mockResolvedValue([project('/new')]);
  availability.mockReset();
  availability.mockResolvedValue('available');
  home.mockResolvedValue({ home: '/home/test', chatsRoot: '/chats' });
  directories.mockResolvedValue([{ name: 'manual', path: '/manual', isDirectory: true, isFile: false }]);
  icon.mockResolvedValue({ ok: true });
  // Exercise the real settings queue and settings-synced event, with only HTTP
  // replaced. No settings or filesystem requests can reach the user's server.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.includes('/api/fs/home')) return Response.json({ home: '/home/test', chatsRoot: '/chats' });
    if (!request.url.includes('/api/config/settings')) return new Response(null, { status: 404 });
    if (request.method === 'PUT') {
      const changes = parseSettingsDocument(await request.json());
      if (!changes) throw new Error('Invalid settings fixture');
      saves.push(changes);
      await pendingSave;
      if (failSave) return new Response(null, { status: 500 });
      server = { ...server, ...changes };
    } else if (failLoad) return new Response(null, { status: 503 });
    return Response.json(server);
  };
  switchRuntimeEndpoint({ apiBaseUrl: `http://import-${++runtimeNumber}.test`, runtimeKey: `import-${runtimeNumber}` });
  // Allow the directory store's runtime-home save to settle before the import.
  await new Promise((resolve) => setTimeout(resolve, 350));
  saves = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
afterAll(() => {
  catalog.mockRestore(); availability.mockRestore(); home.mockRestore(); icon.mockRestore();
  directories.mockRestore(); profiles.mockRestore(); globalIdentity.mockRestore(); defaultIdentity.mockRestore();
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  void win.happyDOM.close();
});

test('offers only new canonical folders with confirmed availability', async () => {
  catalog.mockResolvedValue([
    project('/'), project('C:/'), project('/existing'), project('/new'), project('/new/'),
    project('/missing'), project('/unknown'), project('/chats/one'),
    { ...project('c:\\Repo'), sandboxes: ['C:/worktree'] },
  ]);
  availability.mockImplementation(async (path) => path === '/missing' ? 'missing' : path === '/unknown' ? 'unknown' : 'available');
  await render(); await settle();
  expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['/new', 'C:/Repo']);
  expect(availability.mock.calls.map(([path]) => path)).toEqual(['/new', '/missing', '/unknown', 'C:/Repo']);
  expect(saves).toEqual([]);
});

test('imports and retires in one save, preserving configured names and order', async () => {
  await render(); await settle();
  await click('Add projects from OpenCode');
  expect(saves).toHaveLength(1);
  expect(saves[0].openCodeProjectImportCompleted).toBe(true);
  expect(server.projects?.map((entry) => entry.path)).toEqual(['/existing', '/new']);
  expect(server.projects?.[0].label).toBe('My project');
  expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/existing', '/new']);
  expect(container.querySelector('section')).toBeNull();
  catalog.mockReset();
  await reopen();
  expect(catalog.mock.calls).toHaveLength(0);
});

test('quick add cannot overwrite an import waiting in the settings queue', async () => {
  await act(async () => { root.render(<I18nProvider><DirectoryExplorerDialog open onOpenChange={() => {}} /></I18nProvider>); });
  await settle();
  const quickAdd = container.querySelector<HTMLButtonElement>('button[title="Add"]');
  if (!quickAdd) throw new Error('Missing quick-add button');
  expect(quickAdd.disabled).toBe(false);
  const importButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Add projects from OpenCode');
  if (!importButton) throw new Error('Missing import button');

  await act(async () => { importButton.click(); });
  // No HTTP write has started: both actions would still share one debounce.
  expect(saves).toEqual([]);
  await act(async () => { quickAdd.click(); });
  expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/existing']);
  expect(quickAdd.disabled).toBe(true);

  // Flush the real queue through its lifecycle boundary without waiting for
  // the debounce timer, then verify the persisted list and retirement marker.
  await act(async () => { win.dispatchEvent(new win.Event('pagehide')); });
  await settle();
  expect(saves).toHaveLength(1);
  expect(server.projects?.map((entry) => entry.path)).toEqual(['/existing', '/new']);
  expect(server.openCodeProjectImportCompleted).toBe(true);
  expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/existing', '/new']);
  expect(quickAdd.disabled).toBe(false);
});

for (const failure of [false, true]) {
  test(`reopening keeps quick add blocked until the import PUT ${failure ? 'fails' : 'succeeds'}`, async () => {
    const renderDialog = (open: boolean) => act(async () => {
      root.render(<I18nProvider><DirectoryExplorerDialog open={open} onOpenChange={() => {}} /></I18nProvider>);
    });
    await renderDialog(true);
    await settle();
    let releaseSave!: () => void;
    pendingSave = new Promise<void>((resolve) => { releaseSave = resolve; });
    failSave = failure;
    try {
      const importButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Add projects from OpenCode');
      if (!importButton) throw new Error('Missing import button');
      await act(async () => { importButton.click(); win.dispatchEvent(new win.Event('pagehide')); });
      await settle();
      expect(saves).toHaveLength(1);

      // Exercise the controlled close/reopen transition without replacing the
      // dialog owner. The import child unmounts while its HTTP write is pending.
      await renderDialog(false);
      await renderDialog(true);
      await settle();
      const quickAdd = container.querySelector<HTMLButtonElement>('button[title="Add"]');
      if (!quickAdd) throw new Error('Missing quick-add button');
      expect(quickAdd.disabled).toBe(true);
      await act(async () => { quickAdd.click(); });
      expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/existing']);
    } finally {
      await act(async () => { releaseSave(); });
      await settle();
    }
    expect(container.querySelector<HTMLButtonElement>('button[title="Add"]')?.disabled).toBe(false);
    expect(saves).toHaveLength(1);
    expect(server.projects?.map((entry) => entry.path)).toEqual(failure ? ['/existing'] : ['/existing', '/new']);
    expect(server.openCodeProjectImportCompleted).toBe(failure ? undefined : true);
    expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(server.projects?.map((entry) => entry.path));
  });
}

test('explicit dismissal persists across openings without adding projects', async () => {
  await render(); await settle();
  await click("Don't suggest again");
  expect(saves).toEqual([{ openCodeProjectImportCompleted: true }]);
  expect(server.projects).toHaveLength(1);
  catalog.mockReset();
  await reopen();
  expect(container.querySelector('section')).toBeNull();
  expect(catalog.mock.calls).toHaveLength(0);
});

test('closing without dismissal and an empty catalog do not retire the suggestion', async () => {
  catalog.mockResolvedValue([]);
  await render(); await settle();
  expect(container.querySelector('section')).toBeNull();
  catalog.mockResolvedValue([project('/new')]);
  await reopen();
  expect(container.querySelector('section')).not.toBeNull();
  await reopen();
  expect(container.querySelector('section')).not.toBeNull();
  expect(saves).toEqual([]);
});

test('failed settings and catalog reads can be retried by reopening', async () => {
  failLoad = true;
  await render(); await settle();
  expect(catalog.mock.calls).toHaveLength(0);
  failLoad = false;
  catalog.mockRejectedValue(new Error('offline'));
  await reopen();
  expect(container.querySelector('section')).toBeNull();
  catalog.mockResolvedValue([project('/new')]);
  await reopen();
  expect(container.querySelector('section')).not.toBeNull();
  expect(saves).toEqual([]);
});

test('failed import leaves projects intact and offers retry', async () => {
  await render(); await settle();
  failSave = true;
  await click('Add projects from OpenCode');
  expect(server.openCodeProjectImportCompleted).toBeUndefined();
  expect(useProjectsStore.getState().projects.map((entry) => entry.path)).toEqual(['/existing']);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Try again');
  failSave = false;
  await click('Add projects from OpenCode');
  expect(server.projects?.map((entry) => entry.path)).toEqual(['/existing', '/new']);
  expect(container.querySelector('section')).toBeNull();
});

test('failed dismissal stays visible and can be retried', async () => {
  await render(); await settle();
  failSave = true;
  await click("Don't suggest again");
  expect(container.querySelector('section')).not.toBeNull();
  expect(server.openCodeProjectImportCompleted).toBeUndefined();
  failSave = false;
  await click("Don't suggest again");
  expect(server.openCodeProjectImportCompleted).toBe(true);
});

test('late catalog results cannot offer paths from a previous server', async () => {
  let resolve!: (projects: Project[]) => void;
  catalog.mockReturnValue(new Promise((done) => { resolve = done; }));
  await render(); await settle();
  switchRuntimeEndpoint({ apiBaseUrl: 'http://other.test', runtimeKey: 'other' });
  await act(async () => { resolve([project('/old-server')]); });
  expect(container.querySelector('section')).toBeNull();
  expect(availability.mock.calls).toHaveLength(0);
  expect(saves).toEqual([]);
});
