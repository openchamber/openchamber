import React, { act } from 'react';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { CISummary, RepositoryChangeRequestReference, RepositoryReference, SourceControlReadContext } from '@/lib/api/types';
import type { TrackedItemState, TrackedThread } from '@/lib/trackedItems/model';

const github: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo', accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};
const gitlab: SourceControlReadContext = { ...github, provider: 'gitlab', instance: 'https://gitlab.com', accountId: 'gitlab#3' };

const pull = (number: number, url = `https://github.com/acme/app/pull/${number}`): RepositoryChangeRequestReference => ({
  kind: 'pull', provider: 'github', number, title: `PR ${number}`, url,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: `branch-${number}`, base: 'main', headSha: `sha-${number}`, headRepo: null,
});

const checks = (state: CISummary['state']): CISummary => ({
  state, total: 2, success: state === 'success' ? 2 : 0, failure: 0, pending: state === 'pending' ? 2 : 0,
});

// Loaded once the DOM globals exist: the store reads storage when it loads.
let live: typeof import('./liveReferences');
let model: typeof import('@/lib/trackedItems/model');
let store: typeof import('@/stores/useTrackedItemsStore');
let runtime: typeof import('@/lib/runtime-switch');
let providers: typeof import('@/lib/source-control/providers/registry');

beforeAll(async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  live = await import('./liveReferences');
  model = await import('@/lib/trackedItems/model');
  store = await import('@/stores/useTrackedItemsStore');
  runtime = await import('@/lib/runtime-switch');
  providers = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor, gitlabLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const ordered = [githubLikeDescriptor(), gitlabLikeDescriptor()];
  providers.useSourceControlProviderRegistry.setState({ ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: false });
});

beforeEach(() => {
  store.useTrackedItemsStore.setState({ records: {} });
});

/** The server's answer for a GitHub PR read with `context`'s account, at `fetchedAt`. */
const pushPull = (reference: RepositoryChangeRequestReference, context: SourceControlReadContext, fetchedAt: number, state: Partial<{ state: 'open' | 'merged'; checks: CISummary }>) => {
  const item: TrackedThread<'pull'> = { provider: 'github', instance: context.instance, kind: 'pull', owner: 'acme', repo: 'app', number: reference.number, accountId: context.accountId };
  const record: TrackedItemState = {
    type: 'pull', item, fetchedAt,
    state: { owner: item.owner, repo: item.repo, number: item.number, state: 'open', draft: false, title: reference.title, mergeable: true, mergeableState: 'clean', checks: null, ...state },
  };
  act(() => { store.useTrackedItemsStore.getState().apply(runtime.getRuntimeKey(), [{ key: model.trackedItemKey(item), record }]); });
};

async function render<T>(hook: () => T): Promise<{ current: () => T; unmount: () => void }> {
  const { createRoot } = await import('react-dom/client');
  let latest: T | undefined;
  const Probe: React.FC = () => { latest = hook(); return null; };
  const root = createRoot(document.createElement('div'));
  await act(async () => { root.render(<Probe />); });
  return {
    current: () => {
      if (latest === undefined) throw new Error('not rendered');
      return latest;
    },
    unmount: () => act(() => root.unmount()),
  };
}

test('a listed PR takes the state followed after the list was read, never an older one', async () => {
  const readAt = Date.now();
  const items: RepositoryReference[] = [pull(1), pull(2)];
  const contextOf = () => github;
  const reads = [{ start: 0, read: { at: readAt, forced: false } }];
  const view = await render(() => live.useLiveReferences(items, contextOf, reads));
  expect(view.current().items).toBe(items);
  expect(view.current().followed).toHaveLength(2);

  // Read a minute before the list: what the list says stands.
  pushPull(pull(1), github, readAt - 60_000, { state: 'merged' });
  expect(view.current().items).toBe(items);

  // Merged on the host after the list was read.
  pushPull(pull(2), github, readAt + 5_000, { state: 'merged' });
  expect(view.current().items.map((item) => item.state)).toEqual(['open', 'merged']);
  view.unmount();
});

test('checks that finish while the list is on screen replace the status asked with it', async () => {
  const pulls = [{ reference: pull(1), context: github }];
  const view = await render(() => live.useLivePullStatuses(pulls));
  expect(view.current()(pull(1), github)).toBeNull();

  pushPull(pull(1), github, Date.now(), { checks: checks('success') });
  expect(view.current()(pull(1), github)?.status.checks?.state).toBe('success');
  // Another account's read of the same PR is another item.
  expect(view.current()(pull(1), { ...github, accountId: 'github.com#8' })).toBeNull();
  view.unmount();
});

test('a GitLab merge request is followed by its project path, subgroups included, and closed items not at all', async () => {
  const items: RepositoryReference[] = [pull(4, 'https://gitlab.com/group/sub/app/-/merge_requests/4'), { ...pull(5), state: 'closed' }];
  const contextOf = () => gitlab;
  const reads = [{ start: 0, read: { at: Date.now(), forced: false } }];
  const view = await render(() => live.useLiveReferences(items, contextOf, reads));
  expect(view.current().followed).toEqual([
    { provider: 'gitlab', instance: 'https://gitlab.com', kind: 'pull', owner: 'group/sub', repo: 'app', number: 4, accountId: 'gitlab#3' },
  ]);
  view.unmount();
});

test('a listed enterprise PR is followed on its own instance', async () => {
  const enterprise: SourceControlReadContext = { ...github, instance: 'ghe.example.com', accountId: 'ghe#1' };
  const items: RepositoryReference[] = [pull(6, 'https://ghe.example.com/acme/app/pull/6')];
  const contextOf = () => enterprise;
  const reads = [{ start: 0, read: { at: Date.now(), forced: false } }];
  const view = await render(() => live.useLiveReferences(items, contextOf, reads));
  expect(view.current().followed).toEqual([
    { provider: 'github', instance: 'ghe.example.com', kind: 'pull', owner: 'acme', repo: 'app', number: 6, accountId: 'ghe#1' },
  ]);
  view.unmount();
});

test('a read forced after a change, and a later page, stand against a state followed just before them', async () => {
  const firstPage = Date.now() - 120_000;
  const secondPage = Date.now();
  const items: RepositoryReference[] = [pull(1), { ...pull(2), title: 'Renamed' }];
  const contextOf = () => github;
  // A state from 10 s before a forced read is older than what the read saw.
  const forced = [{ start: 0, read: { at: secondPage, forced: true } }];
  pushPull(pull(1), github, secondPage - 10_000, { state: 'merged' });
  const afterChange = await render(() => live.useLiveReferences(items, contextOf, forced));
  expect(afterChange.current().items).toBe(items);
  afterChange.unmount();

  // The second page was read after the followed state; the first page before it.
  pushPull(pull(2), github, secondPage - 60_000, {});
  const paged = [{ start: 0, read: { at: firstPage, forced: false } }, { start: 1, read: { at: secondPage, forced: false } }];
  const view = await render(() => live.useLiveReferences(items, contextOf, paged));
  expect(view.current().items.map((item) => [item.state, item.title])).toEqual([['merged', 'PR 1'], ['open', 'Renamed']]);
  view.unmount();
});
