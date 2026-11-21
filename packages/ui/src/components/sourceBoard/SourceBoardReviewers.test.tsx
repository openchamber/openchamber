import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { CachedValue } from '@/components/references/referenceCache';
import type {
  RepositoryChangeRequestReference,
  RepositoryReferenceDetail,
  RepositoryReferenceReviewer,
  RuntimeAPIs,
  SourceControlReadContext,
} from '@/lib/api/types';
import type { ReviewerStateValue } from '@/lib/source-control/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The component's imports pull in app stores that load on import; their requests never answer.
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

const person = (login: string): RepositoryReferenceReviewer => ({ id: `id-${login}`, login });

const detailWith = (
  pull: Partial<NonNullable<RepositoryReferenceDetail['pull']>>,
): CachedValue<RepositoryReferenceDetail> => ({
  status: 'ready',
  value: {
    number: 12,
    comments: [],
    commentTotal: 0,
    pull: {
      reviewDecision: null, reviewers: [], additions: 1, deletions: 0, changedFiles: 1, commits: [], commitTotal: null,
      ...pull,
    },
  },
});

const setUp = async (): Promise<RuntimeAPIs> => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const ordered = [githubLikeDescriptor()];
  useSourceControlProviderRegistry.setState({ ordered, byId: new Map(ordered.map((entry) => [entry.id, entry])), status: 'ready', holdsList: true });
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  return createWebAPIs();
};

const render = async (apis: RuntimeAPIs, node: React.ReactNode) => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  await act(async () => {
    root.render(<I18nProvider><RuntimeAPIContext.Provider value={apis}>{node}</RuntimeAPIContext.Provider></I18nProvider>);
  });
};

/** One rendered reviewer with a state: what it says, and the glyph it shows. */
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

describe('the reviewers row of a change request', () => {
  test('each person keeps the host order and shows the state they gave', async () => {
    const { SourceBoardReviewers } = await import('./SourceBoardMetaEditors');
    const responses: { person: RepositoryReferenceReviewer; state: ReviewerStateValue }[] = [
      { person: person('ada'), state: 'approved' },
      { person: person('grace'), state: 'changes_requested' },
      { person: person('linus'), state: 'commented' },
      { person: person('margaret'), state: 'pending' },
      { person: person('alan'), state: 'dismissed' },
    ];
    await render(await setUp(), (
      <SourceBoardReviewers
        pull={pullOn('github')}
        detail={detailWith({
          reviewers: responses.map(({ person: reviewer }) => reviewer),
          reviewerStates: responses.map(({ person: reviewer, state }) => ({ ...reviewer, state })),
        })}
        context={context}
        onChanged={() => undefined}
      />
    ));

    const rows = stateRows();
    expect(rows.map((row) => row.state)).toEqual(['approved', 'changes_requested', 'commented', 'pending', 'dismissed']);
    expect(rows.map((row) => row.login)).toEqual(['ada', 'grace', 'linus', 'margaret', 'alan']);
    expect(rows.map((row) => row.icon)).toEqual([
      '#oc-checkbox-circle', '#oc-error-warning', '#oc-chat-3', '#oc-time', '#oc-eye-off',
    ]);
    // The tooltip and the name behind it say the same state, so a marker never
    // reads as a bare colour.
    expect(rows.map((row) => row.title)).toEqual([
      'Approved', 'Changes requested', 'Commented', 'Awaiting review', 'Dismissed',
    ]);
    expect(rows.map((row) => `${row.login} ${row.label}`)).toEqual([
      'ada Approved', 'grace Changes requested', 'linus Commented', 'margaret Awaiting review', 'alan Dismissed',
    ]);
    // Editing the asked set stays where it was.
    expect(host.querySelector('button[aria-label="Edit reviewers"]')).not.toBeNull();
  });

  test('an asked reviewer the host gave no state for stays in the row without a marker', async () => {
    const { SourceBoardReviewers } = await import('./SourceBoardMetaEditors');
    await render(await setUp(), (
      <SourceBoardReviewers
        pull={pullOn('github')}
        detail={detailWith({
          reviewers: [person('ada'), person('grace'), person('linus')],
          reviewerStates: [{ ...person('ada'), state: 'approved' }],
        })}
        context={context}
        onChanged={() => undefined}
      />
    ));

    expect(stateRows().map((row) => [row.login, row.state])).toEqual([['ada', 'approved']]);
    expect(host.textContent).toContain('grace');
    expect(host.textContent).toContain('linus');
    expect(host.textContent).not.toContain('None');
  });

  test('a host that answers with no states still shows the asked reviewers', async () => {
    const { SourceBoardReviewers } = await import('./SourceBoardMetaEditors');
    await render(await setUp(), (
      <SourceBoardReviewers
        pull={pullOn('github')}
        detail={detailWith({ reviewers: [person('ada')], reviewerStates: [] })}
        context={context}
        onChanged={() => undefined}
      />
    ));

    expect(host.textContent).toContain('ada');
    expect(stateRows()).toEqual([]);
  });

  test('a host that does not say keeps the asked reviewers and no marker', async () => {
    const { SourceBoardReviewers } = await import('./SourceBoardMetaEditors');
    await render(await setUp(), (
      <SourceBoardReviewers
        pull={pullOn('github')}
        detail={detailWith({ reviewers: [person('ada'), person('grace')] })}
        context={context}
        onChanged={() => undefined}
      />
    ));

    expect(host.textContent).toContain('ada');
    expect(host.textContent).toContain('grace');
    expect(stateRows()).toEqual([]);
    expect(host.querySelector('.sr-only')).toBeNull();
    expect(host.querySelector('button[aria-label="Edit reviewers"]')).not.toBeNull();
  });
});
