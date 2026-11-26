import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';

import type {
  RepositoryChangeRequestReference,
  RuntimeAPIs,
  SourceControlCapabilities,
  SourceControlReadContext,
} from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  PointerEvent: browser.PointerEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const createSdk = () => OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {} : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelectorAll('[role="dialog"]').forEach((dialog) => dialog.remove());
});

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo-1',
  accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};
const pull: RepositoryChangeRequestReference = {
  kind: 'pull', provider: 'github', number: 12, title: 'Login flow', url: 'https://github.com/acme/app/pull/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
};
const capabilities: SourceControlCapabilities = {
  identity: { provider: 'github', instance: 'github.com' },
  authentication: true,
  authenticationMethods: { device: { available: false }, pat: { available: true }, cli: { available: false } },
  multipleAccounts: true,
  projects: true, issues: true, changeRequests: true, draftChangeRequests: true, draftConversion: true,
  mergeChangeRequests: true, mergeMethods: ['merge'], ci: true,
};

let sent: string[] = [];
let payloads: Array<{ target: { head?: string; base?: string; headSha?: string } }> = [];

const receipt = (input: { repositoryId: string; bindingRevision: number; primaryRemote: string }) => ({
  status: 'succeeded' as const,
  replayed: false,
  result: {},
  actor: { provider: 'github', instance: 'github.com', providerAccountId: 'github.com#7' },
  target: { repositoryId: input.repositoryId, bindingRevision: input.bindingRevision, primaryRemote: input.primaryRemote, project: { id: '1', owner: 'acme', name: 'app' } },
});

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

type RenderOptions = {
  branchWriteAccess?: boolean;
  shown?: RepositoryChangeRequestReference;
  setBase?: () => Promise<void>;
  onChanged?: () => Promise<void>;
};

async function render(options: RenderOptions = {}) {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { SourceBoardActions } = await import('./SourceBoardActions');
  const { SourceBoardBase } = await import('./SourceBoardMetaEditors');

  const base = githubLikeDescriptor();
  const descriptor: SourceControlProviderDescriptor = { ...base, features: { ...base.features, rebase: true } };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });

  sent = [];
  payloads = [];
  const web = createWebAPIs();
  const apis: RuntimeAPIs = {
    ...web,
    sourceControl: {
      ...web.sourceControl,
      capabilities: async () => capabilities,
      projectBranches: async () => ['main', 'release'],
      changeRequestSetBase: async (input) => { sent.push('base'); payloads.push(input); await options.setBase?.(); return receipt(input); },
      changeRequestMerge: async (input) => { sent.push('merge'); return { ...receipt(input), result: { merged: true } }; },
      changeRequestUpdateBranch: async (input) => { sent.push('update'); payloads.push(input); return receipt(input); },
      changeRequestRebase: async (input) => { sent.push('rebase'); payloads.push(input); return receipt(input); },
    },
  };
  const onChanged = options.onChanged ?? (async () => undefined);

  const draw = (shown: RepositoryChangeRequestReference) => act(async () => {
    root.render(
      <SyncProvider sdk={createSdk()} directory="">
        <I18nProvider>
          <RuntimeAPIContext.Provider value={apis}>
            <SourceBoardBase pull={shown} context={context} onChanged={onChanged} />
            <SourceBoardActions
              item={{ source: 'repository', reference: shown }}
              project={{ id: 'project-1', path: '/work/app' }}
              context={context}
              onStartWorktree={() => undefined}
              onChanged={onChanged}
              worktreeAvailable
              branchWriteAccess={options.branchWriteAccess}
            />
          </RuntimeAPIContext.Provider>
        </I18nProvider>
      </SyncProvider>,
    );
  });
  await draw(options.shown ?? pull);
  return { draw };
}

const button = (label: string, scope: ParentNode = host) => [...scope.querySelectorAll('button')]
  .find((node) => node.textContent?.trim() === label);

async function press(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => { target?.click(); });
}

describe('the branch actions in the footer', () => {
  test('ask before rebasing, naming the base and stating that the head is rewritten', async () => {
    await render();
    await press('Rebase onto base');

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('main');
    expect(dialog?.textContent).toContain('rewrites');

    await act(async () => { button('Cancel', dialog ?? host)?.click(); });
    expect(sent).toEqual([]);
  });

  test('send the rebase once confirmed', async () => {
    await render();
    await press('Rebase onto base');

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await act(async () => { button('Rebase onto base', dialog ?? host)?.click(); });
    expect(sent).toEqual(['rebase']);
  });

  test('send an update without asking first', async () => {
    await render();
    await press('Update branch');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(sent).toEqual(['update']);
  });

  test('are hidden when the host denies branch write access', async () => {
    await render({ branchWriteAccess: false });
    expect(button('Update branch')).toBeUndefined();
    expect(button('Rebase onto base')).toBeUndefined();
  });
});

const basePencil = () => host.querySelector<HTMLButtonElement>('button[aria-label="Edit base branch"]');
const settle = () => act(async () => { await Promise.resolve(); });

describe('one write at a time on a change request', () => {
  test('a base change holds Merge, Update branch and Rebase until the new base is read back', async () => {
    const write = deferred();
    const readBack = deferred();
    await render({ setBase: () => write.promise, onChanged: () => readBack.promise });

    await act(async () => { basePencil()?.click(); });
    const release = [...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')].find((item) => item.textContent?.includes('release'));
    await act(async () => { release?.click(); });
    await settle();
    expect(sent).toEqual(['base']);

    for (const label of ['Create a merge commit', 'Update branch', 'Rebase onto base']) expect(button(label)?.disabled).toBe(true);
    await press('Update branch');
    expect(sent).toEqual(['base']);

    await act(async () => { write.resolve(); });
    await settle();
    expect(button('Create a merge commit')?.disabled).toBe(true);

    await act(async () => { readBack.resolve(); });
    await settle();
    expect(button('Create a merge commit')?.disabled).toBe(false);
    expect(button('Update branch')?.disabled).toBe(false);
  });

  test('a rebase confirmed after the base moved sends only the rebase, carrying the base it showed', async () => {
    const { draw } = await render();
    await press('Rebase onto base');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('main');
    expect(basePencil()?.disabled).toBe(true);

    await draw({ ...pull, base: 'release' });
    await act(async () => { button('Rebase onto base', dialog ?? host)?.click(); });
    await settle();

    expect(sent).toEqual(['rebase']);
    expect(payloads[0]?.target).toMatchObject({ base: 'main', headSha: pull.headSha });
  });

  test('a base change carries the branches shown when the picker opened, so a retarget from elsewhere is refused', async () => {
    const { draw } = await render();
    await act(async () => { basePencil()?.click(); });
    await draw({ ...pull, base: 'develop' });
    const release = [...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')].find((item) => item.textContent?.includes('release'));
    await act(async () => { release?.click(); });
    await settle();

    expect(sent).toEqual(['base']);
    expect(payloads[0]?.target).toMatchObject({ number: pull.number, head: 'feature', base: 'main' });
  });
});
