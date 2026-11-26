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
const pullOn = (provider: string, state: RepositoryChangeRequestReference['state'] = 'open'): RepositoryChangeRequestReference => ({
  kind: 'pull', provider, number: 12, title: 'Login flow', url: 'https://example.com/12',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state, draft: false, head: 'feature', base: 'main', headSha: 'f'.repeat(40), headRepo: null,
});

const person = (login: string): RepositoryReferenceReviewer => ({ id: `id-${login}`, login });

const detailWith = (reviewers: RepositoryReferenceReviewer[]): CachedValue<RepositoryReferenceDetail> => ({
  status: 'ready',
  value: {
    number: 12,
    comments: [],
    commentTotal: 0,
    pull: {
      reviewDecision: null, reviewers, additions: 1, deletions: 0, changedFiles: 1, commits: [], commitTotal: null,
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

const pencil = () => host.querySelector('button[aria-label="Edit reviewers"]');

describe('the reviewer picker of a reviews row', () => {
  test('an open change request shows the pencil beside the people', async () => {
    const { SourceBoardReviewerPicker } = await import('./SourceBoardMetaEditors');
    await render(await setUp(), (
      <SourceBoardReviewerPicker
        pull={pullOn('github')}
        detail={detailWith([person('ada')])}
        context={context}
        onChanged={() => undefined}
      />
    ));
    expect(pencil()).not.toBeNull();
  });

  test('a change request that is not open offers no picker', async () => {
    const { SourceBoardReviewerPicker } = await import('./SourceBoardMetaEditors');
    await render(await setUp(), (
      <SourceBoardReviewerPicker
        pull={pullOn('github', 'merged')}
        detail={detailWith([person('ada')])}
        context={context}
        onChanged={() => undefined}
      />
    ));
    expect(pencil()).toBeNull();
  });

  test('while the detail is still loading the picker waits', async () => {
    const { SourceBoardReviewerPicker } = await import('./SourceBoardMetaEditors');
    await render(await setUp(), (
      <SourceBoardReviewerPicker
        pull={pullOn('github')}
        detail={{ status: 'loading' }}
        context={context}
        onChanged={() => undefined}
      />
    ));
    expect(pencil()).toBeNull();
  });
});
