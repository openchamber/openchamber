import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { ThemeSystemProvider } from './ThemeSystemContext';
import { useThemeSystem } from './useThemeSystem';
import type { ThemeContextValue } from './theme-system-context';
import { compactTheme } from '@/lib/theme/definition';
import { getDefaultTheme } from '@/lib/theme/themes';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { getThemePreferencesStorageKey, writeThemePreferencesForRuntime } from './theme-storage';

test('theme imports survive older reloads and yield to newer choices and runtime switches', async () => {
  const dom = new Window({ url: 'http://theme.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const reads: Array<(response: Response) => void> = [];
  const writes: Array<(response: Response) => void> = [];
  const deletes: Array<(response: Response) => void> = [];
  let notifyPost = () => {};
  let notifyDelete = () => {};
  const fetchResponse = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/api/config/themes/') && (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'DELETE') return new Promise((resolve) => { deletes.push(resolve); notifyDelete(); });
    if (url.endsWith('/api/config/themes')) {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      return new Promise((resolve) => {
        (method === 'POST' ? writes : reads).push(resolve);
        if (method === 'POST') notifyPost();
      });
    }
    return Promise.resolve(Response.json({}));
  };
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, Element: dom.Element, HTMLElement: dom.HTMLElement,
    Node: dom.Node, Event: dom.Event, CustomEvent: dom.CustomEvent,
    fetch: fetchResponse, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let context: ThemeContextValue | undefined;
  function Probe() {
    context = useThemeSystem();
    return <output>{context.currentTheme.metadata.id}</output>;
  }
  const current = () => {
    if (!context) throw new Error('Theme context has not mounted');
    return context;
  };
  const resolveNext = (queue: typeof reads, response: Response) => {
    const resolve = queue.shift();
    if (!resolve) throw new Error('Expected a pending theme request');
    resolve(response);
  };
  const imported = { ...getDefaultTheme(true), metadata: { ...getDefaultTheme(true).metadata, id: `imported-vscode-${'a'.repeat(24)}`, name: 'Fixture import' } };
  const beginImport = async (value = imported, activate = true) => {
    let result: ReturnType<ThemeContextValue['importTheme']> | undefined;
    const posted = new Promise<void>((resolve) => { notifyPost = resolve; });
    await act(async () => {
      result = current().importTheme(compactTheme(value), { activate });
      await posted;
    });
    if (!result) throw new Error('Import did not start');
    return { result };
  };
  try {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://theme.test', runtimeKey: 'theme-one' });
    await act(async () => root.render(<ThemeSystemProvider><Probe /></ThemeSystemProvider>));
    await act(async () => resolveNext(reads, Response.json({ themes: [] })));

    let oldReload = Promise.resolve();
    await act(async () => { oldReload = current().reloadCustomThemes(); });
    const { result: pendingImport } = await beginImport();
    await act(async () => {
      resolveNext(writes, Response.json({ theme: compactTheme(imported) }));
      await pendingImport;
    });
    expect(container.textContent).toBe(imported.metadata.id);
    await act(async () => { resolveNext(reads, Response.json({ themes: [] })); await oldReload; });
    expect(current().availableThemes.some((theme) => theme.metadata.id === imported.metadata.id)).toBe(true);

    const { result: second } = await beginImport();
    await act(async () => current().setTheme(getDefaultTheme(false).metadata.id));
    await act(async () => { resolveNext(writes, Response.json({ theme: compactTheme(imported) })); await second; });
    expect(container.textContent).toBe(getDefaultTheme(false).metadata.id);

    const newest = { ...imported, metadata: { ...imported.metadata, id: 't3-code-dark' } };
    const { result: batch } = await beginImport(newest, false);
    await act(async () => { resolveNext(writes, Response.json({ theme: compactTheme(newest) })); await batch; });
    expect(container.textContent).toBe(getDefaultTheme(false).metadata.id);
    expect(current().availableThemes.some((theme) => theme.metadata.id === newest.metadata.id)).toBe(true);
    const { result: earlierChoice } = await beginImport();
    const { result: latestChoice } = await beginImport(newest);
    await act(async () => { resolveNext(writes, Response.json({ theme: compactTheme(imported) })); await earlierChoice; });
    expect(container.textContent).toBe(getDefaultTheme(false).metadata.id);
    await act(async () => { resolveNext(writes, Response.json({ theme: compactTheme(newest) })); await latestChoice; });
    expect(container.textContent).toBe(newest.metadata.id);

    const deleteTheme = async () => {
      let result: Promise<string | void> = Promise.resolve();
      const posted = new Promise<void>((resolve) => { notifyDelete = resolve; });
      await act(async () => {
        result = current().deleteImportedTheme(newest.metadata.id).catch((error) => error instanceof Error ? error.message : String(error));
        await posted;
      });
      return { result };
    };
    const { result: failedDelete } = await deleteTheme();
    await act(async () => { resolveNext(deletes, new Response(null, { status: 500 })); expect(await failedDelete).toBe('delete'); });
    expect(container.textContent).toBe(newest.metadata.id);
    const { result: invalidDelete } = await deleteTheme();
    await act(async () => { resolveNext(deletes, Response.json({ success: false })); await invalidDelete; });
    expect(container.textContent).toBe(newest.metadata.id);
    let staleReload = Promise.resolve();
    await act(async () => { staleReload = current().reloadCustomThemes(); });
    const { result: deleted } = await deleteTheme();
    await act(async () => { resolveNext(deletes, Response.json({ success: true })); await deleted; });
    expect(container.textContent).toBe(getDefaultTheme(true).metadata.id);
    await act(async () => { resolveNext(reads, Response.json({ themes: [compactTheme(newest)] })); await staleReload; });
    expect(current().availableThemes.some((theme) => theme.metadata.id === newest.metadata.id)).toBe(false);

    const { result: failed } = await beginImport();
    const failedResult = failed.catch((error) => error instanceof Error ? error.message : String(error));
    await act(async () => { resolveNext(writes, new Response(null, { status: 503 })); expect(await failedResult).toBe('save'); });
    expect(current().availableThemes.some((theme) => theme.metadata.id === imported.metadata.id)).toBe(true);

    const { result: oldRuntimeImport } = await beginImport();
    const staleResult = oldRuntimeImport.catch((error) => error instanceof Error ? error.message : String(error));
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://other-theme.test', runtimeKey: 'theme-two' }));
    await act(async () => { resolveNext(writes, Response.json({ theme: compactTheme(imported) })); expect(await staleResult).toBe('connection'); });
    expect(current().availableThemes.some((theme) => theme.metadata.id === imported.metadata.id)).toBe(false);

    await act(async () => resolveNext(reads, Response.json({ themes: [] })));
    const fromAnotherWindow = { ...imported, metadata: { ...imported.metadata, id: 'imported-vscode-other-window' } };
    await act(async () => {
      writeThemePreferencesForRuntime('theme-two', { themeMode: 'dark', lightThemeId: getDefaultTheme(false).metadata.id, darkThemeId: fromAnotherWindow.metadata.id });
      dom.dispatchEvent(new dom.StorageEvent('storage', { key: getThemePreferencesStorageKey('theme-two'), storageArea: dom.localStorage }));
    });
    expect(reads.length).toBe(1);
    await act(async () => resolveNext(reads, Response.json({ themes: [compactTheme(fromAnotherWindow)] })));
    expect(container.textContent).toBe(fromAnotherWindow.metadata.id);
    expect(reads.length).toBe(0);

    const { result: beforeRoundTrip } = await beginImport();
    const roundTripResult = beforeRoundTrip.catch((error) => error instanceof Error ? error.message : String(error));
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://third-theme.test', runtimeKey: 'theme-three' }));
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'http://other-theme.test', runtimeKey: 'theme-two' }));
    await act(async () => { resolveNext(writes, Response.json({ theme: compactTheme(imported) })); expect(await roundTripResult).toBe('connection'); });
    expect(current().availableThemes.some((theme) => theme.metadata.id === imported.metadata.id)).toBe(false);
  } finally {
    await act(async () => {
      for (const resolve of reads.splice(0)) resolve(Response.json({ themes: [] }));
      root.unmount();
    });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
