import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  ChangeRequestSubmitRequirement,
  ChangeRequestVoteLabel,
  PullRequestStack,
  RepositoryChangeRequestReference,
  ReviewChangeRequestInput,
  RuntimeAPIs,
  SourceControlReadContext,
} from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The components' imports pull in app stores that load on import; their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

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
});

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo-1',
  accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};
const pullOn = (provider: string): RepositoryChangeRequestReference => ({
  kind: 'pull', provider, number: 12, title: 'Login flow', url: 'https://example.com/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
});
const voteLabels: ChangeRequestVoteLabel[] = [
  {
    name: 'Code-Review', defaultValue: 0, blocking: true, status: 'neutral', permitted: [1, -1, 0],
    values: [{ value: -1, description: 'Prefer you did not submit this' }, { value: 0, description: 'No score' }, { value: 1, description: 'Looks good to me' }],
    votes: [],
  },
  { name: 'Verified', defaultValue: 0, blocking: true, status: 'neutral', permitted: [], values: [], votes: [] },
];

/** The registry holds a forge and a review host; the runtime records the reviews sent. */
const setUp = async () => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor, changeHostDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const ordered = [githubLikeDescriptor(), changeHostDescriptor()];
  useSourceControlProviderRegistry.setState({ ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true });
  const reviews: ReviewChangeRequestInput[] = [];
  const base = createWebAPIs();
  const apis = (): RuntimeAPIs => ({
    ...base,
    sourceControl: {
      ...base.sourceControl,
      changeRequestReview: async (input) => {
        reviews.push(input);
        return {
          status: 'succeeded', replayed: false, result: { commented: false },
          actor: { provider: input.provider, instance: input.instance, providerAccountId: `${input.instance}#7` },
          target: { repositoryId: input.repositoryId, bindingRevision: input.bindingRevision, primaryRemote: input.primaryRemote, project: { id: '1', owner: 'acme', name: 'app' } },
        };
      },
    },
  });
  return { apis, reviews };
};

const render = async (apis: RuntimeAPIs, node: React.ReactNode) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  await act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>{node}</RuntimeAPIContext.Provider></I18nProvider>);
  });
};

const buttons = () => [...host.querySelectorAll('button')];
const buttonNamed = (name: string) => buttons().find((button) => button.textContent?.trim() === name);
const click = async (element: HTMLElement | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
};

describe('reviewing a change request', () => {
  test('a verdict host keeps its two verdict buttons and sends a verdict', async () => {
    const { apis, reviews } = await setUp();
    const { SourceBoardReply } = await import('./SourceBoardReply');
    await render(apis(), <SourceBoardReply reference={pullOn('github')} context={context} onRefresh={() => undefined} />);
    expect(buttons().map((button) => button.textContent?.trim())).toEqual(['Request changes', 'Approve', 'Comment']);
    expect(host.querySelector('[role="group"]')).toBeNull();
    await click(buttonNamed('Approve'));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ verdict: 'approve', target: { number: 12, headSha: 'f'.repeat(40) } });
    expect('votes' in reviews[0]).toBe(false);
  });

  test('a votes host offers the values this account may cast and sends votes, never a verdict', async () => {
    const { apis, reviews } = await setUp();
    const { SourceBoardReply } = await import('./SourceBoardReply');
    await render(apis(), <SourceBoardReply reference={pullOn('review-host')} context={{ ...context, provider: 'review-host' }} onRefresh={() => undefined} voteLabels={voteLabels} />);
    expect(buttonNamed('Approve')).toBeUndefined();
    const group = host.querySelector('[role="group"]');
    expect(group?.textContent).toContain('Code-Review');
    // A label this account may not vote on is left out.
    expect(group?.textContent).not.toContain('Verified');
    expect([...(group?.querySelectorAll('button') ?? [])].map((button) => button.textContent)).toEqual(['-1', '0', '+1']);
    expect(buttonNamed('Vote')?.hasAttribute('disabled')).toBe(true);
    await click(buttonNamed('+1'));
    expect(buttonNamed('+1')?.getAttribute('aria-pressed')).toBe('true');
    await click(buttonNamed('Vote'));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ votes: { 'Code-Review': 1 }, target: { number: 12, headSha: 'f'.repeat(40) } });
    expect('verdict' in reviews[0]).toBe(false);
  });

  test('votes go on the latest revision the change context names, not the listed head', async () => {
    const { apis, reviews } = await setUp();
    const { SourceBoardReply } = await import('./SourceBoardReply');
    const latest = 'a'.repeat(40);
    await render(apis(), (
      <SourceBoardReply reference={pullOn('review-host')} context={{ ...context, provider: 'review-host' }} onRefresh={() => undefined} voteLabels={voteLabels} latestRevision={latest} />
    ));
    await click(buttonNamed('+1'));
    await click(buttonNamed('Vote'));
    expect(reviews[0]).toMatchObject({ votes: { 'Code-Review': 1 }, target: { number: 12, headSha: latest } });
  });

  test('a votes host takes votes on the latest revision only', async () => {
    const { apis } = await setUp();
    const { SourceBoardReply } = await import('./SourceBoardReply');
    await render(apis(), (
      <SourceBoardReply reference={pullOn('review-host')} context={{ ...context, provider: 'review-host' }} onRefresh={() => undefined} voteLabels={voteLabels} onLatestRevision={false} />
    ));
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(buttonNamed('Vote')).toBeUndefined();
    expect(host.textContent).toContain('Votes go on the latest patchset');
  });
});

describe('submitting a change', () => {
  const unmet: ChangeRequestSubmitRequirement[] = [
    { name: 'Code-Review', status: 'unsatisfied' },
    { name: 'No-Unresolved-Comments', status: 'satisfied' },
  ];
  const choice = async (allowed: string[], requirements?: ChangeRequestSubmitRequirement[]) => {
    const { mergeChoiceOf } = await import('./mergeChoice');
    return mergeChoiceOf({ allowed, remembered: 'rebase', checksRequirements: true, requirements });
  };

  test('submit stays disabled while a requirement is unmet, naming only the unmet ones', async () => {
    expect(await choice(['submit'], unmet)).toEqual({ methods: ['submit'], method: 'submit', unmet: [unmet[0]], hold: null, blocked: true });
  });

  test('submit waits until the requirements are read, then is offered once every one is met', async () => {
    expect((await choice(['submit'])).blocked).toBe(true);
    expect(await choice(['submit'], [{ name: 'Code-Review', status: 'satisfied' }, { name: 'Verified', status: 'overridden' }]))
      .toEqual({ methods: ['submit'], method: 'submit', unmet: [], hold: null, blocked: false });
  });

  test('submit holds while the host says the change cannot be submitted, every requirement met', async () => {
    const { mergeChoiceOf } = await import('./mergeChoice');
    const met: ChangeRequestSubmitRequirement[] = [{ name: 'Code-Review', status: 'satisfied' }];
    expect(mergeChoiceOf({ allowed: ['submit'], remembered: 'squash', checksRequirements: true, requirements: met, mergeable: false }))
      .toMatchObject({ unmet: [], hold: 'not-submittable', blocked: true });
    expect(mergeChoiceOf({ allowed: ['submit'], remembered: 'squash', checksRequirements: true, requirements: met, mergeable: null }))
      .toMatchObject({ hold: null, blocked: false });
    // A forge's merge is not held by its own mergeable answer here.
    expect(mergeChoiceOf({ allowed: ['squash'], remembered: 'squash', checksRequirements: false, requirements: undefined, mergeable: false }))
      .toMatchObject({ hold: null, blocked: false });
  });

  test('submit says the requirements could not be read instead of a silent disabled button', async () => {
    const { mergeChoiceOf } = await import('./mergeChoice');
    expect(mergeChoiceOf({ allowed: ['submit'], remembered: 'squash', checksRequirements: true, requirements: undefined, requirementsUnreadable: true }))
      .toMatchObject({ unmet: [], hold: 'unreadable', blocked: true });
    // Still loading: held, with nothing to say yet.
    expect(mergeChoiceOf({ allowed: ['submit'], remembered: 'squash', checksRequirements: true, requirements: undefined }))
      .toMatchObject({ hold: null, blocked: true });
  });

  test('a merge method this version does not know is left out, and a forge keeps its remembered one', async () => {
    expect(await choice(['fast-forward', 'squash', 'rebase'])).toEqual({ methods: ['squash', 'rebase'], method: 'rebase', unmet: [], hold: null, blocked: false });
    expect(await choice(['fast-forward'])).toEqual({ methods: [], method: null, unmet: [], hold: null, blocked: false });
  });
});

describe('submitting a change with open changes below it', () => {
  const layer = (number: number, state: 'open' | 'closed' | 'merged') => ({
    number, title: `Change ${number}`, url: `https://example.com/${number}`, state, draft: false, head: `refs/changes/${number}/1`,
  });
  // A relation chain, bottom first: one merged, two open below change 12, one above it.
  const chain: PullRequestStack = { number: null, base: 'main', layers: [layer(9, 'merged'), layer(10, 'open'), layer(11, 'open'), layer(12, 'open'), layer(13, 'open')] };

  // The Submit button's line and its confirmation name this count; no chain, no line.
  test('submit lands the open changes below in the chain; a merge of a branch chain lands only itself', async () => {
    const { landsWithIt } = await import('./mergeChoice');
    expect(landsWithIt({ stack: chain, number: 12, method: 'submit' }).map((entry) => entry.number)).toEqual([10, 11]);
    expect(landsWithIt({ stack: chain, number: 10, method: 'submit' })).toEqual([]);
    expect(landsWithIt({ stack: null, number: 12, method: 'submit' })).toEqual([]);
    expect(landsWithIt({ stack: chain, number: 12, method: 'squash' })).toEqual([]);
    expect(landsWithIt({ stack: { ...chain, number: 4 }, number: 12, method: 'squash' }).map((entry) => entry.number)).toEqual([10, 11]);
  });
});

describe('the links beside a picked revision', () => {
  test('Changes and Walkthrough read the revision whose counts they sit beside', async () => {
    const { apis } = await setUp();
    const { SourceBoardPullLinks } = await import('./SourceBoardActions');
    const { usePullRequestSelectionStore } = await import('@/stores/usePullRequestSelectionStore');
    const { useWalkthroughStore } = await import('@/stores/useWalkthroughStore');
    const reviewContext = { ...context, provider: 'review-host' };
    const older = 'c'.repeat(40);
    const links = (revision: string | null) => (
      <SourceBoardPullLinks
        pull={pullOn('review-host')}
        project={{ id: 'project-a', path: '/work/app' }}
        repository={null}
        context={reviewContext}
        projectOwnsDirectory={() => true}
        currentDirectory="/work/app"
        revision={revision}
      />
    );
    await render(apis(), links(older));
    await click(buttonNamed('Changes'));
    expect(usePullRequestSelectionStore.getState().diffRequests.get('/work/app'))
      .toEqual({ kind: 'pr', number: 12, sourceRepo: { owner: 'acme', repo: 'app' }, revision: older });
    await click(buttonNamed('Walkthrough'));
    expect(useWalkthroughStore.getState().getRequestedTarget('/work/app')?.source)
      .toEqual({ kind: 'pr', number: 12, sourceRepo: { owner: 'acme', repo: 'app' }, revision: older });

    // The current revision keeps the source it always had.
    await render(apis(), links(null));
    await click(buttonNamed('Changes'));
    expect(usePullRequestSelectionStore.getState().diffRequests.get('/work/app'))
      .toEqual({ kind: 'pr', number: 12, sourceRepo: { owner: 'acme', repo: 'app' } });
  });
});
