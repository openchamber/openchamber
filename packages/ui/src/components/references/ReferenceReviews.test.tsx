import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

import type {
  RepositoryChangeRequestReference,
  RepositoryReferenceReview,
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
const { ReviewRows } = await import('./ReferenceReviews');

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

const reviews: RepositoryReferenceReview[] = [
  { id: 'R1', state: 'approved', author: { login: 'mona' }, submittedAt: null },
  { id: 'R2', state: 'commented', author: { login: 'mona' }, submittedAt: null },
  { id: 'R3', state: 'changes_requested', author: { login: 'hubot' }, submittedAt: null },
];

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
  options: { mode: 'others' | 'own' | null; canUndismiss?: boolean; viewerLogin: string | null; list?: RepositoryReferenceReview[]; onChanged: () => void },
) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={runtime}>
          <ReviewRows
            reviews={options.list ?? reviews}
            mode={options.mode}
            canUndismiss={options.canUndismiss ?? false}
            viewerLogin={options.viewerLogin}
            context={context}
            reference={reference}
            onChanged={options.onChanged}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
};

const actionTriggers = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Review actions"]')];
const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === name);
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

describe('dismissing someone else\'s review', () => {
  test('offers the action only on a review that counts and is not the viewer\'s', async () => {
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { mode: 'others', viewerLogin: 'hubot', onChanged });
    expect(actionTriggers()).toHaveLength(1);
    expect(buttonNamed('Withdraw approval')).toBeUndefined();
  });

  test('takes a reason before it sends, then asks for a refresh', async () => {
    const { apis, sent, changed, onChanged } = await setUp();
    await renderRows(apis(), { mode: 'others', viewerLogin: 'hubot', onChanged });
    await click(actionTriggers()[0]);
    expect(menuItems()).toEqual(['Dismiss review']);
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
    const { I18nProvider } = await import('@/lib/i18n');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    await act(async () => {
      root.render(
        <I18nProvider>
          <RuntimeAPIContext.Provider value={apis()}>
            <ReviewRows
              reviews={reviews}
              mode="others"
              canUndismiss={false}
              viewerLogin={null}
              context={context}
              reference={reference}
              onChanged={onChanged}
            />
          </RuntimeAPIContext.Provider>
        </I18nProvider>,
      );
    });
    expect(actionTriggers()).toHaveLength(0);
  });

  test('a host that names no dismissal mode offers nothing', async () => {
    const { apis, onChanged } = await setUp();
    const { I18nProvider } = await import('@/lib/i18n');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    await act(async () => {
      root.render(
        <I18nProvider>
          <RuntimeAPIContext.Provider value={apis()}>
            <ReviewRows
              reviews={reviews}
              mode={null}
              canUndismiss={false}
              viewerLogin="hubot"
              context={context}
              reference={reference}
              onChanged={onChanged}
            />
          </RuntimeAPIContext.Provider>
        </I18nProvider>,
      );
    });
    expect(actionTriggers()).toHaveLength(0);
    expect(buttonNamed('Withdraw approval')).toBeUndefined();
  });
});

describe('restoring a dismissed review', () => {
  const dismissed: RepositoryReferenceReview[] = [
    { id: 'R7', state: 'dismissed', author: { login: 'mona' }, submittedAt: null },
  ];

  test('a host that can restore offers it on a dismissed review, and sends no reason', async () => {
    const { apis, sent, changed, onChanged } = await setUp();
    await renderRows(apis(), { mode: 'others', canUndismiss: true, viewerLogin: 'hubot', list: dismissed, onChanged });
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
    await renderRows(apis(), { mode: 'others', viewerLogin: 'hubot', list: dismissed, onChanged });
    expect(actionTriggers()).toHaveLength(0);
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
  test('two reviews in the context render two rows with their own actions', async () => {
    const { apis, onChanged } = await setUp();
    const carried = await listBackedPull([
      { id: 'R1', state: 'approved', author: { login: 'mona' }, submittedAt: null },
      { id: 'R2', state: 'changes_requested', author: { login: 'hubot' }, submittedAt: null },
    ]);
    expect(carried).toHaveLength(2);
    await renderRows(apis(), { mode: 'others', viewerLogin: 'ada', list: carried, onChanged });
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(actionTriggers()).toHaveLength(2);
  });

  test('a context without reviews carries none, so no row renders', async () => {
    const carried = await listBackedPull();
    expect(carried).toBeUndefined();
    const { apis, onChanged } = await setUp();
    await renderRows(apis(), { mode: 'others', viewerLogin: 'ada', list: carried ?? [], onChanged });
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(actionTriggers()).toHaveLength(0);
  });
});

describe('withdrawing the viewer\'s own approval', () => {
  test('offers the action on the viewer\'s approved review and sends no reason', async () => {
    const { apis, sent, changed, onChanged } = await setUp();
    const ownReviews: RepositoryReferenceReview[] = [
      { id: 'R9', state: 'approved', author: { login: 'hubot' }, submittedAt: null },
      { id: 'R1', state: 'approved', author: { login: 'mona' }, submittedAt: null },
    ];
    await renderRows(apis(), { mode: 'own', viewerLogin: 'hubot', list: ownReviews, onChanged });
    expect(actionTriggers()).toHaveLength(0);
    expect(buttonNamed('Withdraw approval')).toBeDefined();
    await click(buttonNamed('Withdraw approval'));
    expect(sent).toHaveLength(1);
    expect('reviewId' in sent[0]).toBe(false);
    expect('message' in sent[0]).toBe(false);
    expect(changed()).toBe(1);
  });
});
