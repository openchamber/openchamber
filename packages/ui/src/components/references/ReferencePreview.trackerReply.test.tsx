import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

import type { TrackerCommentCreateInput, TrackerCommentCreateResult, TrackerItem } from '@/lib/api/types';

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
});

const item: TrackerItem = {
    provider: 'linear', id: 'issue', identifier: 'ENG-12', title: 'Preview layout', url: 'https://linear.app/acme/issue/ENG-12',
    state: { id: 'started', name: 'In progress', category: 'in-progress' },
    assignee: null, container: { id: 'eng', key: 'ENG', name: 'Engineering' }, priority: 'none', labels: [],
    description: '', comments: [],
};

const called: Array<{ provider: string; input: TrackerCommentCreateInput }> = [];
let answer = async (): Promise<TrackerCommentCreateResult> => ({ connected: true, comment: { id: 'c-1' } });

const postComment = async (provider: string, input: TrackerCommentCreateInput) => {
    called.push({ provider, input });
    return answer();
};

const setDescriptor = async (comments: boolean) => {
    const [{ useTrackerRegistry }, { linearLikeTrackerDescriptor }] = await Promise.all([
        import('@/lib/trackers/registry'),
        import('@/lib/trackers/descriptor.fixture'),
    ]);
    const base = linearLikeTrackerDescriptor();
    const descriptor = { ...base, capabilities: { ...base.capabilities, comments } };
    await act(async () => {
        useTrackerRegistry.setState({ ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready', holdsList: true });
    });
};

const show = async ({ comments, onRefresh }: { comments: boolean; onRefresh: () => void }) => {
    await setDescriptor(comments);
    const [{ ReferencePreview }, { TrackerReply }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }] = await Promise.all([
        import('./ReferencePreview'),
        import('./TrackerReply'),
        import('@/lib/i18n'),
        import('@/contexts/runtimeAPIContext'),
        import('../../../../web/src/api'),
    ]);
    const apis = createWebAPIs();
    if (!apis.trackers) throw new Error('The web runtime serves no tracker API');
    const trackers = { ...apis.trackers, commentCreate: postComment };
    await act(async () => {
        root.render(
            <I18nProvider>
                <RuntimeAPIContext.Provider value={{ ...apis, trackers }}>
                    <ReferencePreview
                        item={{ source: 'tracker', provider: 'linear', item }}
                        directory={null}
                        pullStatus={{ status: 'idle' }}
                        trackerDetail={{ status: 'ready', value: item }}
                        repositoryDetail={{ status: 'idle' }}
                        purpose="attach"
                        pinned={false}
                        includeDiff={false}
                        onIncludeDiffChange={() => undefined}
                        now={0}
                        reply={<TrackerReply item={item} onRefresh={onRefresh} />}
                    />
                </RuntimeAPIContext.Provider>
            </I18nProvider>,
        );
    });
};

const replyField = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
const replyButton = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Comment');

const typeInto = async (element: HTMLTextAreaElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    await act(async () => {
        setValue?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

const flush = async () => {
    await act(async () => { await Promise.resolve(); });
};

describe('replying to a tracker item', () => {
    test('draws no box where the tracker does not declare the comments capability', async () => {
        await show({ comments: false, onRefresh: () => undefined });
        expect(replyField()).toBeNull();
        expect(replyButton()).toBeUndefined();
    });

    test('draws an empty box where it does, with the send button waiting for text', async () => {
        await show({ comments: true, onRefresh: () => undefined });
        expect(replyField()).not.toBeNull();
        expect(replyButton()?.disabled).toBe(true);
    });

    test('posting sends the identifier and body, clears the box and re-reads the item', async () => {
        let refreshed = 0;
        await show({ comments: true, onRefresh: () => { refreshed += 1; } });
        const field = replyField();
        if (!field) throw new Error('Expected the reply box');
        await typeInto(field, 'Fixed in the next build');
        expect(replyButton()?.disabled).toBe(false);
        await act(async () => { replyButton()?.click(); });
        await flush();
        expect(called).toEqual([{ provider: 'linear', input: { identifier: 'ENG-12', body: 'Fixed in the next build' } }]);
        expect(refreshed).toBe(1);
        expect(replyField()?.value).toBe('');
    });

    test('a post the server refuses keeps the text for another try', async () => {
        let refreshed = 0;
        answer = async () => { throw new Error('Tracker unavailable'); };
        await show({ comments: true, onRefresh: () => { refreshed += 1; } });
        const field = replyField();
        if (!field) throw new Error('Expected the reply box');
        await typeInto(field, 'Trying again');
        await act(async () => { replyButton()?.click(); });
        await flush();
        expect(refreshed).toBe(0);
        expect(replyField()?.value).toBe('Trying again');
    });

    test('a tracker that is no longer connected keeps the text too', async () => {
        let refreshed = 0;
        answer = async () => ({ connected: false });
        await show({ comments: true, onRefresh: () => { refreshed += 1; } });
        const field = replyField();
        if (!field) throw new Error('Expected the reply box');
        await typeInto(field, 'Still here');
        await act(async () => { replyButton()?.click(); });
        await flush();
        expect(refreshed).toBe(0);
        expect(replyField()?.value).toBe('Still here');
    });
});
