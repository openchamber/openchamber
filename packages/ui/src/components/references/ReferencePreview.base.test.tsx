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
  SetChangeRequestBaseInput,
  SourceControlEmptyMutationResult,
  SourceControlMutationReceipt,
  SourceControlReadContext,
} from '@/lib/api/types';

// The preview's Markdown renderer reads the sync runtime; these tests are
// about the base branch beside the branch itself.
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

const detail: RepositoryReferenceDetail = { number: 9, comments: [], commentTotal: 0, pull: null };

const setProvider = async (baseChange = true) => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const current = githubLikeDescriptor();
  const descriptor = baseChange ? current : { ...current, features: { ...current.features, baseChange: false } };
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

type ShowOptions = {
  reference?: RepositoryReference;
  writeContext?: SourceControlReadContext | null;
  baseChange?: boolean;
  branches?: string[] | Error;
  failWrite?: boolean;
  /** Holds the branch read open so the popup's loading state can be seen. */
  holdBranches?: boolean;
};

/** Renders the preview and records the base changes it sends and the refreshes it asks for. */
const show = async (options: ShowOptions = {}) => {
  const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./ReferencePreview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api'),
  ]);
  await setProvider(options.baseChange ?? true);
  const base = createWebAPIs();
  const calls: SetChangeRequestBaseInput[] = [];
  let refreshes = 0;
  let releaseBranches: ((names: string[]) => void) | null = null;
  const readBranches = async (): Promise<string[]> => {
    if (options.branches instanceof Error) throw options.branches;
    const names = options.branches ?? ['main', 'develop', 'release/1.0'];
    if (!options.holdBranches) return names;
    return new Promise<string[]>((resolve) => { releaseBranches = (next) => resolve(next ?? names); });
  };
  const receipt = async (payload: SetChangeRequestBaseInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>> => {
    calls.push(payload);
    if (options.failWrite) throw new Error('You may not change the base here');
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
      projectBranches: readBranches,
      changeRequestSetBase: (payload) => receipt(payload),
    },
  };
  const reference = options.reference ?? pull;
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <ReferencePreview
            item={{ source: 'repository', reference }}
            directory={null}
            pullStatus={{ status: 'idle' }}
            trackerDetail={{ status: 'idle' }}
            repositoryDetail={{ status: 'ready', value: detail }}
            purpose="attach"
            pinned={false}
            includeDiff={false}
            onIncludeDiffChange={() => undefined}
            now={0}
            onWriteRefresh={async () => { refreshes += 1; }}
            conversationWriteContext={options.writeContext === undefined ? context : options.writeContext}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  return {
    calls,
    refreshes: () => refreshes,
    releaseBranches: (names: string[]) => { releaseBranches?.(names); },
  };
};

const pencil = () => host.querySelector<HTMLButtonElement>('button[aria-label="Edit base branch"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const choices = () => [...(dialog()?.querySelectorAll<HTMLElement>('[data-slot="command-item"]') ?? [])];
const choice = (branch: string) => choices().find((item) => item.textContent?.includes(branch));

/** Clicks, then settles whatever the click asked for (the popup's branch read). */
const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
  await act(async () => { await Promise.resolve(); });
};

describe('changing a change request\'s base branch from its preview', () => {
  test('offers the pencil on a pull where the host and this surface may write', async () => {
    await show();
    expect(pencil()).not.toBeNull();
    expect(host.textContent).toContain('main');
  });

  test('keeps the base plain text without a write context', async () => {
    await show({ writeContext: null });
    expect(pencil()).toBeNull();
    expect(host.textContent).toContain('main');
  });

  test('keeps the base plain text where the host cannot change it', async () => {
    await show({ baseChange: false });
    expect(pencil()).toBeNull();
    expect(host.textContent).toContain('main');
  });

  test('offers no pencil on an issue, a discussion or a linked item', async () => {
    await show({ reference: issue });
    expect(pencil()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);

    await show({ reference: discussion });
    expect(pencil()).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);

    await show({ reference: { ...pull, linked: true } });
    expect(pencil()).toBeNull();
  });

  test('shows a spinner while the branches load, then the repository\'s other branches', async () => {
    const shown = await show({ holdBranches: true });
    await click(pencil());
    expect(dialog()?.querySelector('[role="status"]')).not.toBeNull();
    expect(choices()).toHaveLength(0);
    await act(async () => { shown.releaseBranches(['main', 'develop', 'release/1.0']); });
    await act(async () => { await Promise.resolve(); });
    expect(dialog()?.querySelector('[role="status"]')).toBeNull();
    expect(choices().map((item) => item.textContent)).toEqual(['develop', 'release/1.0']);
    // The base it points at now is not a choice.
    expect(choice('main')).toBeUndefined();
  });

  test('sends exactly one change with the picked branch, then reads the item again', async () => {
    const shown = await show();
    await click(pencil());
    await click(choice('develop'));
    await act(async () => { await Promise.resolve(); });
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].base).toBe('develop');
    expect(shown.calls[0].target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 9 });
    expect(shown.calls[0].accountId).toBe('github.com#7');
    expect(shown.calls[0].idempotencyKey.length).toBeGreaterThan(0);
    expect(shown.refreshes()).toBe(1);
    expect(errors).toEqual([]);
    // Nothing flips before the read: the row still names the base the item came with.
    expect(host.textContent).toContain('main');
  });

  test('shows the host\'s message instead of a list when the branches cannot be read', async () => {
    await show({ branches: new Error('Branches are not readable here') });
    await click(pencil());
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('Branches are not readable here');
    expect(choices()).toHaveLength(0);
  });

  test('toasts a refused change and leaves the base as it was', async () => {
    const shown = await show({ failWrite: true });
    await click(pencil());
    await click(choice('develop'));
    await act(async () => { await Promise.resolve(); });
    expect(shown.calls).toHaveLength(1);
    expect(errors).toEqual([{ message: 'Could not change the base branch on #9', description: 'You may not change the base here' }]);
    expect(shown.refreshes()).toBe(0);
    expect(host.textContent).toContain('main');
    expect(host.textContent).not.toContain('develop');
  });
});
