import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { GitRemote, GitStatus } from '@/lib/api/types';

const status: GitStatus = { current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true };

const remote = (name: string, fetchUrl: string, pushUrl = fetchUrl): GitRemote => ({ name, fetchUrl, pushUrl });

test('the repository menu opens provider links and hides the entry elsewhere', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const opened: string[] = [];
  Object.defineProperty(dom, 'open', {
    configurable: true,
    writable: true,
    value: (url: string) => { opened.push(url); return null; },
  });

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { GitHeader } = await import('./GitHeader');
  const { useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const originalIdentities = useSourceControlAuthStore.getState().identities;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const baseProps = {
    directory: '/repo',
    status,
    localBranches: ['main'],
    remoteBranches: [],
    branchInfo: undefined,
    syncAction: null,
    onFetch: () => {},
    onPull: () => {},
    onSync: () => {},
    onPublish: () => {},
    onChooseSyncTargets: () => {},
    onRemoveRemote: () => {},
    removingRemoteName: null,
    onCheckoutBranch: () => {},
    onCreateBranch: async () => {},
    activeIdentityProfile: null,
    availableIdentities: [],
    onSelectIdentity: () => {},
    isApplyingIdentity: false,
    isWorktreeMode: false,
    onOpenHistory: () => {},
    onOpenGraph: () => {},
  };

  const render = (remotes: GitRemote[]) => act(async () => root.render(
    <I18nProvider>
      <GitHeader {...baseProps} remotes={remotes} />
    </I18nProvider>
  ));

  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Repository views"]');
    if (!trigger) throw new Error('Missing repository views trigger');
    await act(async () => { trigger.click(); });
  };
  const repositoryItem = (provider: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((entry) => entry.textContent === `View repository on ${provider}`);

  try {
    await render([remote('origin', 'git@github.com:me/project.git')]);
    await openMenu();
    const item = repositoryItem('GitHub');
    if (!item) throw new Error('Missing GitHub entry');
    expect(item.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { item.click(); });
    expect(opened).toEqual(['https://github.com/me/project']);
    expect(document.querySelector('[role="menu"]')).toBeNull();

    opened.length = 0;
    await render([remote('origin', 'git@gitlab.com:me/project.git')]);
    await openMenu();
    const gitlabItem = repositoryItem('GitLab');
    if (!gitlabItem) throw new Error('Missing GitLab entry');
    expect(repositoryItem('GitHub')).toBeUndefined();
    await act(async () => { gitlabItem.click(); });
    expect(opened).toEqual(['https://gitlab.com/me/project']);

    await render([remote('origin', 'git@code.example.com:group/sub/project.git')]);
    await act(async () => useSourceControlAuthStore.setState({ identities: [{ provider: 'gitlab', instance: 'https://code.example.com' }] }));
    await openMenu();
    const selfHostedItem = repositoryItem('GitLab');
    if (!selfHostedItem) throw new Error('Missing self-hosted GitLab entry');
    await act(async () => { selfHostedItem.click(); });
    expect(opened.at(-1)).toBe('https://code.example.com/group/sub/project');

    await render([remote('origin', 'https://example.com/team/project.git')]);
    await openMenu();
    expect(repositoryItem('GitHub')).toBeUndefined();
    expect(repositoryItem('GitLab')).toBeUndefined();
    expect(document.querySelector('[role="separator"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useSourceControlAuthStore.setState({ identities: originalIdentities });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
