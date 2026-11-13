import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import type {
  RepositoryDiscussionReference,
  RepositoryReferenceDetail,
  RuntimeAPIs,
  SetDiscussionUpvoteInput,
  SourceControlReadContext,
} from '@/lib/api/types';

// The preview's Markdown renderer reads the sync runtime; these tests are
// about the vote beside the title.
mock.module('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: ({ content }: { content: string }) => createElement('div', null, content),
}));

const errors: Array<{ message: string; description?: string }> = [];
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string, data?: { description?: string }) => { errors.push({ message, description: data?.description }); },
    success: () => undefined,
    info: () => undefined,
  },
}));

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLImageElement: browser.HTMLImageElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLAnchorElement: browser.HTMLAnchorElement,
  SVGElement: browser.SVGElement, sessionStorage: browser.sessionStorage,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The components' imports pull in app stores that load on import; their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

// react-dom reads whether it runs in a browser when it loads, so it comes after the globals.
const { createRoot } = await import('react-dom/client');

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
  errors.length = 0;
});

const context: SourceControlReadContext = {
  provider: 'github', instance: 'github.com', directory: '/work/app', repositoryId: 'repo-1',
  accountId: 'github.com#7', bindingRevision: 1, primaryRemote: 'origin',
};

const discussion: RepositoryDiscussionReference = {
  kind: 'discussion', provider: 'github', number: 3, title: 'How do we cache', url: 'https://github.com/acme/app/discussions/3',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
  state: 'open', answered: null, upvotes: 3, locked: false, category: { name: 'Ideas', emoji: null, answerable: false },
};

const detailWith = (viewerHasUpvoted?: boolean): RepositoryReferenceDetail => {
  const detail: RepositoryReferenceDetail = { number: 3, comments: [], commentTotal: 0, pull: null };
  if (viewerHasUpvoted !== undefined) detail.viewerHasUpvoted = viewerHasUpvoted;
  return detail;
};

const setProvider = async () => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

type ShowOptions = {
  viewerHasUpvoted?: boolean;
  reference?: RepositoryDiscussionReference;
  writeContext?: SourceControlReadContext | null;
  fail?: boolean;
};

/** Renders the preview and records the votes it sends and the refreshes it asks for. */
const show = async (options: ShowOptions = {}) => {
  const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./ReferencePreview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api'),
  ]);
  await setProvider();
  const base = createWebAPIs();
  const calls: SetDiscussionUpvoteInput[] = [];
  let refreshes = 0;
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      discussionUpvote: async (payload) => {
        calls.push(payload);
        if (options.fail) throw new Error('You may not vote here');
        return {
          status: 'succeeded', replayed: false, result: {},
          actor: { provider: payload.provider, instance: payload.instance, providerAccountId: `${payload.instance}#7` },
          target: {
            repositoryId: payload.repositoryId, bindingRevision: payload.bindingRevision, primaryRemote: payload.primaryRemote,
            project: { id: '1', owner: 'acme', name: 'app' }, number: payload.target.number,
          },
        };
      },
    },
  };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <ReferencePreview
            item={{ source: 'repository', reference: options.reference ?? discussion }}
            directory={null}
            pullStatus={{ status: 'idle' }}
            trackerDetail={{ status: 'idle' }}
            repositoryDetail={{ status: 'ready', value: detailWith(options.viewerHasUpvoted) }}
            purpose="attach"
            pinned={false}
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={0}
            onWriteRefresh={async () => { refreshes += 1; }}
            discussionWriteContext={options.writeContext === undefined ? context : options.writeContext}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  return { calls, refreshes: () => refreshes };
};

const voteButton = (name = 'Upvote') => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
};

describe('voting a discussion up from its preview', () => {
  test('an unanswered vote is an outlined control carrying the count', async () => {
    await show({ viewerHasUpvoted: false });
    const button = voteButton();
    if (!button) throw new Error('Expected the upvote button');
    expect(button.textContent?.trim()).toBe('3');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.className).toContain('border-edge');
    expect(button.className).not.toContain('text-primary');
    // The count lives in the control, not in a second metadata row.
    expect(host.querySelector('dl')?.textContent).not.toContain('Upvotes');
  });

  test('this account\'s own vote is filled in the primary colour', async () => {
    await show({ viewerHasUpvoted: true });
    const button = voteButton('Remove upvote');
    if (!button) throw new Error('Expected the upvote button');
    expect(button.textContent?.trim()).toBe('3');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('text-primary');
    expect(button.className).not.toContain('border-edge');
  });

  test('clicking sends one vote with the item\'s coordinates, then reads it again', async () => {
    const shown = await show({ viewerHasUpvoted: false });
    await click(voteButton());
    expect(shown.calls).toHaveLength(1);
    const payload = shown.calls[0];
    expect(payload.upvoted).toBe(true);
    expect(payload.target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 3 });
    expect(payload.accountId).toBe('github.com#7');
    expect(payload.repositoryId).toBe('repo-1');
    expect(payload.idempotencyKey.length).toBeGreaterThan(0);
    expect(shown.refreshes()).toBe(1);
  });

  test('a refused vote keeps the control and the count as they were, and says why', async () => {
    const shown = await show({ viewerHasUpvoted: false, fail: true });
    await click(voteButton());
    expect(shown.calls).toHaveLength(1);
    expect(shown.refreshes()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Could not change the upvote on #3');
    expect(errors[0].description).toBe('You may not vote here');
    const button = voteButton();
    if (!button) throw new Error('Expected the upvote button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.textContent?.trim()).toBe('3');
  });

  test('no control without a write context; the count stays a plain label', async () => {
    await show({ viewerHasUpvoted: false, writeContext: null });
    expect(voteButton()).toBeNull();
    expect(host.querySelector('dl')?.textContent).toContain('Upvotes');
    expect(host.querySelector('dl')?.textContent).toContain('3');
  });

  test('a linked discussion reads its count and offers no vote', async () => {
    await show({ viewerHasUpvoted: false, reference: { ...discussion, linked: true } });
    expect(voteButton()).toBeNull();
    expect(host.querySelector('dl')?.textContent).toContain('Upvotes');
  });

  test('a detail that does not say how this account voted offers no vote', async () => {
    await show({});
    expect(voteButton()).toBeNull();
    expect(host.querySelector('dl')?.textContent).toContain('3');
  });
});
