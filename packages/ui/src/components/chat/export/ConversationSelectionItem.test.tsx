import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createConversationSelectionStore, type ConversationSelectionStore } from './selectionStore';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
    Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
    KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
});

const { I18nProvider } = await import('@/lib/i18n');
const { ConversationSelectionContext, useConversationItemSelected, useConversationSelectionActive } = await import('./selectionContext');
const { ConversationSelectionItem } = await import('./ConversationSelectionItem');

let root: Root | undefined;
let container: HTMLDivElement;

const render = async (children: React.ReactNode, store: ConversationSelectionStore | null) => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
        root?.render(
            <I18nProvider>
                <ConversationSelectionContext.Provider value={store}>{children}</ConversationSelectionContext.Provider>
            </I18nProvider>,
        );
    });
};

const element = (selector: string, scope: ParentNode = container): HTMLElement => {
    const result = scope.querySelector<HTMLElement>(selector);
    if (!result) throw new Error(`Missing test element: ${selector}`);
    return result;
};

const item = (children: React.ReactNode = <p data-body>Message body</p>, eligible = true) => (
    <ConversationSelectionItem selectionKey="user:one" role="user" eligible={eligible}>
        {children}
    </ConversationSelectionItem>
);

const activeStore = () => {
    const store = createConversationSelectionStore();
    store.getState().begin('user:one');
    return store;
};

afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
});

afterAll(() => browser.close());

describe('ConversationSelectionItem', () => {
    test('selection uses a large checkbox and a square full-row background', async () => {
        const store = activeStore();
        await render(item(), store);
        const checkbox = element('[role="checkbox"]');
        expect(checkbox.classList.contains('h-6')).toBe(true);
        expect(checkbox.classList.contains('w-6')).toBe(true);
        expect(checkbox.closest('.size-11')).not.toBeNull();
        const wrapper = element('[data-conversation-selection-item]');
        expect(wrapper.classList.contains('bg-interactive-selection')).toBe(true);
        expect([...wrapper.classList].some((name) => name.startsWith('rounded'))).toBe(false);
        await act(async () => store.getState().toggle('user:one'));
        expect(wrapper.classList.contains('bg-interactive-selection')).toBe(false);
        await act(async () => store.getState().toggle('user:one'));
        expect(wrapper.classList.contains('bg-interactive-selection')).toBe(true);
        await act(async () => store.getState().cancel());
        expect(wrapper.classList.contains('bg-interactive-selection')).toBe(false);
    });

    test('adjacent selections tint the entire wrappers without inset cards or connecting across unselected messages', async () => {
        const store = activeStore();
        await render(['user:one', 'assistant:one', 'user:two', 'assistant:two'].map((key) => (
            <ConversationSelectionItem key={key} selectionKey={key} role={key.startsWith('user:') ? 'user' : 'assistant'} eligible>
                <div className="chat-message-column">{key}</div>
            </ConversationSelectionItem>
        )), store);
        await act(async () => {
            store.getState().toggle('assistant:one');
            store.getState().toggle('assistant:two');
        });
        const wrappers = [...container.querySelectorAll('[data-conversation-selection-item]')];
        expect(wrappers.map((wrapper) => wrapper.classList.contains('bg-interactive-selection'))).toEqual([true, true, false, true]);
        for (const wrapper of wrappers) {
            expect([...wrapper.classList].some((name) => /^(rounded|m[xysetb]?-)/.test(name))).toBe(false);
            expect(wrapper.querySelector('.bg-interactive-selection')).toBeNull();
        }
    });
    test('checkbox clicks toggle exactly once without reaching the item handler', async () => {
        const store = activeStore();
        await render(item(), store);
        let updates = 0;
        const unsubscribe = store.subscribe(() => { updates += 1; });
        try {
            const checkbox = element('[role="checkbox"]');
            expect(checkbox.getAttribute('aria-checked')).toBe('true');
            await act(async () => checkbox.click());
            expect(updates).toBe(1);
            expect(store.getState().selected.has('user:one')).toBe(false);
            expect(checkbox.getAttribute('aria-checked')).toBe('false');
            await act(async () => checkbox.click());
            expect(updates).toBe(2);
            expect(store.getState().selected.has('user:one')).toBe(true);
        } finally {
            unsubscribe();
        }
    });

    test('virtualized slices of one assistant reply share one selection and restore it on remount', async () => {
        const store = createConversationSelectionStore();
        store.getState().begin('user:one');
        const slices = (ids: number[]) => ids.map((id) => (
            <ConversationSelectionItem key={id} selectionKey="assistant:one" role="assistant" eligible>
                <p data-slice={id}>Answer slice {id}</p>
            </ConversationSelectionItem>
        ));
        await render(slices([0, 1]), store);
        await act(async () => element('[data-slice="1"]').click());
        expect([...store.getState().selected]).toEqual(['user:one', 'assistant:one']);
        expect([...container.querySelectorAll('[role="checkbox"]')].map((checkbox) => checkbox.getAttribute('aria-checked'))).toEqual(['true', 'true']);
        await act(async () => root?.render(
            <I18nProvider>
                <ConversationSelectionContext.Provider value={store}>{slices([1, 2])}</ConversationSelectionContext.Provider>
            </I18nProvider>,
        ));
        expect(element('[data-slice="2"]').closest('[data-selected="true"]')).not.toBeNull();
        await act(async () => element('[role="checkbox"]').click());
        expect([...store.getState().selected]).toEqual(['user:one']);
        expect([...container.querySelectorAll('[role="checkbox"]')].map((checkbox) => checkbox.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    });

    test('body and wrapper clicks toggle the message selection', async () => {
        const store = activeStore();
        await render(item(), store);
        const wrapper = element('[data-conversation-selection-item]');
        await act(async () => element('[data-body]').click());
        expect(store.getState().selected.has('user:one')).toBe(false);
        expect(wrapper.getAttribute('data-selected')).toBe('false');
        await act(async () => wrapper.click());
        expect(store.getState().selected.has('user:one')).toBe(true);
        expect(wrapper.getAttribute('data-selected')).toBe('true');
    });

    test('Space on the checkbox toggles once', async () => {
        const store = activeStore();
        await render(item(), store);
        let updates = 0;
        const unsubscribe = store.subscribe(() => { updates += 1; });
        try {
            const checkbox = element('[role="checkbox"]');
            await act(async () => {
                checkbox.focus();
                checkbox.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
                checkbox.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
            });
            expect(updates).toBe(1);
            expect(store.getState().selected.has('user:one')).toBe(false);
            expect(checkbox.getAttribute('aria-checked')).toBe('false');
        } finally {
            unsubscribe();
        }
    });

    test('selection makes message controls inert and hides action groups', async () => {
        const store = activeStore();
        await render(item(<div><button data-message-actions="true">Copy</button><div data-message-action-group="true"><button>Menu</button></div></div>), store);
        const wrapper = element('[data-conversation-selection-item]');
        const body = element('div[id]', wrapper);
        expect(body.hasAttribute('inert')).toBe(true);
        expect(body.classList.contains('pointer-events-none')).toBe(true);
        expect(body.classList.contains('[&_[data-message-actions=true]]:invisible')).toBe(true);
        expect(body.classList.contains('[&_[data-message-action-group=true]]:invisible')).toBe(true);
        expect(element('[role="checkbox"]').closest('[inert]')).toBeNull();
        await act(async () => store.getState().cancel());
        expect(body.hasAttribute('inert')).toBe(false);
        expect(body.classList.contains('pointer-events-none')).toBe(false);
    });

    test('inactive selection preserves body controls and their ordinary clicks', async () => {
        const store = createConversationSelectionStore();
        let clicks = 0;
        await render(item(<button data-action onClick={() => { clicks += 1; }}>Copy</button>), store);
        expect(container.querySelector('[role="checkbox"]')).toBeNull();
        expect(container.querySelector('[data-conversation-selection-item]')).toBeNull();
        expect(container.querySelector('[inert]')).toBeNull();
        await act(async () => element('[data-action]').click());
        expect(clicks).toBe(1);
        expect(store.getState().active).toBe(false);
        expect(store.getState().selected.size).toBe(0);
    });

    test('missing selection context preserves ordinary message behavior', async () => {
        let clicks = 0;
        await render(item(<button data-action onClick={() => { clicks += 1; }}>Copy</button>), null);
        await act(async () => element('[data-action]').click());
        expect(clicks).toBe(1);
        expect(container.querySelector('[inert]')).toBeNull();
        expect(container.querySelector('[role="checkbox"]')).toBeNull();
    });

    test('ineligible messages have no selection target while their controls stay inert', async () => {
        const store = activeStore();
        await render(item(<p data-body>Activity only</p>, false), store);
        expect(container.querySelector('[role="checkbox"]')).toBeNull();
        expect(container.querySelector('[data-conversation-selection-item]')).toBeNull();
        expect(element('[data-body]').closest('[inert]')).not.toBeNull();
        await act(async () => container.firstElementChild?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect([...store.getState().selected]).toEqual(['user:one']);
    });

    test('replacing the context store drops the old selection without remounting the message', async () => {
        const previous = activeStore();
        const next = createConversationSelectionStore();
        const children = item();
        await render(children, previous);
        const body = element('[data-body]');
        await act(async () => {
            root?.render(
                <I18nProvider>
                    <ConversationSelectionContext.Provider value={next}>{children}</ConversationSelectionContext.Provider>
                </I18nProvider>,
            );
        });
        expect(element('[data-body]')).toBe(body);
        expect(container.querySelector('[role="checkbox"]')).toBeNull();
        expect(container.querySelector('[inert]')).toBeNull();
        await act(async () => previous.getState().toggle('user:one'));
        expect(container.querySelector('[data-conversation-selection-item]')).toBeNull();
        await act(async () => next.getState().begin('assistant:other'));
        expect(element('[data-conversation-selection-item]').getAttribute('data-selected')).toBe('false');
        await act(async () => element('[data-conversation-selection-item]').click());
        expect([...next.getState().selected]).toEqual(['assistant:other', 'user:one']);
        expect(previous.getState().selected.size).toBe(0);
    });

    test('portal clicks cannot toggle the parent selection item', async () => {
        const store = activeStore();
        const portal = document.createElement('div');
        document.body.append(portal);
        let clicks = 0;
        await render(item(createPortal(<button data-portal onClick={() => { clicks += 1; }}>Portal action</button>, portal)), store);
        await act(async () => element('[data-portal]', portal).click());
        expect(clicks).toBe(1);
        expect([...store.getState().selected]).toEqual(['user:one']);
    });

    test('a portal action that begins selection cannot immediately deselect its parent', async () => {
        const store = createConversationSelectionStore();
        const portal = document.createElement('div');
        document.body.append(portal);
        await render(item(createPortal(<button data-portal onClick={() => { store.getState().begin('user:one'); }}>Select</button>, portal)), store);
        await act(async () => element('[data-portal]', portal).click());
        expect(store.getState().active).toBe(true);
        expect([...store.getState().selected]).toEqual(['user:one']);
        expect(element('[data-conversation-selection-item]').getAttribute('data-selected')).toBe('true');
    });

    test('toggling one leaf updates only its wrapper subtree among 120 mounted items', async () => {
        const store = activeStore();
        const commits = new Map<string, number>();
        const leafRenders = new Map<string, number>();
        const LeafProbe = ({ selectionKey }: { selectionKey: string }) => {
            const active = useConversationSelectionActive();
            const selected = useConversationItemSelected(selectionKey);
            leafRenders.set(selectionKey, (leafRenders.get(selectionKey) ?? 0) + 1);
            return <span data-leaf-key={selectionKey} data-leaf-selected={active && selected} />;
        };
        const keys = Array.from({ length: 120 }, (_, index) => `user:${index}`);
        await render(keys.map((key) => (
            <React.Profiler key={key} id={key} onRender={(id) => { commits.set(id, (commits.get(id) ?? 0) + 1); }}>
                <LeafProbe selectionKey={key} />
                <ConversationSelectionItem selectionKey={key} role="user" eligible>
                    <p>{key}</p>
                </ConversationSelectionItem>
            </React.Profiler>
        )), store);
        expect(container.querySelectorAll('[data-conversation-selection-item]').length).toBe(120);
        expect(commits.size).toBe(120);
        expect(leafRenders.size).toBe(120);
        commits.clear();
        leafRenders.clear();
        await act(async () => store.getState().toggle('user:60'));
        expect([...commits.keys()]).toEqual(['user:60']);
        expect(commits.get('user:60')).toBeGreaterThan(0);
        expect([...leafRenders.entries()]).toEqual([['user:60', 1]]);
        expect(element('[data-conversation-selection-item="user:60"]').getAttribute('data-selected')).toBe('true');
        expect(element('[data-conversation-selection-item="user:59"]').getAttribute('data-selected')).toBe('false');
        commits.clear();
        leafRenders.clear();
        await act(async () => store.getState().toggle('user:60'));
        expect([...commits.keys()]).toEqual(['user:60']);
        expect(commits.get('user:60')).toBeGreaterThan(0);
        expect([...leafRenders.entries()]).toEqual([['user:60', 1]]);
        expect(element('[data-conversation-selection-item="user:60"]').getAttribute('data-selected')).toBe('false');
    });
});
