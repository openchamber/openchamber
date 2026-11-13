import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import type {
  RepositoryDiscussionCategory,
  RepositoryDiscussionReference,
  RepositoryReferenceDetail,
  RuntimeAPIs,
  SetDiscussionCategoryInput,
  SourceControlEmptyMutationResult,
  SourceControlMutationReceipt,
  SourceControlReadContext,
} from '@/lib/api/types';

// The preview's Markdown renderer reads the sync runtime; these tests are
// about the category beside the category name.
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
  state: 'open', answered: null, upvotes: 0, locked: false, category: { name: 'Ideas', emoji: '💡', answerable: false },
};

const categories: RepositoryDiscussionCategory[] = [
  { id: 'ideas', name: 'Ideas', emoji: '💡', answerable: false },
  { id: 'general', name: 'General', emoji: null, answerable: false },
  { id: 'announcements', name: 'Announcements', emoji: '📣', answerable: true },
];

const detail: RepositoryReferenceDetail = {
  number: 3, comments: [], commentTotal: 0, pull: null,
  category: categories[0], categories,
};

const setProvider = async () => {
  const { useSourceControlProviderRegistry } = await import('@/lib/source-control/providers/registry');
  const { githubLikeDescriptor } = await import('@/lib/source-control/providers/descriptor.fixture');
  const descriptor = githubLikeDescriptor();
  useSourceControlProviderRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
};

type ShowOptions = {
  reference?: RepositoryDiscussionReference;
  writeContext?: SourceControlReadContext | null;
  failWrite?: boolean;
};

/** Renders the preview and records the category changes it sends and the refreshes it asks for. */
const show = async (options: ShowOptions = {}) => {
  const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
    import('./ReferencePreview'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api'),
  ]);
  await setProvider();
  const base = createWebAPIs();
  const calls: SetDiscussionCategoryInput[] = [];
  let refreshes = 0;
  const receipt = async (payload: SetDiscussionCategoryInput): Promise<SourceControlMutationReceipt<SourceControlEmptyMutationResult>> => {
    calls.push(payload);
    if (options.failWrite) throw new Error('You may not change the category here');
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
      discussionSetCategory: (payload) => receipt(payload),
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
            repositoryDetail={{ status: 'ready', value: detail }}
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

const pencil = () => host.querySelector<HTMLButtonElement>('button[aria-label="Edit category"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const choices = () => [...(dialog()?.querySelectorAll<HTMLElement>('[data-slot="command-item"]') ?? [])];
const choice = (name: string) => choices().find((item) => item.textContent?.includes(name));

/** Clicks, then settles whatever the click asked for (the popup's own read). */
const click = async (element: HTMLElement | null | undefined) => {
  if (!element) throw new Error('Expected the element');
  await act(async () => { element.click(); });
  await act(async () => { await Promise.resolve(); });
};

describe('changing a discussion\'s category from its preview', () => {
  test('offers the pencil, lists the other categories without the current one, and sends exactly one change', async () => {
    const shown = await show();
    expect(pencil()).not.toBeNull();
    expect(host.textContent).toContain('Ideas');

    await click(pencil());
    expect(dialog()).not.toBeNull();
    // The one it is in now is not a choice; each row keeps its emoji and name.
    expect(choice('Ideas')).toBeUndefined();
    expect(choices().map((item) => item.textContent)).toEqual(['General', '📣Announcements']);

    await click(choice('General'));
    await act(async () => { await Promise.resolve(); });
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].categoryId).toBe('general');
    expect(shown.calls[0].target).toEqual({ project: { owner: 'acme', name: 'app' }, number: 3 });
    expect(shown.calls[0].accountId).toBe('github.com#7');
    expect(shown.calls[0].idempotencyKey.length).toBeGreaterThan(0);
    expect(shown.refreshes()).toBe(1);
    expect(errors).toEqual([]);
    expect(dialog()).toBeNull();
    // Nothing flips before the read: the row still names the category the item came with.
    expect(host.textContent).toContain('Ideas');
  });

  test('offers no pencil on a linked discussion', async () => {
    await show({ reference: { ...discussion, linked: true } });
    expect(pencil()).toBeNull();
    expect(host.textContent).toContain('Ideas');
  });

  test('offers no pencil without a write context', async () => {
    await show({ writeContext: null });
    expect(pencil()).toBeNull();
    expect(host.textContent).toContain('Ideas');
  });

  test('toasts a refused change and leaves the editor closed', async () => {
    const shown = await show({ failWrite: true });
    await click(pencil());
    await click(choice('General'));
    await act(async () => { await Promise.resolve(); });
    expect(shown.calls).toHaveLength(1);
    expect(shown.calls[0].categoryId).toBe('general');
    expect(errors).toEqual([{ message: 'Could not change the category of #3', description: 'You may not change the category here' }]);
    expect(shown.refreshes()).toBe(0);
    expect(dialog()).toBeNull();
    expect(host.textContent).toContain('Ideas');
    expect(host.textContent).not.toContain('General');
  });
});
