import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import type {
  RepositoryChangeRequestReference,
  RepositoryDiscussionReference,
  RepositoryIssueReference,
  RepositoryReference,
  RepositoryReferenceDetail,
  RuntimeAPIs,
  SetItemSubscriptionInput,
  SourceControlEmptyMutationResult,
  SourceControlMutationReceipt,
  SourceControlReadContext,
} from '@/lib/api/types';

// The preview's Markdown renderer reads the sync runtime; these tests are
// about the bell beside the lock control.
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

const repository = { owner: 'acme', repo: 'app', source: 'origin' };

const issue: RepositoryIssueReference = {
  kind: 'issue', provider: 'github', number: 7, title: 'Cache invalidation', url: 'https://github.com/acme/app/issues/7',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: null, labels: [], commentCount: 0,
  sourceRepo: repository, state: 'open',
};

const pull: RepositoryChangeRequestReference = {
  ...issue, kind: 'pull', number: 9, title: 'Cache the app', url: 'https://github.com/acme/app/pull/9',
  state: 'open', draft: false, head: 'feature/cache', base: 'main', headSha: 'abc123', headRepo: null,
};

const discussion: RepositoryDiscussionReference = {
  ...issue, kind: 'discussion', number: 3, title: 'How do we cache', url: 'https://github.com/acme/app/discussions/3',
  state: 'open', answered: null, upvotes: 0, locked: false, category: { name: 'Ideas', emoji: null, answerable: false },
};

const detailWith = (subscribed?: boolean): RepositoryReferenceDetail => {
  const detail: RepositoryReferenceDetail = { number: 7, comments: [], commentTotal: 0, pull: null };
  if (subscribed !== undefined) detail.viewerSubscribed = subscribed;
  return detail;
};

const setProvider = async () => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

type ShowOptions = {
  subscribed?: boolean;
  reference?: RepositoryReference;
  writeContext?: SourceControlReadContext | null;
  fail?: boolean;
};

/** Renders the preview and records the subscriptions it sends and the refreshes it asks for. */
const show = async (options: ShowOptions = {}) => {
  const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./ReferencePreview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api'),
  ]);
  await setProvider();
  const base = createWebAPIs();
  const calls: Array<{ method: string; payload: SetItemSubscriptionInput }> = [];
  let refreshes = 0;
  const receipt = async (method: string, payload: SetItemSubscriptionInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>> => {
    calls.push({ method, payload });
    if (options.fail) throw new Error('You may not follow here');
    return {
      status: 'succeeded', replayed: false, result: {},
      actor: { provider: payload.provider, instance: payload.instance, providerAccountId: `${payload.instance}#7` },
      target: {
        repositoryId: payload.repositoryId, bindingRevision: payload.bindingRevision, primaryRemote: payload.primaryRemote,
        project: { id: '1', owner: 'acme', name: 'app' }, number: payload.target.number,
      },
    };
  };
  const apis: RuntimeAPIs = {
    ...base,
    sourceControl: {
      ...base.sourceControl,
      issueSetSubscription: (payload) => receipt('issueSetSubscription', payload),
      changeRequestSetSubscription: (payload) => receipt('changeRequestSetSubscription', payload),
      discussionSetSubscription: (payload) => receipt('discussionSetSubscription', payload),
    },
  };
  const reference = options.reference ?? issue;
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <ReferencePreview
            item={{ source: 'repository', reference }}
            directory={null}
            pullStatus={{ status: 'idle' }}
            trackerDetail={{ status: 'idle' }}
            repositoryDetail={{ status: 'ready', value: detailWith(options.subscribed) }}
            purpose="attach"
            pinned={false}
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={0}
            onRefresh={async () => { refreshes += 1; }}
            conversationWriteContext={options.writeContext === undefined ? context : options.writeContext}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  return { calls, refreshes: () => refreshes };
};

const subscribeButton = (name = 'Subscribe') => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const iconOf = (button: HTMLButtonElement | null) => button?.querySelector('use')?.getAttribute('href');

const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
};

describe('following a conversation from its preview', () => {
  test('an item this account does not follow offers Subscribe with the bell icon', async () => {
    await show({ subscribed: false });
    const button = subscribeButton();
    if (!button) throw new Error('Expected the subscribe button');
    expect(iconOf(button)).toBe('#oc-notification-3');
    expect(subscribeButton('Unsubscribe')).toBeNull();
  });

  test('clicking sends subscribed true with the item coordinates, then reads it again', async () => {
    const shown = await show({ subscribed: false });
    await click(subscribeButton());
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].method).toBe('issueSetSubscription');
    const { payload } = shown.calls[0];
    expect(payload.subscribed).toBe(true);
    expect(payload.target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 7 });
    expect(payload.accountId).toBe('github.com#7');
    expect(payload.repositoryId).toBe('repo-1');
    expect(payload.idempotencyKey.length).toBeGreaterThan(0);
    expect(shown.refreshes()).toBe(1);
    // Nothing flips before the read: the button still offers the same action.
    expect(subscribeButton()).not.toBeNull();
  });

  test('an item this account follows offers Unsubscribe and sends subscribed false', async () => {
    const shown = await show({ subscribed: true });
    const button = subscribeButton('Unsubscribe');
    if (!button) throw new Error('Expected the unsubscribe button');
    expect(iconOf(button)).toBe('#oc-notification-off');
    expect(subscribeButton()).toBeNull();
    await click(button);
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].payload.subscribed).toBe(false);
    expect(shown.calls[0].payload.target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 7 });
    expect(shown.refreshes()).toBe(1);
  });

  test('a refusal keeps the bell as it was and says why', async () => {
    const shown = await show({ subscribed: false, fail: true });
    await click(subscribeButton());
    expect(shown.calls).toHaveLength(1);
    expect(shown.refreshes()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Could not change the subscription on #7');
    expect(errors[0].description).toBe('You may not follow here');
    expect(subscribeButton()).not.toBeNull();
    expect(iconOf(subscribeButton())).toBe('#oc-notification-3');
  });

  test('no button without a write context', async () => {
    await show({ subscribed: false, writeContext: null });
    expect(subscribeButton()).toBeNull();
    expect(subscribeButton('Unsubscribe')).toBeNull();
  });

  test('a linked item is only read and offers no bell', async () => {
    await show({ subscribed: false, reference: { ...issue, linked: true } });
    expect(subscribeButton()).toBeNull();
  });

  test('a detail that does not say whether the item is followed offers no bell', async () => {
    await show({});
    expect(subscribeButton()).toBeNull();
  });

  test('each kind sends its own mutation', async () => {
    for (const [reference, method] of [[pull, 'changeRequestSetSubscription'], [discussion, 'discussionSetSubscription']] as const) {
      const shown = await show({ subscribed: false, reference });
      await click(subscribeButton());
      expect(shown.calls.map((call) => call.method)).toEqual([method]);
      expect(shown.calls[0].payload.target.number).toBe(reference.number);
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });
});
