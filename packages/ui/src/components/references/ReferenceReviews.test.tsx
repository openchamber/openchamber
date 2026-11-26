import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

import type {
  RepositoryChangeRequestReference,
  RepositoryReferenceDetail,
  RepositoryReferenceReview,
  RepositoryReferenceReviewer,
  ReviewDismissInput,
  RuntimeAPIs,
  SourceControlReadContext,
} from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');
const { ReferenceReviews, ReviewerRows } = await import('./ReferenceReviews');
const { mergeReviewerEntries } = await import('./reviewerEntries');

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

const reference: RepositoryChangeRequestReference = {
  kind: 'pull', provider: 'github', number: 12, title: 'Login flow', url: 'https://github.com/acme/app/pull/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
};

type Pull = NonNullable<RepositoryReferenceDetail['pull']>;

const pullOf = (overrides: Partial<Pull> = {}): Pull => ({
  reviewDecision: null, reviewers: [], additions: 0, deletions: 0, changedFiles: 0, commits: [], commitTotal: null,
  ...overrides,
});

const person = (login: string): RepositoryReferenceReviewer => ({ id: `id-${login}`, login });
const review = (id: string, state: RepositoryReferenceReview['state'], login: string): RepositoryReferenceReview => ({
  id, state, author: { login }, submittedAt: null,
});

const receipt = (input: ReviewDismissInput) => ({
  status: 'succeeded' as const,
  replayed: false,
  result: {},
  actor: { provider: input.provider, instance: input.instance, providerAccountId: `${input.instance}#7` },
  target: {
    repositoryId: input.repositoryId,
    bindingRevision: input.bindingRevision,
    primaryRemote: input.primaryRemote,
    project: { id: '1', owner: 'acme', name: 'app' },
    number: input.target.number,
  },
});

const setUp = async () => {
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const sent: ReviewDismissInput[] = [];
  let changed = 0;
  const base = createWebAPIs();
  const apis = (): RuntimeAPIs => ({
    ...base,
    sourceControl: {
      ...base.sourceControl,
      changeRequestDismissReview: async (input) => {
        sent.push(input);
        return receipt(input);
      },
    },
  });
  const onChanged = () => { changed += 1; };
  return { apis, sent, changed: () => changed, onChanged };
};

const renderRows = async (
  runtime: RuntimeAPIs,
  options: { pull: Pull; mode: 'others' | 'own' | null; canUndismiss?: boolean; viewerLogin: string | null; onChanged: () => void },
) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const entries = mergeReviewerEntries(options.pull);
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={runtime}>
          <ReviewerRows
            entries={entries}
            mode={options.mode}
            canUndismiss={options.canUndismiss ?? false}
            viewerLogin={options.viewerLogin}
            target={{ context, onChanged: options.onChanged }}
            reference={reference}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
};

const stateRows = () => [...host.querySelectorAll<HTMLElement>('[data-reviewer-state]')].map((row) => {
  const label = row.querySelector('.sr-only')?.textContent ?? '';
  return {
    state: row.getAttribute('data-reviewer-state'),
    login: row.textContent?.replace(label, '').trim(),
    label,
    title: row.getAttribute('title'),
    icon: row.querySelector('use')?.getAttribute('href'),
  };
});
const actionTriggers = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Review actions"]')];
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogButton = (name: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.trim() === name);
const dialogField = () => dialog()?.querySelector<HTMLTextAreaElement>('textarea');

const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
};

const typeInto = async (element: HTMLTextAreaElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  await act(async () => {
    setValue?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const showPreviewRows = async (
  runtime: RuntimeAPIs,
  options: { pull: Pull; onChanged?: () => void; actions?: boolean; linked?: boolean; reviewersControl?: boolean },
) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const { getSourceControlAuthKey, useSourceControlAuthStore } = await import('@/stores/useSourceControlAuthStore');
  const descriptor = {
    ...githubLikeDescriptor(),
    capabilities: { reviewThreads: { start: false, reply: true, resolve: true }, reviewDismiss: 'others' as const, reviewUndismiss: true },
  };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
  const user = { provider: 'github', instance: 'github.com', id: '7', username: 'hubot' };
  useSourceControlAuthStore.setState({
    entries: {
      [getSourceControlAuthKey(context)]: {
        status: {
          provider: 'github', instance: 'github.com', status: 'connected', connected: true, user,
          accounts: [{ id: context.accountId, credentialId: 'c1', credentialRevision: 1, providerUserId: '7', providerUserStatus: 'available', user, current: true, source: 'pat', status: 'valid' }],
        },
        isLoading: false,
        hasChecked: true,
      },
    },
  });
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={runtime}>
          <ReferenceReviews
            pull={options.pull}
            reference={options.linked ? { ...reference, linked: true } : reference}
            reviewersControl={options.reviewersControl ? <span>picker</span> : undefined}
            actions={options.actions === false ? undefined : { context, onChanged: options.onChanged ?? (() => undefined) }}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
};

describe('who sees the review actions in a preview', () => {
  const withDismissAccess = (pull: Pull, canDismissReviews?: boolean): Pull => {
    if (canDismissReviews !== undefined) pull.canDismissReviews = canDismissReviews;
    return pull;
  };
  const approved = (canDismissReviews?: boolean) => withDismissAccess(pullOf({
    reviewerStates: [{ ...person('mona'), state: 'approved' }],
    reviews: [review('R1', 'approved', 'mona')],
  }), canDismissReviews);
  const dismissed = (canDismissReviews?: boolean) => withDismissAccess(pullOf({
    reviewerStates: [{ ...person('mona'), state: 'pending' }],
    reviews: [review('R7', 'dismissed', 'mona')],
  }), canDismissReviews);
  const remount = async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
  };

  test('a permitted account gets the dismiss and the restore', async () => {
    const { apis } = await setUp();
    await showPreviewRows(apis(), { pull: approved(true) });
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Dismiss review']);

    await remount();
    await showPreviewRows(apis(), { pull: dismissed(true) });
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Restore review']);
  });

  // GitHub refuses a read-only or Triage account, Gitea and Forgejo a non-admin or a closed pull
  // request: the host answers false for each, and the row keeps the roster without a menu.
  test('a refused account sees the roster without any action', async () => {
    const { apis, sent } = await setUp();
    await showPreviewRows(apis(), { pull: approved(false) });
    expect(stateRows().map((row) => row.login)).toEqual(['mona']);
    expect(actionTriggers()).toHaveLength(0);

    await remount();
    await showPreviewRows(apis(), { pull: dismissed(false) });
    expect(actionTriggers()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test('a host that does not say whether the account may dismiss offers nothing', async () => {
    const { apis } = await setUp();
    await showPreviewRows(apis(), { pull: approved() });
    expect(actionTriggers()).toHaveLength(0);
  });

  test('a linked preview, or a caller without a write context, offers nothing', async () => {
    const { apis } = await setUp();
    await showPreviewRows(apis(), { pull: approved(true), linked: true });
    expect(stateRows().map((row) => row.login)).toEqual(['mona']);
    expect(actionTriggers()).toHaveLength(0);

    await remount();
    await showPreviewRows(apis(), { pull: approved(true), actions: false });
    expect(actionTriggers()).toHaveLength(0);
  });
});

describe('an empty reviews row', () => {
  test('says None only when the host confirmed nobody reviewed', async () => {
    const { apis } = await setUp();
    await showPreviewRows(apis(), { pull: pullOf({ reviews: [] }), reviewersControl: true });
    expect(host.textContent).toContain('None');

    await act(async () => root.unmount());
    root = createRoot(host);
    await showPreviewRows(apis(), { pull: pullOf(), reviewersControl: true });
    expect(host.textContent).toContain('picker');
    expect(host.textContent).not.toContain('None');
  });

  test('keeps the requested reviewers when their reviews could not be read', async () => {
    const { apis } = await setUp();
    await showPreviewRows(apis(), { pull: pullOf({ reviewers: [person('ada')] }) });
    expect(host.textContent).toContain('ada');
    expect(host.textContent).not.toContain('None');
    expect(stateRows()).toEqual([]);
  });
});

describe('the merged reviews row', () => {
  test('one entry per person, ordered changes requested, approved, commented, awaiting', async () => {
    const { apis, onChanged } = await setUp();
    const pull = pullOf({
      reviewers: [person('grace')],
      reviewerStates: [
        { ...person('margaret'), state: 'pending' },
        { ...person('ada'), state: 'approved' },
        { ...person('grace'), state: 'changes_requested' },
        { ...person('linus'), state: 'commented' },
      ],
    });
    await renderRows(apis(), { pull, mode: 'others', viewerLogin: 'hubot', onChanged });

    const rows = stateRows();
    expect(rows.map((row) => [row.login, row.state])).toEqual([
      ['grace', 'changes_requested'], ['ada', 'approved'], ['linus', 'commented'], ['margaret', 'pending'],
    ]);
    expect(rows.map((row) => row.icon)).toEqual([
      '#oc-error-warning', '#oc-checkbox-circle', '#oc-chat-3', '#oc-time',
    ]);
    expect(rows.map((row) => row.title)).toEqual([
      'Changes requested', 'Approved', 'Commented', 'Awaiting review',
    ]);
  });

  test('a person with several review records still reads as one entry', async () => {
    const pull = pullOf({
      reviews: [review('R1', 'approved', 'mona'), review('R2', 'commented', 'mona')],
    });
    const entries = mergeReviewerEntries(pull);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reviews).toHaveLength(2);
    expect(entries[0]?.state).toBe('approved');

    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { pull, mode: 'others', viewerLogin: 'hubot', onChanged });
    expect(stateRows().map((row) => row.login)).toEqual(['mona']);
  });

  test('a review record outranks the pending state of a request', async () => {
    const pull = pullOf({
      reviewerStates: [{ ...person('mona'), state: 'pending' }],
      reviews: [review('R1', 'approved', 'mona')],
    });
    expect(mergeReviewerEntries(pull)[0]?.state).toBe('approved');

    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { pull, mode: 'others', viewerLogin: 'hubot', onChanged });
    expect(stateRows()[0]).toMatchObject({ state: 'approved', login: 'mona', icon: '#oc-checkbox-circle' });
  });

  test('a requested reviewer with no review record awaits review and carries no menu', async () => {
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), {
      pull: pullOf({ reviewers: [person('ada'), person('grace')], reviewerStates: [{ ...person('ada'), state: 'approved' }] }),
      mode: 'others', viewerLogin: 'hubot', onChanged,
    });

    expect(stateRows().map((row) => [row.login, row.state])).toEqual([['ada', 'approved'], ['grace', 'pending']]);
    expect(stateRows()[1]?.icon).toBe('#oc-time');
    expect(actionTriggers()).toHaveLength(0);
  });

  test('a host with no review surface keeps the plain requested reviewers', async () => {
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), {
      pull: pullOf({ reviewers: [person('ada'), person('grace')] }),
      mode: 'others', viewerLogin: 'hubot', onChanged,
    });

    expect(host.textContent).toContain('ada');
    expect(host.textContent).toContain('grace');
    expect(stateRows()).toEqual([]);
    expect(host.querySelector('.sr-only')).toBeNull();
    expect(actionTriggers()).toHaveLength(0);
  });
});

describe('dismissing someone else\'s review', () => {
  const reviewed = () => pullOf({
    reviewerStates: [{ ...person('mona'), state: 'approved' }],
    reviews: [review('R1', 'approved', 'mona')],
  });

  test('the review record puts its action in the person\'s menu', async () => {
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { pull: reviewed(), mode: 'others', viewerLogin: 'hubot', onChanged });
    expect(stateRows().map((row) => row.login)).toEqual(['mona']);
    expect(actionTriggers()).toHaveLength(1);
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Dismiss review']);
  });

  test('takes a reason before it sends, then asks for a refresh', async () => {
    const { apis, sent, changed, onChanged } = await setUp();
    await renderRows(apis(), { pull: reviewed(), mode: 'others', viewerLogin: 'hubot', onChanged });
    await click(actionTriggers()[0]);
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]);
    expect(dialogButton('Dismiss review')?.hasAttribute('disabled')).toBe(true);
    await typeInto(dialogField()!, 'Superseded by the rewrite');
    expect(dialogButton('Dismiss review')?.hasAttribute('disabled')).toBe(false);
    await click(dialogButton('Dismiss review'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ reviewId: 'R1', message: 'Superseded by the rewrite' });
    expect(changed()).toBe(1);
  });

  test('without a viewer to compare against, no review is offered', async () => {
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { pull: reviewed(), mode: 'others', viewerLogin: null, onChanged });
    expect(actionTriggers()).toHaveLength(0);
  });

  test('a host that names no dismissal mode offers nothing', async () => {
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { pull: reviewed(), mode: null, viewerLogin: 'hubot', onChanged });
    expect(actionTriggers()).toHaveLength(0);
  });
});

describe('restoring a dismissed review', () => {
  const dismissed = () => pullOf({
    reviewerStates: [{ ...person('mona'), state: 'pending' }],
    reviews: [review('R7', 'dismissed', 'mona')],
  });

  test('a dismissed record reads as dismissed and a host that can restore offers it', async () => {
    const { apis, sent, changed, onChanged } = await setUp();
    await renderRows(apis(), { pull: dismissed(), mode: 'others', canUndismiss: true, viewerLogin: 'hubot', onChanged });

    const row = stateRows()[0];
    expect(row).toMatchObject({ state: 'dismissed', login: 'mona', title: 'Dismissed', icon: '#oc-eye-off' });
    expect(actionTriggers()).toHaveLength(1);
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Restore review']);
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ reviewId: 'R7', dismissed: false });
    expect('message' in sent[0]).toBe(false);
    expect(changed()).toBe(1);
  });

  test('a host that cannot restore leaves a dismissed review without an action', async () => {
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { pull: dismissed(), mode: 'others', viewerLogin: 'hubot', onChanged });
    expect(actionTriggers()).toHaveLength(0);
  });

  test('an earlier approval next to a dismissal offers only the restore', async () => {
    const { apis, onChanged } = await setUp();
    const pull = pullOf({
      reviewerStates: [{ ...person('mona'), state: 'pending' }],
      reviews: [review('R7', 'dismissed', 'mona'), review('R1', 'approved', 'mona')],
    });
    await renderRows(apis(), { pull, mode: 'others', canUndismiss: true, viewerLogin: 'hubot', onChanged });
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Restore review']);
  });

  test('a newer approval next to a dismissed record offers only the dismiss', async () => {
    const { apis, onChanged } = await setUp();
    const pull = pullOf({
      reviewerStates: [{ ...person('mona'), state: 'pending' }],
      reviews: [review('R2', 'approved', 'mona'), review('R7', 'dismissed', 'mona')],
    });
    await renderRows(apis(), { pull, mode: 'others', canUndismiss: true, viewerLogin: 'hubot', onChanged });
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Dismiss review']);
  });
});

describe('withdrawing the viewer\'s own approval', () => {
  test('offers the action in the viewer\'s menu and sends no reason', async () => {
    const { apis, sent, changed, onChanged } = await setUp();
    const pull = pullOf({
      reviews: [review('R9', 'approved', 'hubot'), review('R1', 'approved', 'mona')],
    });
    await renderRows(apis(), { pull, mode: 'own', viewerLogin: 'hubot', onChanged });

    expect(stateRows().map((row) => row.login)).toEqual(['hubot', 'mona']);
    expect(actionTriggers()).toHaveLength(1);
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Withdraw approval']);
    await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]);
    expect(sent).toHaveLength(1);
    expect('reviewId' in sent[0]).toBe(false);
    expect('message' in sent[0]).toBe(false);
    expect(changed()).toBe(1);
  });
});

const listBackedPull = async (reviews?: RepositoryReferenceReview[]) => {
  const { fetchListBackedReferenceDetail } = await import('./listBackedReferences');
  const reads = {
    issuesList: async () => ({ items: [], page: 1, hasMore: false }),
    changeRequestsList: async () => ({ items: [], page: 1, hasMore: false }),
    issueComments: async () => [],
    issueGet: async () => null,
    changeRequestContext: async () => {
      const body = {
        identity: { provider: 'gitlab' as const, instance: 'https://gitlab.com' },
        project: null,
        changeRequest: null,
        issueComments: [],
        reviewComments: [],
        files: [],
      };
      return reviews ? { ...body, reviews } : body;
    },
  };
  const detail = await fetchListBackedReferenceDetail(
    reads,
    { provider: 'gitlab', instance: 'https://gitlab.com', directory: '/repo', repositoryId: 'repo-1', accountId: 'gitlab.com#1', bindingRevision: 1, primaryRemote: 'origin' },
    { ...reference, provider: 'gitlab', url: 'https://gitlab.com/acme/app/-/merge_requests/12' },
  );
  return detail.pull?.reviews;
};

describe('the reviews a list-backed preview carries', () => {
  test('the reviews it read become entries with their states', async () => {
    const carried = await listBackedPull([
      review('R1', 'approved', 'mona'),
      review('R2', 'changes_requested', 'hubot'),
    ]);
    expect(carried).toHaveLength(2);
    expect(mergeReviewerEntries(pullOf({ reviews: carried })).map((entry) => [entry.person.login, entry.state]))
      .toEqual([['hubot', 'changes_requested'], ['mona', 'approved']]);
  });

  test('a context without reviews carries none, so the row stays empty', async () => {
    const carried = await listBackedPull();
    expect(carried).toBeUndefined();
    expect(mergeReviewerEntries(pullOf())).toEqual([]);
  });
});
