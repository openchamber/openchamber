import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

import type {
    RepositoryChangeRequestReference,
    RepositoryReferenceComment,
    RepositoryReferenceDetail,
    SourceControlReferenceLink,
    TrackerItem,
} from '@/lib/api/types';

import type { CachedValue } from './referenceCache';
import type { CommentAttachments } from './ReferenceCommentsSection';
import { CollapsedBody } from './CollapsedBody';

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
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');
const {
    DEFAULT_REFERENCE_PREVIEW_DISPLAY,
    readReferencePreviewDisplay,
    useReferencePreviewDisplayStore,
    writeReferencePreviewDisplay,
} = await import('@/stores/useReferencePreviewDisplayStore');
const { SyncRuntimeContext } = await import('@/sync/sync-runtime-context');

// The chat's Markdown renderer asks the sync runtime for the directory it draws
// in: `useEffectiveDirectory` → `useSessionDirectory` → `useSessionSelector`.
// With no session and no directory, that path only reads
// `childStores.children` and subscribes through `childStores.subscribeAllSelected`;
// both are empty here, so there is nothing to report.
// `getChild`, `currentDirectory`, `messageLoader` and `sdk` are never reached;
// they are stubbed only so the object keeps the runtime's shape.
// SAFETY: those two `childStores` members are the whole surface this preview
// touches, and the assertions read rendered text only.
const runtime = {
    childStores: {
        children: new Map(),
        getChild: () => undefined,
        subscribeAllSelected: () => () => {},
    },
    messageLoader: {},
    runtimeKey: 'test',
    sdk: {},
    currentDirectory: { get: () => undefined, subscribe: () => () => {} },
} as never;


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
    useReferencePreviewDisplayStore.setState({ ...DEFAULT_REFERENCE_PREVIEW_DISPLAY, runtimeKey: null });
});

const pull = (overrides: Partial<RepositoryChangeRequestReference> = {}): RepositoryChangeRequestReference => ({
    kind: 'pull', provider: 'github', number: 12, title: 'Preview layout', url: 'https://github.com/acme/app/pull/12',
    body: '', bodyTruncated: false, createdAt: null, updatedAt: null,
    author: { login: 'octocat' }, labels: [], commentCount: 0,
    sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' },
    state: 'open', draft: false, head: 'feature', base: 'main', headSha: 'abc', headRepo: null,
    ...overrides,
});

const commit = (sha: string, committedAt: string) => ({ sha, headline: sha, author: null, authorName: null, avatarUrl: null, committedAt, url: null });

const mention = (createdAt: string): SourceControlReferenceLink => ({
    kind: 'issue', number: 4, title: 'The first story', url: 'https://github.com/acme/app/issues/4',
    repo: 'acme/app', createdAt, author: { login: 'riri' },
});

const detail = (overrides: Partial<RepositoryReferenceDetail> = {}): RepositoryReferenceDetail => ({
    number: 12,
    comments: [],
    commentTotal: 0,
    pull: {
        additions: 2, deletions: 1, changedFiles: 1, reviewDecision: null, reviewers: [],
        checks: { state: 'success', total: 0, success: 0, failure: 0, pending: 0 },
        commits: [], commitTotal: 0,
    },
    ...overrides,
});

const trackerItem: TrackerItem = {
    provider: 'linear', id: 'issue', identifier: 'ENG-12', title: 'Preview layout', url: 'https://linear.app/acme/issue/ENG-12',
    state: { id: 'started', name: 'In progress', category: 'in-progress' },
    assignee: null, container: { id: 'eng', key: 'ENG', name: 'Engineering' }, priority: 'none', labels: [],
    description: '', comments: [],
};

const setRegistries = async () => {
    const [{ useSourceControlProviderRegistry }, { githubLikeDescriptor }, { useTrackerRegistry }, { linearLikeTrackerDescriptor }] = await Promise.all([
        import('@/lib/source-control/providers/registry'),
        import('@/lib/source-control/providers/descriptor.fixture'),
        import('@/lib/trackers/registry'),
        import('@/lib/trackers/descriptor.fixture'),
    ]);
    const github = githubLikeDescriptor();
    useSourceControlProviderRegistry.setState({ ordered: [github], byId: new Map([[github.id, github]]), status: 'ready', holdsList: true });
    const linear = linearLikeTrackerDescriptor();
    useTrackerRegistry.setState({ ordered: [linear], byId: new Map([[linear.id, linear]]), status: 'ready', holdsList: true });
};

const note = (overrides: Partial<RepositoryReferenceComment> = {}): RepositoryReferenceComment => ({
    author: { login: 'ada' }, body: 'A note', createdAt: null, url: 'https://github.com/acme/app/pull/12#c1',
    id: 'c1', canUpdate: false, canDelete: false, path: null, line: null, review: null, ...overrides,
});

const show = async (options: {
    reference?: RepositoryChangeRequestReference;
    repositoryDetail?: CachedValue<RepositoryReferenceDetail>;
    tracker?: TrackerItem;
    commentAttachments?: CommentAttachments;
} = {}) => {
    const [{ ReferencePreview }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
        import('./ReferencePreview'),
        import('@/lib/i18n'),
        import('@/contexts/runtimeAPIContext'),
        import('../../../../web/src/api'),
    ]);
    await setRegistries();
    const apis = createWebAPIs();
    const item = options.tracker
        ? { source: 'tracker' as const, provider: 'linear' as const, item: options.tracker }
        : { source: 'repository' as const, reference: options.reference ?? pull() };
    await act(async () => {
        root.render(
            <I18nProvider>
                <SyncRuntimeContext.Provider value={runtime}>
                <RuntimeAPIContext.Provider value={apis}>
                    <ReferencePreview
                        item={item}
                        directory={null}
                        pullStatus={{ status: 'idle' }}
                        trackerDetail={options.tracker ? { status: 'ready', value: options.tracker } : { status: 'idle' }}
                        repositoryDetail={options.repositoryDetail ?? { status: 'ready', value: detail() }}
                        purpose="attach"
                        pinned={false}
                        includeDiff={false}
                        onIncludeDiffChange={() => undefined}
                        now={0}
                        onRefresh={async () => undefined}
                        commentAttachments={options.commentAttachments}
                    />
                </RuntimeAPIContext.Provider>
                </SyncRuntimeContext.Provider>
            </I18nProvider>,
        );
    });
};

const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === name);
const flush = async () => {
    await act(async () => { await Promise.resolve(); });
};
const until = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (ready()) return;
        await flush();
    }
};
const click = async (element: HTMLElement | null | undefined) => {
    if (!element) throw new Error('Expected the element');
    await act(async () => { element.click(); });
    await flush();
};
const press = async (element: Element, key: string) => {
    await act(async () => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
};
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')];
const iconHrefs = (element: Element) => [...element.querySelectorAll('use')].map((use) => use.getAttribute('href'));
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label="Display options"]');

describe('preview display menu', () => {
    test('sits in the action row of a picker preview that has no detail, with both switches unchecked on a fresh profile', async () => {
        expect(readReferencePreviewDisplay()).toEqual({ referencePreviewNewestFirst: false, referencePreviewCollapseDescription: false });
        await show({ repositoryDetail: { status: 'idle' } });
        const button = trigger();
        expect(button).not.toBeNull();

        await click(button);
        await until(() => menuItems().length > 0);
        const items = menuItems();
        expect(items.map((item) => item.textContent?.trim())).toEqual(['Newest first', 'Collapse description']);
        expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false']);
        expect(iconHrefs(items[0]!)).not.toContain('#oc-check');
        expect(iconHrefs(items[1]!)).not.toContain('#oc-check');

        await click(items[0]);
        expect(readReferencePreviewDisplay().referencePreviewNewestFirst).toBe(true);
        expect(items[0]?.getAttribute('aria-checked')).toBe('true');
        expect(iconHrefs(items[0]!)).toContain('#oc-check');

        await click(items[1]);
        expect(readReferencePreviewDisplay().referencePreviewCollapseDescription).toBe(true);
        expect(items[1]?.getAttribute('aria-checked')).toBe('true');
        expect(iconHrefs(items[1]!)).toContain('#oc-check');

        const menu = document.querySelector<HTMLElement>('[role="menu"]');
        if (!menu) throw new Error('Expected the open menu');
        await press(menu, 'Escape');
        expect(document.querySelector('[role="menu"]')).toBeNull();

        button?.focus();
        await press(button!, 'ArrowDown');
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
    });

    test('is also in the tracker preview', async () => {
        await show({ tracker: trackerItem });
        expect(trigger()).not.toBeNull();
    });
});

describe('newest first', () => {
    test('reverses the activity rows and the commits inside a group', async () => {
        await show({
            repositoryDetail: {
                status: 'ready',
                value: detail({
                    pull: {
                        ...detail().pull!,
                        commits: [commit('aaaaaaa', '2026-10-01T10:00:00Z'), commit('bbbbbbb', '2026-10-01T11:00:00Z')],
                        commitTotal: 2,
                    },
                    references: [mention('2026-10-01T13:00:00Z')],
                }),
            },
        });

        const rows = () => [...host.querySelectorAll<HTMLElement>('section div.group.relative')];
        const kinds = () => rows().map((row) => row.textContent?.includes('mentioned this in') ? 'reference' : 'commits');
        const shas = () => [...host.querySelectorAll<HTMLElement>('section ul li')].map((row) => row.textContent?.trim().slice(0, 7));

        expect(kinds()).toEqual(['commits', 'reference']);
        expect(shas()).toEqual(['aaaaaaa', 'bbbbbbb']);

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: true }));

        expect(kinds()).toEqual(['reference', 'commits']);
        expect(shas()).toEqual(['bbbbbbb', 'aaaaaaa']);
    });

    test('shows tracker comments in the provider order until Newest first sorts them, and again once it is off', async () => {
        await show({
            tracker: {
                ...trackerItem,
                comments: [
                    { id: 'newest', body: 'Newest note', createdAt: '2026-10-03T09:00:00Z', author: { name: 'Newer author', avatarUrl: null } },
                    { id: 'oldest', body: 'Oldest note', createdAt: '2026-10-01T09:00:00Z', author: { name: 'Older author', avatarUrl: null } },
                ],
            },
        });
        const text = () => host.textContent ?? '';
        const order = () => ['Older author', 'Newer author'].sort((left, right) => text().indexOf(left) - text().indexOf(right));
        expect(order()).toEqual(['Newer author', 'Older author']);

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: true }));
        expect(order()).toEqual(['Newer author', 'Older author']);

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: false }));
        expect(order()).toEqual(['Newer author', 'Older author']);
    });

    test('sorts oldest-first tracker comments when Newest first is on and restores them when it is off', async () => {
        await show({
            tracker: {
                ...trackerItem,
                comments: [
                    { id: 'oldest', body: 'Oldest note', createdAt: '2026-10-01T09:00:00Z', author: { name: 'Older author', avatarUrl: null } },
                    { id: 'newest', body: 'Newest note', createdAt: '2026-10-03T09:00:00Z', author: { name: 'Newer author', avatarUrl: null } },
                ],
            },
        });
        const text = () => host.textContent ?? '';
        expect(text().indexOf('Older author')).toBeLessThan(text().indexOf('Newer author'));

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: true }));
        expect(text().indexOf('Newer author')).toBeLessThan(text().indexOf('Older author'));

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: false }));
        expect(text().indexOf('Older author')).toBeLessThan(text().indexOf('Newer author'));
    });

    test('keeps an undated tracker comment where the provider put it while off, and after the dated ones when on', async () => {
        await show({
            tracker: {
                ...trackerItem,
                comments: [
                    { id: 'newest', body: 'Newest note', createdAt: '2026-10-03T09:00:00Z', author: { name: 'Newer author', avatarUrl: null } },
                    { id: 'undated', body: 'Undated note', createdAt: null, author: { name: 'Undated author', avatarUrl: null } },
                    { id: 'oldest', body: 'Oldest note', createdAt: '2026-10-01T09:00:00Z', author: { name: 'Older author', avatarUrl: null } },
                ],
            },
        });
        const text = () => host.textContent ?? '';
        const order = () => ['Older author', 'Newer author', 'Undated author'].sort((left, right) => text().indexOf(left) - text().indexOf(right));
        expect(order()).toEqual(['Newer author', 'Undated author', 'Older author']);

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: true }));
        expect(order()).toEqual(['Newer author', 'Older author', 'Undated author']);

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: false }));
        expect(order()).toEqual(['Newer author', 'Undated author', 'Older author']);
    });

    test('attaches threads oldest first with each root followed by its replies, whichever order is shown', async () => {
        const attached: string[][] = [];
        const thread = (id: string, replies: RepositoryReferenceComment[]) => ({ id, resolved: false, canResolve: false, canReply: false, replies });
        // Replies interleave by time: root A, root B, reply A1, reply B1.
        await show({
            repositoryDetail: {
                status: 'ready',
                value: detail({
                    comments: [
                        note({
                            id: 'a', body: 'Root A', createdAt: '2026-10-01T09:00:00Z', url: 'https://github.com/acme/app/pull/12#a', author: { login: 'Older author' },
                            thread: thread('ta', [note({ id: 'a1', body: 'Reply A1', createdAt: '2026-10-03T09:00:00Z', url: 'https://github.com/acme/app/pull/12#a1' })]),
                        }),
                        note({
                            id: 'b', body: 'Root B', createdAt: '2026-10-02T09:00:00Z', url: 'https://github.com/acme/app/pull/12#b', author: { login: 'Newer author' },
                            thread: thread('tb', [note({ id: 'b1', body: 'Reply B1', createdAt: '2026-10-04T09:00:00Z', url: 'https://github.com/acme/app/pull/12#b1' })]),
                        }),
                    ],
                }),
            },
            commentAttachments: { onAttach: () => undefined, onAttachAll: (comments) => { attached.push(comments.map((comment) => comment.body)); } },
        });
        const text = () => host.textContent ?? '';
        const attachAll = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Attach all to chat');
        const oldestFirst = ['Root A', 'Reply A1', 'Root B', 'Reply B1'];

        expect(text().indexOf('Older author')).toBeLessThan(text().indexOf('Newer author'));
        await click(attachAll());
        expect(attached).toEqual([oldestFirst]);

        await act(async () => writeReferencePreviewDisplay({ referencePreviewNewestFirst: true }));
        expect(text().indexOf('Newer author')).toBeLessThan(text().indexOf('Older author'));
        await click(attachAll());
        expect(attached).toEqual([oldestFirst, oldestFirst]);
    });
});

describe('collapse description', () => {
    test('collapses a real Markdown description in both the repository and the tracker preview', async () => {
        await act(async () => writeReferencePreviewDisplay({ referencePreviewCollapseDescription: true }));
        const prototype = browser.HTMLElement.prototype;
        const original = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight');
        Object.defineProperty(prototype, 'scrollHeight', { configurable: true, get: () => 400 });
        try {
            await show({ reference: pull({ body: 'A long description. '.repeat(40) }) });
            expect(host.querySelector('[data-collapsed-body]')).not.toBeNull();
            expect(Boolean(buttonNamed('Expand'))).toBe(true);

            await show({ tracker: { ...trackerItem, description: 'A long tracker description. '.repeat(40) } });
            expect(host.querySelector('[data-collapsed-body]')).not.toBeNull();
            expect(Boolean(buttonNamed('Expand'))).toBe(true);
        } finally {
            if (original) Object.defineProperty(prototype, 'scrollHeight', original);
            else Reflect.deleteProperty(prototype, 'scrollHeight');
        }
    });

    test('is off by default, clips a long body once turned on, and expands and collapses it', async () => {
        expect(readReferencePreviewDisplay().referencePreviewCollapseDescription).toBe(false);
        await act(async () => writeReferencePreviewDisplay({ referencePreviewCollapseDescription: true }));
        const prototype = browser.HTMLElement.prototype;
        const original = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight');
        Object.defineProperty(prototype, 'scrollHeight', { configurable: true, get: () => 400 });
        try {
            const { I18nProvider } = await import('@/lib/i18n');
            await act(async () => {
                root.render(
                    <I18nProvider>
                        <CollapsedBody collapsed={readReferencePreviewDisplay().referencePreviewCollapseDescription}>
                            <p>{'A long description. '.repeat(40)}</p>
                        </CollapsedBody>
                    </I18nProvider>,
                );
            });

            expect(host.querySelector('[data-collapsed-body]')).not.toBeNull();
            const expand = buttonNamed('Expand');
            expect(expand).not.toBeNull();

            await click(expand);
            expect(host.querySelector('[data-collapsed-body]')).toBeNull();
            expect(buttonNamed('Collapse')).not.toBeNull();

            await click(buttonNamed('Collapse'));
            expect(host.querySelector('[data-collapsed-body]')).not.toBeNull();
            expect(buttonNamed('Expand')).not.toBeNull();

            await act(async () => {
                root.render(
                    <I18nProvider>
                        <CollapsedBody collapsed={false}>
                            <p>{'A long description. '.repeat(40)}</p>
                        </CollapsedBody>
                    </I18nProvider>,
                );
            });
            expect(host.querySelector('[data-collapsed-body]')).toBeNull();
            expect(buttonNamed('Expand')).toBeUndefined();
        } finally {
            if (original) Object.defineProperty(prototype, 'scrollHeight', original);
            else Reflect.deleteProperty(prototype, 'scrollHeight');
        }
    });
});
