import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import type {
  Issue,
  IssueComment,
  RepositoryIssueReference,
  RuntimeAPIs,
  SourceControlAPI,
  SourceControlBindingRead,
} from '@/lib/api/types';
import type { SourceControlReadContext } from '@/lib/source-control/types';
import { unknownProviderDescriptor, type SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import type { IssueFilter } from '../../references/referencePickerItems';

const browser = new Window({ url: 'http://runtime.test' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  Text: browser.Text,
  NodeList: browser.NodeList,
  customElements: browser.customElements,
  HTMLAnchorElement: browser.HTMLAnchorElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLImageElement: browser.HTMLImageElement,
  DocumentFragment: browser.DocumentFragment,
  Range: browser.Range,
  DOMParser: browser.DOMParser,
  IntersectionObserver: browser.IntersectionObserver,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  PointerEvent: browser.PointerEvent,
  ResizeObserver: browser.ResizeObserver,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const readContext: SourceControlReadContext = {
  provider: 'gitea',
  instance: 'https://gitea.test',
  directory: '/fixture/chats',
  repositoryId: 'org/chats',
  accountId: 'account-1',
  bindingRevision: 1,
  primaryRemote: 'origin',
};

// The folder's binding; its entry for the read context's provider and instance
// names the repository the detail read asks for. Tests swap in the
// unconfigured variant, whose binding has no provider entries at all.
const bindingRead: SourceControlBindingRead = {
  repository: {
    repositoryId: 'org/chats',
    configRevision: 'cfg-1',
    bare: false,
    remotes: [{
      name: 'origin',
      fetch: { displayUrl: 'https://gitea.test/org/chats', fingerprint: 'fp-origin' },
      push: { displayUrl: 'https://gitea.test/org/chats', fingerprint: 'fp-origin' },
    }],
  },
  revision: 1,
  status: 'bound',
  binding: {
    repositoryId: 'org/chats',
    revision: 1,
    providers: [{
      provider: 'gitea',
      instance: 'https://gitea.test',
      accountId: 'account-1',
      primaryRemote: 'origin',
      repository: { owner: 'org', name: 'chats' },
      readiness: 'ready',
      endpoint: { displayUrl: 'https://gitea.test/org/chats', fingerprint: 'fp-origin' },
    }],
    remotes: [],
    auxiliary: [],
    state: 'bound',
    configRevision: 'cfg-1',
  },
};

// The same folder before anyone configured a provider for it: the read's
// binding has no provider entries, so no read names a repository.
const unconfiguredBindingRead: SourceControlBindingRead = {
  ...bindingRead,
  status: 'missing',
  binding: null,
};

const giteaDescriptor: SourceControlProviderDescriptor = {
  ...unknownProviderDescriptor('gitea'),
  features: { ...unknownProviderDescriptor('gitea').features, labels: true, milestones: true },
};

// The list the section reads; each test sets the state it pins.
type PinnedList = {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  unavailable: 'disconnected' | 'no-repo' | null;
  items: RepositoryIssueReference[];
  error: string | null;
  retry: () => void;
};
const list: PinnedList = {
  status: 'ready',
  unavailable: null,
  items: [],
  error: null,
  retry: () => undefined,
};

// The detail the section opens; each test names the issue and comments it reads.
let detailIssue: Issue | null = null;
let detailComments: IssueComment[] = [];

const issue: Issue = {
  id: 'issue-7',
  provider: 'gitea',
  instance: 'https://gitea.test',
  number: 7,
  project: {
    id: 'org/chats', provider: 'gitea', instance: 'https://gitea.test',
    owner: 'org', name: 'chats', url: 'https://gitea.test/org/chats',
  },
  title: 'Pipelines time out',
  body: 'The build hangs on the link check step.',
  url: 'https://gitea.test/org/chats/issues/7',
  state: 'open',
  author: { id: 'user-1', provider: 'gitea', instance: 'https://gitea.test', username: 'luffy', avatarUrl: 'https://gitea.test/avatar/1.png' },
  labels: [{ name: 'bug', color: 'd042f1' }],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
};

const comment: IssueComment = {
  id: 'comment-1',
  provider: 'gitea',
  instance: 'https://gitea.test',
  url: 'https://gitea.test/org/chats/issues/7#comment-1',
  body: 'Seen it on the release branch too.',
  author: { id: 'user-2', provider: 'gitea', instance: 'https://gitea.test', username: 'choo' },
  createdAt: '2026-10-11T00:00:00Z',
};

const row: RepositoryIssueReference = {
  kind: 'issue',
  number: 7,
  title: 'Pipelines time out',
  url: issue.url,
  body: '',
  bodyTruncated: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  author: { login: 'luffy', avatarUrl: 'https://gitea.test/avatar/1.png' },
  labels: [{ name: 'bug', color: 'd042f1' }],
  commentCount: 1,
  sourceRepo: { owner: 'org', repo: 'chats', source: 'origin' },
  provider: 'gitea',
  state: 'open',
};

// A second issue the switch-race test opens while the first is still loading.
const issueB: Issue = {
  ...issue,
  id: 'issue-8',
  number: 8,
  title: 'The release build doubles in size',
  body: 'The release build is twice as large as it was.',
  url: 'https://gitea.test/org/chats/issues/8',
};

const rowB: RepositoryIssueReference = {
  ...row,
  number: 8,
  title: issueB.title,
  url: issueB.url,
};

const unexpected = (): never => { throw new Error('Unexpected source-control call'); };
const sourceControl: SourceControlAPI = {
  providers: unexpected,
  references: unexpected,
  repositoryBinding: unexpected,
  repositoryContext: unexpected,
  resetRepositoryBinding: unexpected,
  repositoryProviderBindingMutate: unexpected,
  authInstances: unexpected,
  capabilities: unexpected,
  authStatus: unexpected,
  authStart: unexpected,
  authComplete: unexpected,
  authSetToken: unexpected,
  authDisconnect: unexpected,
  authActivate: unexpected,
  authSetCliDisabled: unexpected,
  changeRequestStatus: unexpected,
  changeRequestCreate: unexpected,
  changeRequestUpdate: unexpected,
  changeRequestMerge: unexpected,
  changeRequestReady: unexpected,
  changeRequestComment: unexpected,
  changeRequestStartThread: unexpected,
  changeRequestReplyToThread: unexpected,
  changeRequestResolveThread: unexpected,
  changeRequestReview: unexpected,
  issueComment: unexpected,
  changeRequestSetState: unexpected,
  issueSetState: unexpected,
  changeRequestSetLabels: unexpected,
  issueSetLabels: unexpected,
  discussionComment: unexpected,
  discussionSetState: unexpected,
  discussionSetAnswer: unexpected,
  discussionSetLabels: unexpected,
  changeRequestSetReviewers: unexpected,
  refreshProviderReads: unexpected,
  referenceLabels: async () => [],
  referenceMilestones: async () => [],
  referenceReviewers: unexpected,
  changeRequestsList: unexpected,
  changeRequestContext: unexpected,
  issuesList: unexpected,
  issueGet: async () => detailIssue,
  issueComments: async () => detailComments,
  projectUpstream: unexpected,
  projectBranches: unexpected,
  referenceDetail: unexpected,
  changeRequestListStatuses: unexpected,
};

// The section's list, detail and option reads are pinned here; the rest of the
// module stays the real one.
const actualReferenceSources = await import('@/components/references/referenceSources');
const actualRegistry = await import('@/lib/source-control/providers/registry');
const actualRepositoryBinding = await import('@/lib/source-control/repository-binding');

mock.module('@/components/references/referenceSources', () => ({
  ...actualReferenceSources,
  useRepositoryReadContext: () => readContext,
  useRepositoryReferenceProvider: () => 'gitea',
  useRepositoryReferenceList: () => list,
}));
// The folder's binding answers the project question the list rows used to.
// `currentBindingRead` swaps which read the section sees; tests point it at the
// unconfigured variant to pin the no-provider-entries case.
let currentBindingRead: SourceControlBindingRead = bindingRead;
mock.module('@/lib/source-control/repository-binding', () => ({
  ...actualRepositoryBinding,
  useRepositoryBinding: () => ({ status: 'ready', read: currentBindingRead, error: null, contexts: [readContext], scope: {}, retry: () => undefined, isCurrent: () => true, stale: false }),
}));
mock.module('@/lib/source-control/providers/registry', () => ({
  ...actualRegistry,
  useSourceControlProvider: () => giteaDescriptor,
}));

// The detail renders Markdown through the shared renderer; the test pins what
// the section hands it, so the renderer passes the content through.
mock.module('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content?: string }) => React.createElement('div', { 'data-mock-markdown': 'full' }, props.content ?? ''),
  SimpleMarkdownRenderer: (props: { content?: string }) => React.createElement('div', { 'data-mock-markdown': 'simple' }, props.content ?? ''),
}));

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { usePendingComposerReferences } = await import('@/components/chat/composer/pendingComposerReferences');
const { DEFAULT_ISSUE_FILTER } = await import('../../references/referencePickerItems');
const { IssuesSection } = await import('./IssuesSection');
const { issueToRepositoryReference } = await import('./issueReference');

const runtimeApis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unexpected(); },
  get git() { return unexpected(); },
  get files() { return unexpected(); },
  get settings() { return unexpected(); },
  get permissions() { return unexpected(); },
  get notifications() { return unexpected(); },
  sourceControl,
};

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

// The open issue the section is rendered with. A row click updates it, the way
// the panel's parent does, and `reopen` re-renders the tree with it.
let openIssueNumber: number | null = null;
let renderFilter: IssueFilter = DEFAULT_ISSUE_FILTER;
let renderSplit = false;

const sectionTree = (openIssue: number | null) => (
  <RuntimeAPIContext.Provider value={runtimeApis}>
    <I18nProvider>
      <IssuesSection
        directory="/fixture/chats"
        filter={renderFilter}
        onFilterChange={() => undefined}
        openIssueNumber={openIssue}
        onOpenIssue={(number) => { openIssueNumber = number; }}
        split={renderSplit}
      />
    </I18nProvider>
  </RuntimeAPIContext.Provider>
);

const renderSection = async (props: {
  filter?: IssueFilter;
  openIssueNumber?: number | null;
  split?: boolean;
} = {}) => {
  renderFilter = props.filter ?? DEFAULT_ISSUE_FILTER;
  renderSplit = props.split ?? false;
  openIssueNumber = props.openIssueNumber ?? null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(sectionTree(openIssueNumber));
  });
  await settle();
};

// Re-run the tree with the open issue a row click set.
const reopen = async () => {
  await act(async () => {
    root?.render(sectionTree(openIssueNumber));
  });
  await settle();
};

beforeEach(() => {
  currentBindingRead = bindingRead;
  list.status = 'ready';
  list.unavailable = null;
  list.items = [];
  list.error = null;
  detailIssue = null;
  detailComments = [];
  sourceControl.issueGet = async () => detailIssue;
  sourceControl.issueComments = async () => detailComments;
  sourceControl.referenceLabels = async () => [];
  sourceControl.referenceMilestones = async () => [];
  usePendingComposerReferences.setState({ references: [] });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

test('a failed list read shows the failure, never an empty list', async () => {
  list.status = 'error';
  list.error = 'offline';
  await renderSection();
  expect(host?.textContent).toContain('Couldn\u2019t load the list: offline');
  expect(host?.textContent).toContain('Retry');
  expect(host?.textContent).not.toContain('No issues match the filter');
});

test('an empty list page still reads its options: the read context alone names the repository', async () => {
  // No issues on the page (every one closed, say). The option reads send the
  // read context alone; the server resolves the repository from the directory,
  // so the dropdowns reach ready instead of staying in loading.
  list.items = [];
  const labelReads: Array<{ context: SourceControlReadContext; project: unknown }> = [];
  sourceControl.referenceLabels = async (context, project) => {
    labelReads.push({ context, project });
    return [{ name: 'bug', color: 'd042f1' }];
  };
  const milestoneReads: Array<{ context: SourceControlReadContext; project: unknown }> = [];
  sourceControl.referenceMilestones = async (context, project) => {
    milestoneReads.push({ context, project });
    return [{ name: 'v1.0', state: 'open' }];
  };
  await renderSection();
  expect(labelReads).toEqual([{ context: readContext, project: undefined }]);
  expect(milestoneReads).toEqual([{ context: readContext, project: undefined }]);
});

test('an unconfigured project still reads its options: the binding has no provider entries', async () => {
  // The binding read has no provider entries (an unconfigured project). The
  // option reads must not short-circuit to an empty list because no project is
  // named: they send the read context alone and let the server resolve the
  // repository from the directory.
  currentBindingRead = unconfiguredBindingRead;
  list.items = [];
  const labelReads: Array<SourceControlReadContext> = [];
  sourceControl.referenceLabels = async (context) => {
    labelReads.push(context);
    return [{ name: 'bug', color: 'd042f1' }];
  };
  const milestoneReads: Array<SourceControlReadContext> = [];
  sourceControl.referenceMilestones = async (context) => {
    milestoneReads.push(context);
    return [{ name: 'v1.0', state: 'open' }];
  };
  await renderSection();
  expect(labelReads).toEqual([readContext]);
  expect(milestoneReads).toEqual([readContext]);
});

test('the open issue shows its full body, its comments, its milestone and its labels', async () => {
  list.items = [row];
  detailIssue = issue;
  detailComments = [comment];
  await renderSection({
    openIssueNumber: 7,
    filter: { ...DEFAULT_ISSUE_FILTER, milestoneNames: ['v1.0'] },
  });
  const text = host?.textContent ?? '';
  // The title and the meta line.
  expect(text).toContain('Pipelines time out');
  expect(text).toContain('#7');
  expect(text).toContain('luffy');
  expect(text).toContain('Milestone: v1.0');
  // The state and the actions.
  expect(text).toContain('Open');
  expect(text).toContain('Attach to this session');
  expect(text).toContain('Open on gitea');
  // The label chip, the full body and the full comment thread.
  expect(text).toContain('bug');
  expect(text).toContain('The build hangs on the');
  expect(text).toContain('Seen it on the release branch too.');
  expect(text).toContain('choo');
});

test('attaching pushes a repository-issue composer reference', async () => {
  list.items = [row];
  detailIssue = issue;
  detailComments = [comment];
  await renderSection({ openIssueNumber: 7 });
  const attach = Array.from(host?.querySelectorAll('button') ?? [])
    .find((button) => button.textContent === 'Attach to this session');
  if (!attach) throw new Error('Attach button missing');
  await act(async () => { attach.click(); });
  await settle();
  const pending = usePendingComposerReferences.getState().references;
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    kind: 'repository-issue',
    provider: 'gitea',
    number: 7,
    title: 'Pipelines time out',
  });
  expect(pending[0].author).toEqual({ login: 'luffy', avatarUrl: 'https://gitea.test/avatar/1.png' });
});

test('the detail maps onto the list row shape the attach path reads', () => {
  const open = issueToRepositoryReference(issue, 'origin');
  expect(open).toMatchObject({
    kind: 'issue',
    number: 7,
    title: 'Pipelines time out',
    state: 'open',
    provider: 'gitea',
    body: 'The build hangs on the link check step.',
    labels: [{ name: 'bug', color: 'd042f1' }],
  });
  expect(open.author).toEqual({ login: 'luffy', avatarUrl: 'https://gitea.test/avatar/1.png' });
  expect(open.sourceRepo).toEqual({ owner: 'org', repo: 'chats', source: 'origin' });

  // A closed issue with nothing else: the state the list rows carry, an empty
  // body, no author.
  const closed = issueToRepositoryReference({ ...issue, body: undefined, author: null, labels: [], state: 'closed' }, 'upstream');
  expect(closed.state).toBe('completed');
  expect(closed.body).toBe('');
  expect(closed.author).toBeNull();
  expect(closed.labels).toEqual([]);
  expect(closed.sourceRepo).toEqual({ owner: 'org', repo: 'chats', source: 'upstream' });
});

test('a failed detail read falls back to the list, not a phantom detail', async () => {
  list.items = [row];
  // The detail read rejects. The section must fall back to the list, not
  // swallow the failure into a detail, and the rejection must be handled (an
  // unhandled one fails the process, not the test).
  sourceControl.issueGet = async () => { throw new Error('offline'); };
  await renderSection({ openIssueNumber: 7 });
  const text = host?.textContent ?? '';
  // The list row is back, not a detail.
  expect(host?.querySelector('[data-knowledge-entry-id="7"]')).not.toBeNull();
  expect(text).toContain('Pipelines time out');
  // The detail is not rendered: its attach action is absent.
  expect(text).not.toContain('Attach to this session');
});

test('a late detail answer loses to the issue opened after it', async () => {
  list.items = [row, rowB];
  let releaseA: (issue: Issue) => void = () => { throw new Error('No pending read'); };
  // Issue 7's detail read stays pending; issue 8's answers at once.
  sourceControl.issueGet = async (_context, number) => {
    if (number === 7) return new Promise<Issue>((resolve) => { releaseA = resolve; });
    return issueB;
  };

  await renderSection({ openIssueNumber: 7 });
  // Issue 7 is still loading; issue 8 is not shown.
  expect(host?.textContent).not.toContain(issueB.title);

  // Open issue 8 while issue 7's read is in flight: the parent re-points the
  // open issue, the way a row click does.
  openIssueNumber = 8;
  await reopen();

  // Issue 8 answers first; its detail is shown, issue 7's is not.
  expect(host?.textContent).toContain(issueB.title);
  expect(host?.textContent).not.toContain('Pipelines time out');

  // Issue 7's answer lands late. The detail stays issue 8's, never issue 7's.
  await act(async () => { releaseA(issue); });
  await settle();
  expect(host?.textContent).toContain(issueB.title);
  expect(host?.textContent).not.toContain('Pipelines time out');
});
