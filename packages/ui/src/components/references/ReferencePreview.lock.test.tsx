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
  SetConversationLockInput,
  SourceControlEmptyMutationResult,
  SourceControlMutationReceipt,
  SourceControlReadContext,
} from '@/lib/api/types';

// The preview's Markdown renderer reads the sync runtime; these tests are
// about the lock beside the refresh control.
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

const detailWith = (locked?: boolean, writeAccess?: boolean): RepositoryReferenceDetail => {
  const detail: RepositoryReferenceDetail = { number: 7, comments: [], commentTotal: 0, pull: null };
  if (locked !== undefined) detail.locked = locked;
  if (writeAccess !== undefined) detail.writeAccess = writeAccess;
  return detail;
};

const setProvider = async () => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

type ShowOptions = {
  locked?: boolean;
  writeAccess?: boolean;
  reference?: RepositoryReference;
  writeContext?: SourceControlReadContext | null;
  fail?: boolean;
};

/** Renders the preview and records the locks it sends and the refreshes it asks for. */
const show = async (options: ShowOptions = {}) => {
  const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./ReferencePreview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api'),
  ]);
  await setProvider();
  const base = createWebAPIs();
  const calls: Array<{ method: string; payload: SetConversationLockInput }> = [];
  let refreshes = 0;
  const receipt = async (method: string, payload: SetConversationLockInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>> => {
    calls.push({ method, payload });
    if (options.fail) throw new Error('You may not lock here');
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
      issueSetLock: (payload) => receipt('issueSetLock', payload),
      changeRequestSetLock: (payload) => receipt('changeRequestSetLock', payload),
      discussionSetLock: (payload) => receipt('discussionSetLock', payload),
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
            repositoryDetail={{ status: 'ready', value: detailWith(options.locked, options.writeAccess) }}
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

const lockButton = (name = 'Lock conversation') => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const iconOf = (button: HTMLButtonElement | null) => button?.querySelector('use')?.getAttribute('href');

const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
};

describe('locking a conversation from its preview', () => {
  test('an unlocked conversation offers Lock conversation with the lock icon', async () => {
    await show({ locked: false });
    const button = lockButton();
    if (!button) throw new Error('Expected the lock button');
    expect(iconOf(button)).toBe('#oc-lock');
    expect(lockButton('Unlock conversation')).toBeNull();
  });

  test('clicking sends locked true with the item coordinates, then reads it again', async () => {
    const shown = await show({ locked: false });
    await click(lockButton());
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].method).toBe('issueSetLock');
    const { payload } = shown.calls[0];
    expect(payload.locked).toBe(true);
    expect(payload.target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 7 });
    expect(payload.accountId).toBe('github.com#7');
    expect(payload.repositoryId).toBe('repo-1');
    expect(payload.idempotencyKey.length).toBeGreaterThan(0);
    expect(shown.refreshes()).toBe(1);
    // Nothing flips before the read: the button still offers the same action.
    expect(lockButton()).not.toBeNull();
  });

  test('a locked conversation offers Unlock conversation and sends locked false', async () => {
    const shown = await show({ locked: true });
    const button = lockButton('Unlock conversation');
    if (!button) throw new Error('Expected the unlock button');
    expect(iconOf(button)).toBe('#oc-lock-unlock');
    expect(lockButton()).toBeNull();
    await click(button);
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].payload.locked).toBe(false);
    expect(shown.calls[0].payload.target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 7 });
    expect(shown.refreshes()).toBe(1);
  });

  test('a refusal keeps the button as it was and says why', async () => {
    const shown = await show({ locked: false, fail: true });
    await click(lockButton());
    expect(shown.calls).toHaveLength(1);
    expect(shown.refreshes()).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Could not change the conversation lock on #7');
    expect(errors[0].description).toBe('You may not lock here');
    expect(lockButton()).not.toBeNull();
    expect(iconOf(lockButton())).toBe('#oc-lock');
  });

  test('no button without a write context', async () => {
    await show({ locked: false, writeContext: null });
    expect(lockButton()).toBeNull();
  });

  test('a linked item is only read and offers no lock', async () => {
    await show({ locked: false, reference: { ...issue, linked: true } });
    expect(lockButton()).toBeNull();
  });

  test('a read-only account gets no lock button', async () => {
    await show({ locked: false, writeAccess: false });
    expect(lockButton()).toBeNull();
  });

  test('a detail that does not say whether the conversation is locked offers no lock', async () => {
    await show({});
    expect(lockButton()).toBeNull();
  });

  test('each kind sends its own mutation', async () => {
    for (const [reference, method] of [[pull, 'changeRequestSetLock'], [discussion, 'discussionSetLock']] as const) {
      const shown = await show({ locked: false, reference });
      await click(lockButton());
      expect(shown.calls.map((call) => call.method)).toEqual([method]);
      expect(shown.calls[0].payload.target.number).toBe(reference.number);
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });
});
