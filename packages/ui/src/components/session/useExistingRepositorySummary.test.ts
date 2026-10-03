import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceControlRepositoryContext } from '@/lib/api/types';
import { useExistingRepositorySummary, type ExistingRepositorySummary } from './useExistingRepositorySummary';

const remote = (name: string, url: string) => ({
  name,
  fetch: { displayUrl: url, fingerprint: `${name}-fetch` },
  push: { displayUrl: url, fingerprint: `${name}-push` },
});

const context: SourceControlRepositoryContext = {
  repositoryId: 'repo_one',
  configRevision: 'config_one',
  bare: false,
  remotes: [remote('upstream', 'https://gitlab.com/team/repo.git'), remote('origin', 'git@github.com:team/repo.git')],
};

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

type Probe = {
  directory: string;
  repositoryContext: (directory: string) => Promise<SourceControlRepositoryContext>;
  getCurrentGitIdentity: (directory: string) => Promise<{ userName: string | null; userEmail: string | null } | null>;
  hasLocalIdentity: (directory: string) => Promise<boolean>;
};

// The probe renders no DOM nodes. This implements only React root setup.
const mount = async (overrides: Partial<Probe> = {}) => {
  class TestWindow extends EventTarget {
    HTMLIFrameElement = class {};
    __OPENCHAMBER_API_BASE_URL__ = 'https://runtime-a.example.com';
  }
  const runtimeWindow = new TestWindow();
  const document = Object.assign(new EventTarget(), { nodeType: 9, defaultView: runtimeWindow, activeElement: null });
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
  });
  Object.defineProperty(container, 'ownerDocument', { value: document });
  const globals: Array<[string, PropertyDescriptor]> = [
    ['window', { value: runtimeWindow, configurable: true }],
    ['document', { value: document, configurable: true }],
    ['IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true }],
  ];
  const previous = globals.map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, descriptor] of globals) Object.defineProperty(globalThis, key, descriptor);
  // SAFETY: The probe renders null, so React only uses the root setup members implemented above.
  const root = createRoot(container as Element);
  let summary: ExistingRepositorySummary | null = null;
  let input: Probe = {
    directory: '/repo',
    repositoryContext: async () => context,
    getCurrentGitIdentity: async () => ({ userName: 'Ada', userEmail: 'ada@example.com' }),
    hasLocalIdentity: async () => true,
    ...overrides,
  };
  const Component = () => {
    summary = useExistingRepositorySummary(
      input.directory,
      {
        sourceControl: { repositoryContext: input.repositoryContext },
        git: { getCurrentGitIdentity: input.getCurrentGitIdentity, hasLocalIdentity: input.hasLocalIdentity },
      },
      true,
    );
    return null;
  };
  const render = () => act(() => { root.render(React.createElement(Component)); });
  render();
  cleanups.push(() => {
    act(() => { root.unmount(); });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const settle = async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  };
  await settle();
  return {
    get summary() { return summary; },
    rerender: async (next: Partial<Probe>) => { input = { ...input, ...next }; render(); await settle(); },
  };
};

describe('useExistingRepositorySummary', () => {
  test('reports the remotes the repository already has and anchors on origin', async () => {
    const probe = await mount();
    expect(probe.summary?.remotes.map((entry) => entry.name)).toEqual(['upstream', 'origin']);
    expect(probe.summary?.primaryRemote?.name).toBe('origin');
    // The provider association follows the host, so an scp-like remote resolves too.
    expect(probe.summary?.primaryRemote?.host).toBe('github.com');
    expect(probe.summary?.author).toEqual({ userName: 'Ada', userEmail: 'ada@example.com' });
    expect(probe.summary?.authorIsLocal).toBe(true);
  });

  test('carries the authority a binding mutation needs, and which transports the URLs allow', async () => {
    const probe = await mount();
    expect(probe.summary?.repositoryId).toBe('repo_one');
    expect(probe.summary?.configRevision).toBe('config_one');
    // origin is scp-like, so it allows managed SSH and not managed HTTPS.
    expect(probe.summary?.primaryRemote?.https).toBe(false);
    expect(probe.summary?.primaryRemote?.ssh).toBe(true);
    expect(probe.summary?.remotes[0].name).toBe('upstream');
    expect(probe.summary?.remotes[0].https).toBe(true);
    expect(probe.summary?.remotes[0].ssh).toBe(false);
    expect(probe.summary?.primaryRemote?.fetch.fingerprint).toBe('origin-fetch');
    expect(probe.summary?.primaryRemote?.push.fingerprint).toBe('origin-push');
  });

  test('reports nothing for a directory that is not a repository', async () => {
    const probe = await mount({ repositoryContext: async () => { throw new Error('Not a repository'); } });
    expect(probe.summary).toBeNull();
  });

  test('reports a repository without remotes, with nothing to anchor a binding to', async () => {
    // A local-only repository still commits, so the add screen has to be able
    // to offer it an identity; it just has no remote to associate.
    const probe = await mount({ repositoryContext: async () => ({ ...context, remotes: [] }) });
    expect(probe.summary?.repositoryId).toBe('repo_one');
    expect(probe.summary?.remotes).toEqual([]);
    expect(probe.summary?.primaryRemote).toBeNull();
  });

  test('keeps a single remote as the anchor and survives an unreadable author', async () => {
    const probe = await mount({
      repositoryContext: async () => ({ ...context, remotes: [remote('mirror', 'https://gitlab.com/team/repo.git')] }),
      getCurrentGitIdentity: async () => { throw new Error('Failed to read identity'); },
      hasLocalIdentity: async () => false,
    });
    expect(probe.summary?.primaryRemote?.name).toBe('mirror');
    expect(probe.summary?.author).toBeNull();
    expect(probe.summary?.authorIsLocal).toBe(false);
  });

  test('never reports one directory as another', async () => {
    const probe = await mount();
    expect(probe.summary?.directory).toBe('/repo');
    await probe.rerender({ directory: '/other', repositoryContext: async () => { throw new Error('Not a repository'); } });
    expect(probe.summary).toBeNull();
  });
});
