import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { RepositoryIssueReference, RepositoryReferenceDetail, RuntimeAPIs, SourceControlBindingRead } from '@/lib/api/types';

const dom = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
  MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

let discovery = deferred<Response>();
const scans: string[] = [];
globalThis.fetch = Object.assign((input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  if (url.pathname === '/api/fs/git-dirs') {
    scans.push(url.searchParams.get('path') ?? '');
    return discovery.promise;
  }
  return new Promise<Response>(() => {});
}, globalThis.fetch);

const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api/index');
const { useGitStore } = await import('@/stores/useGitStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
const { repositoryBindingOwner } = await import('@/lib/source-control/repository-binding');
const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
const { useBoardRepository, useLinkRepository } = await import('./boardRepository');

const ROOT = '/work';
const CHILD = '/work/sdk';
const LINK = 'https://github.com/acme/sdk/issues/12';
const binding = (directory: string): SourceControlBindingRead => {
  const endpoint = { displayUrl: `https://github.com/acme/${directory === ROOT ? 'root' : 'sdk'}.git`, fingerprint: directory };
  return {
    status: 'bound', revision: 1,
    repository: { repositoryId: directory, configRevision: '1', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] },
    binding: {
      repositoryId: directory, configRevision: '1', revision: 1, state: 'bound', remotes: [], auxiliary: [],
      providers: [{ provider: 'github', instance: 'github.com', accountId: 'account', primaryRemote: 'origin', readiness: 'ready', endpoint }],
    },
  };
};

let renderer: Root;
let host: HTMLDivElement;
let childBinding = deferred<SourceControlBindingRead>();
let current: ReturnType<typeof useLinkRepository>;
const base = createWebAPIs();
const apis = {
  ...base,
  git: {
    ...base.git,
    checkIsGitRepository: async () => true,
    getGitStatus: async () => ({ current: 'main', tracking: null, ahead: 0, behind: 0, files: [], isClean: true }),
  },
  sourceControl: {
    ...base.sourceControl,
    repositoryBinding: async (directory: string) => directory === ROOT ? binding(ROOT) : childBinding.promise,
  },
};
function Harness({ url = LINK, root = ROOT }: { url?: string; root?: string }) {
  current = useLinkRepository(root, url);
  return null;
}
const render = (node: React.ReactNode) => act(async () => {
  renderer.render(<RuntimeAPIContext.Provider value={apis}>{node}</RuntimeAPIContext.Provider>);
});
const discovered = () => Response.json({ repositories: [{ path: CHILD }] });

beforeEach(() => {
  discovery = deferred<Response>();
  childBinding = deferred<SourceControlBindingRead>();
  scans.length = 0;
  useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  repositoryBindingOwner.reset();
  useDirectoryStore.setState({ homeDirectory: '/home/me' });
  const descriptor = githubLikeDescriptor();
  descriptor.features.referenceSearch = true;
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  host = document.createElement('div');
  document.body.append(host);
  renderer = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    renderer.unmount();
    discovery.resolve(Response.json({ repositories: [] }));
    childBinding.resolve(binding(CHILD));
  });
  host.remove();
});

test('a cold scan waits before resolving a submodule link, then waits for its binding', async () => {
  await render(<Harness />);
  expect(scans).toEqual([ROOT]);
  expect(current.status).toBe('pending');
  await act(async () => { discovery.resolve(discovered()); });
  expect(current.status).toBe('pending');
  await act(async () => { childBinding.resolve(binding(CHILD)); });
  expect(current).toMatchObject({ status: 'ready', directory: CHILD });
});

test('warm discovery still waits for cold candidate bindings', async () => {
  useGitStore.setState({ nestedReposByRoot: new Map([[ROOT, [CHILD]]]) });
  await render(<Harness />);
  expect(current.status).toBe('pending');
  await act(async () => { childBinding.resolve(binding(CHILD)); });
  expect(current).toMatchObject({ status: 'ready', directory: CHILD });
});

test('the root opens its own link without waiting for discovery', async () => {
  await render(<Harness url="https://github.com/acme/root/issues/12" />);
  expect(current).toMatchObject({ status: 'ready', directory: ROOT });
  expect(useGitStore.getState().nestedReposByRoot.get(ROOT)).toBeUndefined();
});

test('a failed scan stays retryable and never resolves an unknown link to the root', async () => {
  useGitStore.setState({ nestedReposByRoot: new Map([[ROOT, null]]) });
  await render(<Harness />);
  expect(current.status).toBe('failed');
  await act(async () => { current.retry(); });
  expect(scans).toEqual([ROOT]);
  await act(async () => { discovery.resolve(discovered()); });
  await act(async () => { childBinding.resolve(binding(CHILD)); });
  expect(current).toMatchObject({ status: 'ready', directory: CHILD });
});

for (const cached of [false, true]) {
  test(`home is never scanned or offered nested repositories, cached discovery: ${cached}`, async () => {
    useDirectoryStore.setState({ homeDirectory: ROOT });
    if (cached) useGitStore.setState({ nestedReposByRoot: new Map([[ROOT, [CHILD]]]) });
    let board: ReturnType<typeof useBoardRepository>;
    function Home() {
      board = useBoardRepository(ROOT, { path: null, all: undefined });
      current = useLinkRepository(ROOT, LINK);
      return null;
    }
    await render(<Home />);
    expect(board!.repositories).toEqual([ROOT]);
    expect(current).toMatchObject({ status: 'ready', directory: ROOT });
    await act(async () => { board!.retry(); current.retry(); });
    expect(scans).toEqual([]);
  });
}

test('a cold link survives a remembered submodule resolving after slow discovery and retry', async () => {
  const effectiveDirectory = await import('@/hooks/useEffectiveDirectory');
  mock.module('@/hooks/useEffectiveDirectory', () => ({ ...effectiveDirectory, useEffectiveDirectory: () => ROOT }));
  const sync = await import('@/sync/sync-context');
  mock.module('@/sync/sync-context', () => ({ ...sync, useSession: () => undefined }));
  const { MobileSourceBoard } = await import('./SourceBoardView');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { useSourceBoardStore } = await import('@/stores/useSourceBoardStore');
  const requests: string[] = [];
  const external: string[] = [];
  const originalOpen = window.open;
  window.open = (url) => { external.push(String(url)); return null; };
  useProjectsStore.setState({ projects: [{ id: 'project', path: ROOT }], activeProjectId: 'project' });
  useSourceBoardStore.getState().update({ repositoryByProject: { project: CHILD }, allRepositoriesByProject: { project: false } });
  useSourceBoardStore.getState().focusRepositoryItem('project', 'issue', LINK);
  const runtime: RuntimeAPIs = {
    ...apis,
    sourceControl: {
      ...apis.sourceControl,
      references: async (context, options) => {
        if (options.query) requests.push(context.directory);
        return {
          connected: true, repo: { owner: 'acme', repo: context.directory === ROOT ? 'root' : 'sdk', source: 'origin', url: 'https://github.com/acme/sdk' },
          cursor: null, hasMore: false, total: context.directory === CHILD && options.query ? 1 : 0,
          items: context.directory === CHILD && options.query ? [{
            kind: 'issue' as const, provider: 'github', number: 12, title: 'Submodule issue', url: LINK,
            body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null,
            labels: [], commentCount: 0, sourceRepo: { owner: 'acme', repo: 'sdk', source: 'origin' as const },
            state: 'open' as const,
          }] : [],
        };
      },
    },
  };
  try {
    await act(async () => {
      renderer.render(<I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>
        <MobileSourceBoard onLeave={() => {}} onClose={() => {}} />
      </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider>);
    });
    expect(requests).toEqual([]);
    expect(external).toEqual([]);
    await act(async () => { useGitStore.setState({ nestedReposByRoot: new Map([[ROOT, null]]) }); });
    expect(host.textContent).toContain('Could not scan for Git repositories');
    expect(external).toEqual([]);
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    expect(scans).toEqual([ROOT]);
    await act(async () => { discovery.resolve(discovered()); });
    expect(requests).toEqual([]);
    await act(async () => { childBinding.resolve(binding(CHILD)); });
    expect(requests).toEqual([CHILD]);
    expect(external).toEqual([]);
    expect(host.textContent).toContain('Submodule issue');
    expect(useSourceBoardStore.getState().repositoryFocus).toBeNull();
    await act(async () => { useSourceBoardStore.getState().focusRepositoryItem('project', 'issue', LINK); });
    expect(useSourceBoardStore.getState().repositoryFocus).toBeNull();
    expect(host.textContent).toContain('Submodule issue');
  } finally {
    window.open = originalOpen;
  }
});

test('a board without a pinned link can retry discovery while listing the root', async () => {
  const { MobileSourceBoard } = await import('./SourceBoardView');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { useSourceBoardStore } = await import('@/stores/useSourceBoardStore');
  useProjectsStore.setState({ projects: [{ id: 'project', path: ROOT }], activeProjectId: 'project' });
  useSourceBoardStore.getState().clearRepositoryFocus();
  useSourceBoardStore.getState().update({ projectId: 'project', tab: 'repository', repositoryByProject: { project: ROOT } });
  useGitStore.setState({ nestedReposByRoot: new Map([[ROOT, null]]) });
  const reads: string[] = [];
  const runtime: RuntimeAPIs = { ...apis, sourceControl: { ...apis.sourceControl,
    repositoryBinding: async (directory) => {
      const read = binding(directory);
      if (read.binding) read.binding.providers = read.binding.providers.map((provider) => ({ ...provider, accountId: 'ordinary-board' }));
      return read;
    },
    references: async (context) => {
    reads.push(context.directory);
    return { connected: true, repo: { owner: 'acme', repo: 'root', source: 'origin', url: 'https://github.com/acme/root' }, items: [], cursor: null, hasMore: false, total: 0 };
  } } };
  await act(async () => {
    renderer.render(<I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>
      <MobileSourceBoard onLeave={() => {}} onClose={() => {}} />
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider>);
  });
  expect(reads).toContain(ROOT);
  expect(host.textContent).toContain('Could not scan for Git repositories');
  const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry');
  expect(retry).toBeDefined();
  await act(async () => { retry!.click(); });
  expect(scans).toEqual([ROOT]);
  await act(async () => { discovery.resolve(discovered()); });
  expect(host.textContent).not.toContain('Could not scan for Git repositories');
});

test('a board discovery failure keeps the root readable and exposes a retry', async () => {
  useGitStore.setState({ nestedReposByRoot: new Map([[ROOT, null]]) });
  let board: ReturnType<typeof useBoardRepository>;
  function Board() {
    board = useBoardRepository(ROOT, { path: null, all: undefined });
    return null;
  }
  await render(<Board />);
  expect(board!).toMatchObject({ status: 'ready', directory: ROOT, discoveryFailed: true });
  await act(async () => { board!.retry(); });
  expect(scans).toEqual([ROOT]);
  await act(async () => { discovery.resolve(discovered()); });
  expect(board!).toMatchObject({ status: 'ready', directory: ROOT, discoveryFailed: false, choosable: true });
});

const writeIssue = (number: number, url: string, title: string): RepositoryIssueReference => ({
  kind: 'issue', provider: 'github', number, title, url,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 1,
  sourceRepo: { owner: 'acme', repo: 'root', source: 'origin' }, state: 'open',
});

const writeDetail = (number: number): RepositoryReferenceDetail => ({
  number, commentTotal: 1, pull: null,
  comments: [{
    id: 'comment-1', author: { login: 'ada' }, body: 'Is it cached?', createdAt: null,
    url: `https://github.com/acme/root/issues/${number}#issuecomment-1`,
    canUpdate: true, canDelete: true, path: null, line: null, review: null,
  }],
  assignees: [{ id: 'ada-id', login: 'ada' }],
});

/** Pins a link on the board and lists it only through the read its context names. */
const showWriteControls = async (options: { link: string; item: RepositoryIssueReference; through: 'linked' | 'own' }) => {
  const effectiveDirectory = await import('@/hooks/useEffectiveDirectory');
  mock.module('@/hooks/useEffectiveDirectory', () => ({ ...effectiveDirectory, useEffectiveDirectory: () => ROOT }));
  const sync = await import('@/sync/sync-context');
  mock.module('@/sync/sync-context', () => ({ ...sync, useSession: () => undefined }));
  const writeDescriptor = githubLikeDescriptor();
  writeDescriptor.features = { ...writeDescriptor.features, referenceSearch: true, referenceDetail: true };
  const writeState = { ordered: [writeDescriptor], byId: new Map([[writeDescriptor.id, writeDescriptor]]), status: 'ready' as const, holdsList: true };
  useSourceControlProviderRegistry.setState(writeState);
  Object.assign(useSourceControlProviderRegistry.getInitialState(), writeState);
  const { MobileSourceBoard } = await import('./SourceBoardView');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
  const { useProjectsStore } = await import('@/stores/useProjectsStore');
  const { useSourceBoardStore } = await import('@/stores/useSourceBoardStore');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  // The board reads its items through a context the auth store knows is usable.
  useSourceControlAuthStore.setState({
    entries: {
      [getSourceControlAuthKey({ provider: 'github', instance: 'github.com' })]: {
        hasChecked: true, isLoading: false,
        status: {
          provider: 'github', instance: 'github.com', status: 'connected', connected: true,
          user: { provider: 'github', instance: 'github.com', id: '7', username: 'ada' },
          accounts: [{
            id: 'account', credentialId: 'account', credentialRevision: 1,
            providerUserId: 'github.com#7', providerUserStatus: 'available',
            user: { provider: 'github', instance: 'github.com', id: '7', username: 'ada' },
            current: true, source: 'pat', status: 'valid',
          }],
        },
      },
    },
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: ROOT }], activeProjectId: 'project' });
  useSourceBoardStore.getState().update({
    projectId: 'project', tab: 'repository', repositoryByProject: { project: ROOT }, allRepositoriesByProject: { project: false },
  });
  useSourceBoardStore.getState().focusRepositoryItem('project', 'issue', options.link);
  useGitStore.setState({ nestedReposByRoot: new Map([[ROOT, null]]) });
  const detail = writeDetail(options.item.number);
  const listed = (context: { linked?: boolean }) => (options.through === 'linked' ? context.linked === true : context.linked !== true);
  const runtime: RuntimeAPIs = {
    ...apis,
    sourceControl: {
      ...apis.sourceControl,
      repositoryBinding: async () => binding(ROOT),
      references: async (context, query) => ({
        connected: true as const,
        repo: { owner: 'acme', repo: 'root', source: 'origin' as const, url: 'https://github.com/acme/root' },
        items: query.query === options.link && listed(context) ? [options.item] : [],
        cursor: null, hasMore: false, total: query.query === options.link && listed(context) ? 1 : 0,
      }),
      referenceDetail: async (_context, ref) => ({ connected: true as const, detail: { ...detail, number: ref.number } }),
      referenceReviewers: async () => [{ id: 'ada-id', login: 'ada' }, { id: 'grace-id', login: 'grace' }],
    },
  };
  await act(async () => {
    renderer.render(
      <I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>
        <MobileSourceBoard onLeave={() => {}} onClose={() => {}} />
      </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider>,
    );
  });
  for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
};

const writeButton = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

test('a linked item on the board offers no comment or assignee writes', async () => {
  await showWriteControls({ link: 'https://github.com/acme/root/issues/41', item: writeIssue(41, 'https://github.com/acme/root/issues/41', 'Outside the fork'), through: 'linked' });
  expect(host.textContent).toContain('Outside the fork');
  expect(writeButton('Comment actions')).toBeNull();
  expect(writeButton('Edit assignees')).toBeNull();
});

test('an item of the project itself still offers both writes', async () => {
  await showWriteControls({
    link: 'https://github.com/acme/root/issues/42',
    item: writeIssue(42, 'https://github.com/acme/root/issues/42', 'Inside the project'),
    through: 'own',
  });
  expect(host.textContent).toContain('Inside the project');
  expect(writeButton('Comment actions')).not.toBeNull();
  expect(writeButton('Edit assignees')).not.toBeNull();
});
