import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { invalidateSettingsCache } from '@/lib/persistence';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';

const workIdentity = {
  id: 'work',
  name: 'Work GitHub',
  userName: 'Test User',
  userEmail: 'test@example.com',
  transport: 'ssh' as const,
  sshCredentialId: 'work-key',
};

// Clones exactly like the default Git setup, so the picker does not offer it.
const plainIdentity = {
  id: 'plain',
  name: 'Plain Identity',
  userName: 'Test User',
  userEmail: 'test@example.com',
  transport: 'system' as const,
};

describe('AddCatalogDialog Git identity', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  let restoreFetch = () => {};
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const globals = new Map<string, PropertyDescriptor | undefined>();
  let catalogs: Array<{ id: string; label: string; source: string; subpath?: string; gitIdentityId?: string }> = [];
  let defaultGitIdentityId: string | null = 'work';

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      HTMLInputElement: dom.HTMLInputElement,
      DocumentFragment: dom.DocumentFragment, MutationObserver: dom.MutationObserver,
      ResizeObserver: dom.ResizeObserver, MouseEvent: dom.MouseEvent,
      PointerEvent: dom.PointerEvent, Event: dom.Event, CustomEvent: dom.CustomEvent,
      getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    requests.length = 0;
    catalogs = [];
    defaultGitIdentityId = 'work';
    invalidateSettingsCache();
    registerRuntimeAPIs(null);
    useGitIdentitiesStore.setState({ profiles: [], globalIdentity: null, defaultGitIdentityId: null });
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: url.pathname, method, body });
      if (url.pathname === '/api/git/identities') return Response.json([workIdentity, plainIdentity]);
      if (url.pathname === '/api/git/global-identity') return Response.json({ userName: null, userEmail: null });
      if (url.pathname === '/api/config/settings' && method === 'GET') {
        return Response.json({ defaultGitIdentityId, skillCatalogs: catalogs });
      }
      if (url.pathname === '/api/config/settings' && method !== 'GET') return Response.json({ success: true });
      if (url.pathname === '/api/config/skills/scan') {
        return Response.json({ ok: true, items: [{ skillName: 'private-skill' }] });
      }
      if (url.pathname === '/api/config/skills/catalog') return Response.json({ ok: true, sources: [], itemsBySource: {} });
      if (url.pathname === '/api/config/skills/catalog/source') return Response.json({ ok: true, items: [] });
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    restoreFetch = () => fetch.mockRestore();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    const mountedRoot = root;
    if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
    root = undefined;
    restoreFetch();
    await dom.happyDOM.close();
    for (const [key, value] of globals) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const render = async (catalogId?: string) => {
    const { createRoot } = await import('react-dom/client');
    const { AddCatalogDialog } = await import('./AddCatalogDialog');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mountedRoot = createRoot(container);
    root = mountedRoot;
    await act(async () => {
      mountedRoot.render(
        <I18nProvider>
          <TooltipProvider>
            <AddCatalogDialog open onOpenChange={() => {}} catalogId={catalogId} />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
  };

  const input = (placeholder: string) => {
    const result = [...document.querySelectorAll('input')].find((entry) => entry.placeholder === placeholder);
    if (!result) throw new Error(`Missing input: ${placeholder}`);
    return result;
  };

  const button = (text: string) => {
    const result = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === text);
    if (!result) throw new Error(`Missing button: ${text}`);
    return result;
  };

  const enter = async (target: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  test('shows configured identities without binding the default to a new catalog', async () => {
    await render();

    expect(document.body.textContent).toContain('Git identity');
    expect(button('Default Git setup')).toBeTruthy();
    await act(async () => { button('Default Git setup').click(); });
    expect(document.body.textContent).toContain('Work GitHub');
    expect(document.body.textContent).toContain('Signs in with its SSH key');
    expect(document.body.textContent).not.toContain('Plain Identity');
    expect(document.body.textContent).not.toContain('System identity');
  });

  test('does not send a Git identity for a new catalog even when a default exists', async () => {
    await render();
    await enter(input('e.g. Team Skills'), 'Private skills');
    await enter(input('owner/repo or git@github.com:owner/repo.git'), 'git@github.com:owner/private-skills.git');
    await act(async () => { button('Scan').click(); });

    const scanRequest = requests.find((request) => request.path === '/api/config/skills/scan');
    expect(scanRequest?.body).toEqual({ source: 'git@github.com:owner/private-skills.git' });
  });

  test('can scan a public catalog without sending a Git identity', async () => {
    defaultGitIdentityId = null;
    await render();
    await enter(input('owner/repo or git@github.com:owner/repo.git'), 'owner/public');
    expect(button('Default Git setup')).toBeTruthy();
    await act(async () => { button('Scan').click(); });

    expect(requests.find((request) => request.path === '/api/config/skills/scan')?.body).toEqual({ source: 'owner/public' });
  });

  test('loads a custom catalog for editing without changing its identity', async () => {
    catalogs = [{ id: 'custom:team', label: 'Team skills', source: 'owner/team', subpath: 'skills' }];
    await render('custom:team');

    expect(input('e.g. Team Skills').value).toBe('Team skills');
    expect(input('owner/repo or git@github.com:owner/repo.git').value).toBe('owner/team');
    expect(button('Default Git setup')).toBeTruthy();
  });

  test('exposes an unavailable saved identity for explicit replacement', async () => {
    catalogs = [{ id: 'custom:team', label: 'Team skills', source: 'owner/team', gitIdentityId: 'missing-profile' }];
    await render('custom:team');

    expect(button('missing-profile')).toBeTruthy();
    await enter(input('e.g. Team Skills'), 'Updated team skills');
    expect(button('Save').hasAttribute('disabled')).toBe(false);
  });

  test('saves edited catalog fields in place', async () => {
    catalogs = [{ id: 'custom:team', label: 'Team skills', source: 'owner/team', subpath: 'skills' }];
    await render('custom:team');
    await enter(input('e.g. Team Skills'), 'Updated team skills');
    await act(async () => { button('Save').click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

    const writes = requests.filter((request) => request.path === '/api/config/settings' && request.method !== 'GET');
    expect(writes.some((request) => JSON.stringify(request.body).includes('Updated team skills'))).toBe(true);
  });

  test('requires a scan before saving a changed catalog repository', async () => {
    catalogs = [{ id: 'custom:team', label: 'Team skills', source: 'owner/team' }];
    await render('custom:team');
    await enter(input('owner/repo or git@github.com:owner/repo.git'), 'owner/new-team');
    expect(button('Save').hasAttribute('disabled')).toBe(true);

    await act(async () => { button('Scan').click(); });
    expect(button('Save').hasAttribute('disabled')).toBe(false);
  });

  test('selects installed skills and offers bulk deletion separately from installation', async () => {
    const sourceId = 'custom:team';
    const item = (skillName: string, installed: boolean) => ({
      sourceId, repoSource: 'owner/team', skillDir: skillName, skillName,
      installable: true, installed: { isInstalled: installed, scope: 'user' as const },
    });
    const store = useSkillsCatalogStore.getState();
    useSkillsCatalogStore.setState({
      sources: [{ id: sourceId, label: 'Team', source: 'owner/team' }],
      selectedSourceId: sourceId,
      itemsBySource: { [sourceId]: [item('installed-one', true), item('installed-two', true), item('new-skill', false)] },
      loadedSourceIds: { [sourceId]: true },
      loadCatalog: async () => true,
      loadSource: async () => true,
    });
    try {
      const { createRoot } = await import('react-dom/client');
      const { SkillsCatalogPage } = await import('./SkillsCatalogPage');
      const { I18nProvider } = await import('@/lib/i18n');
      const { TooltipProvider } = await import('@/components/ui/tooltip');
      root = createRoot(container);
      await act(async () => {
        root?.render(<I18nProvider><TooltipProvider>
          <SkillsCatalogPage mode="external" onModeChange={() => {}} showModeTabs={false} />
        </TooltipProvider></I18nProvider>);
      });
      const boxes = [...document.querySelectorAll('[role="checkbox"]')];
      expect(boxes.length).toBe(4);
      expect(boxes[1].hasAttribute('disabled')).toBe(false);
      await act(async () => {
        if (boxes[0] instanceof HTMLElement) boxes[0].click();
      });
      expect(boxes[1].getAttribute('aria-checked')).toBe('true');
      expect(boxes[2].getAttribute('aria-checked')).toBe('true');
      expect(boxes[3].getAttribute('aria-checked')).toBe('true');
      expect(button('Install selected')).toBeTruthy();
      expect(button('Delete')).toBeTruthy();
      await act(async () => { button('Delete').click(); });
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('installed-one, installed-two');
    } finally {
      await act(async () => {
        root?.unmount();
        root = undefined;
        useSkillsCatalogStore.setState(store);
      });
    }
  });

});
