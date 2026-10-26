import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type {
  RepositoryReference,
  RepositoryReferencePage,
  RuntimeAPIs,
  SourceControlAPI,
} from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';
import { buildLinkedIssue, getLinkedSidebarChanges, getLinkedSidebarIssues, withLinkedIssue } from '@/lib/linkedIssues';
import { createRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { buildSessionIssueItems } from '@/components/session/sidebar/sessions/sessionPrSummaries';
import type { SourceControlProviderDescriptor } from './descriptor';
import { acmeDescriptor } from './descriptor.fixture';
import { useSourceControlProviderRegistry } from './registry';
import { formatChangeRequestLabel, formatChangeRequestReference } from './terminology';

/**
 * A provider no UI code names: the server serves its descriptor, and every
 * surface below names it, draws its mark and writes its numbers from that
 * descriptor alone. Its terminology differs from GitHub's on purpose (`!` for
 * change requests, its own number spaces, "CR", a pipeline), so a surface that
 * still assumes GitHub shows up as a wrong prefix or a borrowed name.
 *
 * The settings card for a provider like this is covered by
 * `components/sections/integrations/SourceControlProviderCard.test.tsx`
 * ("names the provider by its label and draws its served mark").
 */

const ACME_PATH = 'M12 2L2 22h20L12 2z';
const ACME_ORIGIN = 'https://forge.example.com';

const acme: SourceControlProviderDescriptor = acmeDescriptor({
  terminology: {
    ...acmeDescriptor().terminology,
    changeRequestPrefix: '!',
    issuePrefix: '#',
    sharedNumberSpace: false,
    abbreviation: 'CR',
    promptNoun: 'change request',
    ci: 'pipeline',
  },
});

const unexpected = (): never => { throw new Error('Unexpected runtime API access'); };

const reference = (kind: 'issue' | 'pull', number: number, title: string): RepositoryReference => {
  const common = {
    number,
    title,
    url: `${ACME_ORIGIN}/org/tool/${kind === 'pull' ? 'pulls' : 'issues'}/${number}`,
    body: '',
    bodyTruncated: false,
    createdAt: null,
    updatedAt: null,
    author: null,
    labels: [],
    commentCount: 0,
    sourceRepo: { owner: 'org', repo: 'tool', source: 'origin' },
    provider: 'acme',
  };
  return kind === 'pull'
    ? { ...common, kind: 'pull', state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'abc123', headRepo: null }
    : { ...common, kind: 'issue', state: 'open' };
};

const servedReferences = {
  pull: [reference('pull', 12, 'Teach the forge to rebase')],
  issue: [reference('issue', 7, 'Pipelines time out')],
  discussion: [],
} satisfies Record<RepositoryReference['kind'], RepositoryReference[]>;

let providerReads = 0;

/** The connected server: it serves acme and lists its items through the neutral reads. */
const sourceControl: SourceControlAPI = {
  providers: async () => { providerReads += 1; return [acme]; },
  references: async (_context, query): Promise<RepositoryReferencePage> => ({
    connected: true, repo: null, items: servedReferences[query.kind], cursor: null, hasMore: false, total: servedReferences[query.kind].length,
  }),
  // The binding of the dialog's project never answers: nothing about the repository is known yet.
  repositoryBinding: () => new Promise(() => {}),
  repositoryContext: unexpected, resetRepositoryBinding: unexpected, repositoryProviderBindingMutate: unexpected,
  authInstances: unexpected, capabilities: unexpected, authStatus: unexpected, authStart: unexpected,
  authComplete: unexpected, authSetToken: unexpected, authDisconnect: unexpected, authActivate: unexpected,
  authSetCliDisabled: unexpected,
  changeRequestStatus: unexpected, changeRequestCreate: unexpected, changeRequestUpdate: unexpected,
  changeRequestMerge: unexpected, changeRequestReady: unexpected, changeRequestComment: unexpected,
  changeRequestStartThread: unexpected, changeRequestReplyToThread: unexpected, changeRequestResolveThread: unexpected,
  changeRequestReview: unexpected, issueComment: unexpected, changeRequestSetState: unexpected,
  issueSetState: unexpected, changeRequestSetLabels: unexpected, issueSetLabels: unexpected,
  discussionComment: unexpected, discussionSetState: unexpected, discussionSetAnswer: unexpected, discussionSetLabels: unexpected,
  changeRequestSetReviewers: unexpected, refreshProviderReads: unexpected, referenceLabels: unexpected,
  referenceReviewers: unexpected, changeRequestsList: unexpected, changeRequestContext: unexpected,
  issuesList: unexpected, issueGet: unexpected, issueComments: unexpected, projectUpstream: unexpected,
  projectBranches: unexpected, referenceDetail: unexpected, changeRequestListStatuses: unexpected,
};

const readContext = {
  provider: 'acme', instance: ACME_ORIGIN, accountId: 'acme-account', directory: '/work/tool',
  repositoryId: 'org/tool', primaryRemote: 'origin', bindingRevision: 1,
} as const;

const PROVIDER_NAMES = /GitHub|GitLab/;
const namesOtherProvider = (text: string | null | undefined): boolean => PROVIDER_NAMES.test(text ?? '');

describe('a source-control provider no UI code names', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const registryBefore = useSourceControlProviderRegistry.getState();

  beforeEach(async () => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      HTMLInputElement: dom.HTMLInputElement, DocumentFragment: dom.DocumentFragment,
      KeyboardEvent: dom.KeyboardEvent, HTMLIFrameElement: dom.HTMLIFrameElement,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, Event: dom.Event,
      CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
      // App stores that load on import, and the dialog's setup reads, never get an answer.
      fetch: () => new Promise<Response>(() => {}),
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    container = document.createElement('div');
    document.body.append(container);
    providerReads = 0;
    // The real path: the registry asks the server for its providers.
    await useSourceControlProviderRegistry.getState().refresh(sourceControl);
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    useSourceControlProviderRegistry.setState({
      runtimeKey: registryBefore.runtimeKey, byId: registryBefore.byId, ordered: registryBefore.ordered, status: registryBefore.status, holdsList: registryBefore.holdsList,
    });
    await dom.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const render = async (node: React.ReactNode) => {
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => { mounted.render(<I18nProvider>{node}</I18nProvider>); });
  };

  test('the registry holds the served descriptor, read from the server', () => {
    expect(providerReads).toBe(1);
    const state = useSourceControlProviderRegistry.getState();
    expect(state.status).toBe('ready');
    expect(state.ordered.map((descriptor) => descriptor.id)).toEqual(['acme']);
    expect(state.byId.get('acme')?.label).toBe('Acme Forge');
  });

  test('reference picker rows write its change requests and issues with its own prefixes', async () => {
    const { ReferencePickerRow } = await import('@/components/references/ReferencePickerRow');
    const pulls = await sourceControl.references(readContext, { kind: 'pull' });
    const issues = await sourceControl.references(readContext, { kind: 'issue' });
    if (!pulls.connected || !issues.connected) throw new Error('Expected connected pages');
    const items = [...pulls.items, ...issues.items];
    await render(
      <div>
        {items.map((item) => (
          <ReferencePickerRow
            key={`${item.kind}${item.number}`}
            item={{ source: 'repository', reference: item }}
            pullStatus={null}
            highlighted={false}
            checked={false}
            diffIncluded={false}
            now={Date.now()}
            onHighlight={() => {}}
            onToggle={() => {}}
            onActivate={() => {}}
          />
        ))}
      </div>,
    );
    const ids = [...container.querySelectorAll('[role="option"] .font-mono')].map((entry) => entry.textContent);
    expect(ids).toEqual(['!12', '#7']);
    expect(container.textContent).toContain('Teach the forge to rebase');
    expect(container.textContent).toContain('Pipelines time out');
    expect(namesOtherProvider(container.innerHTML)).toBe(false);
  });

  test('its mark is the path it serves, drawn for the registered id', async () => {
    const { ProviderIcon } = await import('@/components/sourceControl/ProviderIcon');
    const { useSourceControlProvider } = await import('./registry');
    const Mark: React.FC = () => {
      const descriptor = useSourceControlProvider('acme');
      return <span>{descriptor.label}<ProviderIcon descriptor={descriptor} /></span>;
    };
    await render(<Mark />);
    expect(container.textContent).toBe('Acme Forge');
    expect(container.querySelector(`svg path[d="${ACME_PATH}"]`)).not.toBeNull();
  });

  test('sidebar badges read its change request as !12 and its issue as #7', () => {
    const { ordered } = useSourceControlProviderRegistry.getState();
    const matcher = createRepositoryUrlMatcher(ordered, []);
    const pull = buildLinkedIssue({ url: `${ACME_ORIGIN}/org/tool/pulls/12`, number: 12, title: 'Teach the forge to rebase', kind: 'pull', linkedAt: 1 });
    const issue = buildLinkedIssue({ url: `${ACME_ORIGIN}/org/tool/issues/7`, number: 7, title: 'Pipelines time out', kind: 'issue', linkedAt: 2 });
    const session: Session = {
      id: 'session-1', projectID: 'project', directory: '/work/tool', title: 'Acme work', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
      metadata: withLinkedIssue(withLinkedIssue({}, pull, true), issue, true),
    };

    const changes = getLinkedSidebarChanges(session, matcher);
    expect(changes.map((change) => change.identifier)).toEqual(['!12']);
    expect(changes[0]?.repository).toMatchObject({ provider: 'acme', instance: ACME_ORIGIN, thread: 'pull', number: 12 });

    const issues = buildSessionIssueItems(getLinkedSidebarIssues(session, matcher), [null]);
    expect(issues.map((item) => item.label)).toEqual(['#7']);

    // The row's change-request badge and the short label other surfaces show.
    const descriptor = matcher.descriptorOf('acme');
    expect(formatChangeRequestReference(descriptor, 12)).toBe('!12');
    // Its own prefix already tells a change request apart: no "CR" in front.
    expect(formatChangeRequestLabel(descriptor, 12)).toBe('!12');
  });

  test('New Worktree names the repository source after it and draws its mark', async () => {
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    const { createWebAPIs } = await import('../../../../../web/src/api/index');
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { NewWorktreeDialog } = await import('@/components/session/NewWorktreeDialog');
    const apis: RuntimeAPIs = { ...createWebAPIs(), sourceControl };
    const projectsBefore = useProjectsStore.getState();
    useProjectsStore.setState({ projects: [{ id: 'project-tool', path: '/work/tool' }], activeProjectId: 'project-tool' });
    try {
      await render(
        <RuntimeAPIContext.Provider value={apis}>
          <NewWorktreeDialog open onOpenChange={() => {}} />
        </RuntimeAPIContext.Provider>,
      );
      const fromItem = [...document.body.querySelectorAll<HTMLElement>('button, [role="button"], [role="radio"]')]
        .find((entry) => entry.textContent?.startsWith('PR or issue'));
      if (!fromItem) throw new Error('Missing the "PR or issue" option');
      await act(async () => { fromItem.click(); });

      const source = [...document.body.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === 'Acme Forge');
      if (!source) throw new Error('Missing the Acme Forge source');
      expect(source.querySelector(`svg path[d="${ACME_PATH}"]`)).not.toBeNull();
      // What the dialog shows on screen names no other provider.
      expect(namesOtherProvider(document.body.textContent)).toBe(false);
      expect(source.getAttribute('aria-label')).toBe('A Acme Forge issue or pull request');
    } finally {
      useProjectsStore.setState({ projects: projectsBefore.projects, activeProjectId: projectsBefore.activeProjectId });
    }
  });

  // The board's repository list title is built inline in `SourceBoardView`,
  // and rendering the whole board needs the folder's repositories, the binding
  // and the board store. This checks the sentence that title reads for the
  // provider's term, with its label.
  test('the board titles its repository list with the provider label', async () => {
    const { useI18n } = await import('@/lib/i18n');
    const Title: React.FC = () => {
      const { t } = useI18n();
      const descriptor = useSourceControlProviderRegistry((state) => state.byId.get('acme'));
      if (!descriptor) return null;
      return <h2>{t(`sourceBoard.list.repository.${descriptor.terminology.changeRequest}`, { provider: descriptor.label })}</h2>;
    };
    await render(<Title />);
    expect(container.textContent).toBe('Acme Forge issues and pull requests');
    expect(namesOtherProvider(container.textContent)).toBe(false);
  });
});
