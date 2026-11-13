import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import type { ChangeRequestContext, RepositoryChangeRequestReference, RepositoryReferenceDetail, SourceControlBindingRead } from '@/lib/api/types';
import { stackFixture } from '@/lib/source-control/pullStack.test-support';

const browser = new Window({ url: 'http://localhost/' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, HTMLImageElement: browser.HTMLImageElement,
  Node: browser.Node, Event: browser.Event, CustomEvent: browser.CustomEvent,
  KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
  // Unrelated app-store initialization never reaches a real runtime.
  fetch: Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch),
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const { ReferencePreview } = await import('./ReferencePreview');
const { revalidateReferences } = await import('./referenceCache');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const { SyncProvider } = await import('@/sync/sync-context');
const { useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
const { repositoryBindingOwner } = await import('@/lib/source-control/repository-binding');
const { createWebAPIs } = await import('../../../../web/src/api');
const { createWebSourceControlAPI } = await import('../../../../web/src/api/source-control');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { usePendingComposerReferences } = await import('@/components/chat/composer/pendingComposerReferences');
const { useInlineCommentDraftStore } = await import('@/stores/useInlineCommentDraftStore');
const { getRuntimeKey } = await import('@/lib/runtime-switch');

const context = { provider: 'github', instance: 'github.com', directory: '/repo', repositoryId: 'repo-id',
  accountId: 'account', bindingRevision: 1, primaryRemote: 'origin' };
const endpoint = { displayUrl: 'https://github.com/acme/app', fingerprint: 'fetch' };
const binding: SourceControlBindingRead = {
  status: 'bound', revision: 1,
  repository: { repositoryId: 'repo-id', configRevision: 'config', bare: false, remotes: [{ name: 'origin', fetch: endpoint, push: endpoint }] },
  binding: { repositoryId: 'repo-id', configRevision: 'config', revision: 1, state: 'bound', remotes: [], auxiliary: [],
    providers: [{ ...context, readiness: 'ready', endpoint }],
  },
};
const stack = stackFixture();
const reference: RepositoryChangeRequestReference = { ...stack.members[1], kind: 'pull', provider: 'github', headRepo: null,
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
};
const detail: RepositoryReferenceDetail = { number: 2, comments: [], commentTotal: 0,
  pull: { reviewDecision: null, reviewers: [], additions: 0, deletions: 0, changedFiles: 0, commits: [], commitTotal: 0,
    stack: { number: 4, base: 'main', layers: stack.members },
  },
};
let root: Root;
let host: HTMLDivElement;
let stackReads = 0;
let failStack = false;
const apis = createWebAPIs();
const originalDraft = useSessionUIStore.getState().newSessionDraft;
const destination = { directory: '/repo', sessionKey: 'draft' };
const handoffTarget = { kind: 'draft', workDraftId: 'stack-attachment-draft', runtimeKey: getRuntimeKey() } as const;
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: () => new Promise<Response>(() => {}) });
const sourceControl = {
  ...createWebSourceControlAPI({ fetch: async (path) => {
    switch (path) {
      case '/api/source-control/github/pulls/stack':
        stackReads += 1;
        return failStack ? Response.json({ error: 'Stack read failed' }, { status: 503 }) : Response.json({ connected: true, stack });
      case '/api/source-control/github/capabilities':
        return Response.json({ identity: context, mergeChangeRequests: true, mergeMethods: ['squash'] });
      case '/api/pr-stacks/restack': return Response.json({ run: null });
      default: throw new Error(`Unexpected request: ${path}`);
    }
  } }),
  repositoryBinding: async () => binding,
  repositoryContext: async () => binding.repository,
  changeRequestContext: async (_context: typeof context, number: number): Promise<ChangeRequestContext> => {
    const member = stack.members.find((member) => member.number === number);
    if (!member) throw new Error('Unknown stack member');
    const project = { ...context, id: 'acme/app', owner: 'acme', name: 'app', url: 'https://github.com/acme/app' };
    return { identity: context, project, changeRequest: { ...context, ...member, project, id: String(number) },
      issueComments: [], reviewComments: [], files: [], diff: `patch-${number}` };
  },
};

beforeEach(() => {
  stackReads = 0;
  failStack = false;
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { ...originalDraft, open: true, directoryOverride: '/repo', workDraftId: handoffTarget.workDraftId } });
  usePendingComposerReferences.getState().consume(handoffTarget);
  useInlineCommentDraftStore.getState().clearDrafts(destination);
  repositoryBindingOwner.reset();
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), holdsList: true, status: 'ready' });
  const user = { ...context, id: '1', username: 'acme' };
  useSourceControlAuthStore.getState().setStatus(context, { ...context, connected: true, status: 'connected', user,
    accounts: [{ id: 'account', credentialId: 'account', credentialRevision: 1, providerUserId: 'github.com#1', providerUserStatus: 'available',
      user, source: 'pat', status: 'valid', current: true }],
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: originalDraft });
  usePendingComposerReferences.getState().consume(handoffTarget);
  useInlineCommentDraftStore.getState().clearDrafts(destination);
});
afterAll(async () => {
  repositoryBindingOwner.reset();
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const render = async (enabled = true) => act(async () => root.render(
  <RuntimeAPIContext.Provider value={{ ...apis, sourceControl }}><SyncProvider sdk={sdk} directory="/repo"><I18nProvider>
    <ReferencePreview item={{ source: 'repository', reference }} directory="/repo" stackEnabled={enabled} purpose="attach" pinned now={0}
      pullStatus={{ status: 'idle' }} trackerDetail={{ status: 'idle' }} repositoryDetail={{ status: 'ready', value: detail }}
      includeDiff={false} onIncludeDiffChange={() => undefined} />
  </I18nProvider></SyncProvider></RuntimeAPIContext.Provider>,
));

test('adds recovery and whole-stack controls to one native membership map', async () => {
  // Given / When
  await render();

  // Then
  const map = host.querySelector('ol');
  expect(host.querySelectorAll('ol')).toHaveLength(1);
  expect([...map?.children ?? []].map((row) => row.textContent?.includes('Change') ? row.textContent?.match(/#\d+/)?.[0] : row.textContent)).toEqual(['#3', '#2', '#1', 'main']);
  const labels = [...host.querySelectorAll('button')].map((button) => button.textContent);
  expect(labels).toContain('Fetch and restack');
  expect(labels).toContain('Attach whole stack');
  expect(labels).toContain('Open stacked PR on top');
  expect(stackReads).toBe(1);
});

test('keeps the native map and a retry when the fork stack read fails', async () => {
  // Given
  failStack = true;

  // When
  await render();

  // Then
  expect(host.querySelectorAll('ol')).toHaveLength(1);
  expect(host.querySelector('ol')?.children).toHaveLength(4);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Stack read failed');
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(true);
});

test('stops stack reads when a retained preview is hidden', async () => {
  // Given
  await render();
  await render(false);
  const readsBeforeRefresh = stackReads;

  // When
  await act(async () => revalidateReferences());

  // Then
  expect(stackReads).toBe(readsBeforeRefresh);
  expect(host.querySelectorAll('ol')).toHaveLength(1);
  expect(host.textContent).not.toContain('Attach whole stack');
});

test('attaches the whole stack to the draft with its anchor following membership', async () => {
  // Given
  await render();
  const attach = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Attach whole stack');
  if (!attach) throw new Error('Missing whole-stack action');

  // When
  await act(async () => attach.click());

  // Then
  const references = usePendingComposerReferences.getState().consume(handoffTarget);
  expect(references.map((entry) => entry.kind === 'change-request' ? entry.number : null)).toEqual([1, 2, 3]);
  expect(references.map((entry) => entry.kind === 'change-request' ? entry.followStack : null)).toEqual([undefined, true, undefined]);
  const summary = useInlineCommentDraftStore.getState().getDrafts(destination);
  expect(summary).toHaveLength(1);
  expect(summary[0]?.source).toBe('pr-comment');
});
