import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { create } from 'zustand';
import type { Message, ModelSelection } from '@/lib/opencode/model';

type CatalogProvider = { id: string; models: Array<{ id: string; settings?: { opencodeRoute: { targets: unknown[] } } }> };
type ConfigState = {
    currentProviderId: string;
    currentModelId: string;
    currentVariant: string | undefined;
    providers: CatalogProvider[];
    setProvider: (providerId: string) => void;
    setModel: (modelId: string) => void;
    setCurrentVariant: (variant: string | undefined) => void;
};

const useConfigStore = create<ConfigState>((set) => ({
    currentProviderId: 'anthropic',
    currentModelId: 'claude-sonnet-5.5',
    currentVariant: undefined,
    providers: [],
    setProvider: (currentProviderId) => set({ currentProviderId }),
    setModel: (currentModelId) => set({ currentModelId }),
    setCurrentVariant: (currentVariant) => set({ currentVariant }),
}));

mock.module('@/stores/useConfigStore', () => ({
    useConfigStore,
    selectProvidersForDirectory: (state: ConfigState) => state.providers,
}));

// A store, so a new message re-renders the indicator the way the real sync hook does.
const useMessagesStore = create<{ messages: Message[] }>(() => ({ messages: [] }));
const NO_MESSAGES: Message[] = [];
mock.module('@/sync/sync-context', () => ({
    useSessionMessages: (sessionID: string) => {
        const messages = useMessagesStore((state) => state.messages);
        return sessionID ? messages : NO_MESSAGES;
    },
    useSessionStatus: () => ({ type: 'idle' }),
}));
const setMessages = (messages: Message[]) => useMessagesStore.setState({ messages });

// The menu stays closed in happy-dom unless a DOM exists when the component's
// modules (React DOM, Base UI) load; without one, clicking the trigger never
// opened it. The globals go back right after the import so other test files
// in this process see the environment they expect.
const importWindow = new Window({ url: 'http://localhost' });
const importGlobals = { window: importWindow, document: importWindow.document, navigator: importWindow.navigator };
const beforeImport = Object.keys(importGlobals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
for (const [name, value] of Object.entries(importGlobals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const { default: CurrentModelIndicator } = await import('./CurrentModelIndicator');
for (const [name, descriptor] of beforeImport) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
}
const { I18nProvider } = await import('@/lib/i18n');

// The real client singleton with its two route-target calls replaced: the
// test records what a pick sends and answers with the pins OpenCode would.
const { opencodeClient } = await import('@/lib/opencode/client');
type Pins = Awaited<ReturnType<typeof opencodeClient.getSessionRouteTargets>>;
const noPins: Pins = [];
const pins = { current: noPins };
const pinCalls: Array<{ sessionID: string; routeID: string; target: ModelSelection | null }> = [];
opencodeClient.getSessionRouteTargets = async () => pins.current;
opencodeClient.setSessionRouteTarget = async (sessionID, routeID, target) => {
    pinCalls.push({ sessionID, routeID, target });
    pins.current = [
        ...pins.current.filter((entry) => entry.routeID !== routeID),
        ...(target === null ? [] : [{ routeID, target }]),
    ];
    return pins.current;
};

const indicatorFor = (sessionId: string | null) => (
    <I18nProvider><CurrentModelIndicator sessionId={sessionId} /></I18nProvider>
);

const assistantMessage = (id: string, providerID: string, modelID: string, variant?: string): Message => ({
    id, sessionID: 's', role: 'assistant', time: { created: 1 }, agent: 'build', providerID, modelID, variant,
});

describe('CurrentModelIndicator', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;

    beforeEach(() => {
        const win = new Window({ url: 'http://localhost' });
        const globals = {
            window: win, document: win.document, HTMLElement: win.HTMLElement,
            Element: win.Element, SVGElement: win.SVGElement, NodeList: win.NodeList,
            navigator: win.navigator, Node: win.Node, getComputedStyle: win.getComputedStyle.bind(win),
            requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            Event: win.Event, CustomEvent: win.CustomEvent, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent, MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        restore();
        setMessages([]);
        useConfigStore.setState({ currentProviderId: 'anthropic', currentModelId: 'claude-sonnet-5.5', currentVariant: undefined, providers: [] });
        pins.current = [];
        pinCalls.length = 0;
    });

    test('shows the real model of the last assistant message', async () => {
        setMessages([assistantMessage('a1', 'anthropic', 'claude-sonnet-5.5', 'high')]);
        await act(async () => root.render(indicatorFor('s1')));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.textContent).toBe('Current model: anthropic/claude-sonnet-5.5#high');
    });

    test('shows the streaming/last message, not an earlier one', async () => {
        setMessages([
            assistantMessage('a1', 'openai', 'gpt-6-luna'),
            assistantMessage('a2', 'anthropic', 'claude-sonnet-5.5'),
        ]);
        await act(async () => root.render(indicatorFor('s1')));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.textContent).toBe('Current model: anthropic/claude-sonnet-5.5');
    });

    test('shows "pool · real model" when the selection is a pool', async () => {
        useConfigStore.setState({ currentProviderId: 'opencode-route', currentModelId: 'fast-strong' });
        setMessages([assistantMessage('a1', 'github-copilot', 'gpt-6-luna', 'low')]);
        await act(async () => root.render(indicatorFor('s1')));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.textContent).toBe('Current model: github-copilot/gpt-6-luna#low from pool fast-strong');
    });

    test('keeps the full reference readable: wraps instead of truncating, with a full-text label', async () => {
        useConfigStore.setState({ currentProviderId: 'opencode-route', currentModelId: 'strong-pool' });
        setMessages([assistantMessage('a1', 'github-copilot', 'claude-opus-5.5', 'max')]);
        await act(async () => root.render(indicatorFor('s1')));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.getAttribute('title')).toBe('Current model: github-copilot/claude-opus-5.5#max from pool strong-pool');
        expect(indicator?.getAttribute('aria-label')).toBe(indicator?.getAttribute('title') ?? '');
        expect(indicator?.querySelector('.truncate')).toBeNull();
    });

    test('follows a model switch: a new assistant message on another model replaces the shown one', async () => {
        setMessages([assistantMessage('a1', 'github-copilot', 'gemini-4-carbon', 'high')]);
        await act(async () => root.render(indicatorFor('s1')));
        const indicator = () => container.querySelector('[data-current-model-indicator]');
        expect(indicator()?.textContent).toBe('Current model: github-copilot/gemini-4-carbon#high');
        await act(async () => setMessages([
            ...useMessagesStore.getState().messages,
            assistantMessage('a2', 'github-copilot', 'claude-opus-5.5', 'max'),
        ]));
        expect(indicator()?.textContent).toBe('Current model: github-copilot/claude-opus-5.5#max');
        expect(indicator()?.getAttribute('title')).toBe('Current model: github-copilot/claude-opus-5.5#max');
    });

    test('a plain status line when the selected pool lists no members', async () => {
        useConfigStore.setState({ currentProviderId: 'opencode-route', currentModelId: 'strong-pool', providers: [] });
        setMessages([assistantMessage('a1', 'github-copilot', 'claude-opus-5.5', 'max')]);
        await act(async () => root.render(indicatorFor('s1')));
        const indicator = container.querySelector('[data-current-model-indicator]');
        expect(indicator?.tagName).toBe('DIV');
        expect(indicator?.getAttribute('role')).toBe('status');
    });

    const strongPool = () => useConfigStore.setState({
        currentProviderId: 'opencode-route',
        currentModelId: 'strong-pool',
        providers: [{ id: 'github-copilot', models: [{ id: 'gemini-4-carbon' }, { id: 'claude-opus-5.5' }] }, {
            id: 'opencode-route',
            models: [{ id: 'strong-pool', settings: { opencodeRoute: { targets: [
                { providerID: 'github-copilot', id: 'gemini-4-carbon', variant: 'high' },
                { providerID: 'github-copilot', id: 'claude-opus-5.5', variant: 'max' },
            ] } } }],
        }],
    });
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    test('names the pinned pool member on the line', async () => {
        strongPool();
        pins.current = [{ routeID: 'strong-pool', target: { providerID: 'github-copilot', id: 'gemini-4-carbon', variant: 'high' } }];
        setMessages([assistantMessage('a1', 'github-copilot', 'claude-opus-5.5', 'max')]);
        await act(async () => root.render(indicatorFor('s1')));
        await settle();
        expect(container.querySelector('[data-current-model-indicator]')?.textContent).toBe(
            'Current model: github-copilot/claude-opus-5.5#max from pool strong-pool, preferring github-copilot/gemini-4-carbon#high',
        );
    });

    test('picking a pool member pins it and keeps the session and the composer on the pool', async () => {
        strongPool();
        setMessages([assistantMessage('a1', 'github-copilot', 'claude-opus-5.5', 'max')]);
        await act(async () => root.render(indicatorFor('s1')));
        await settle();
        const trigger = container.querySelector<HTMLButtonElement>('[data-current-model-indicator]');
        expect(trigger?.tagName).toBe('BUTTON');
        expect(trigger?.textContent).toBe('Current model: github-copilot/claude-opus-5.5#max from pool strong-pool');

        if (!trigger) throw new Error('no trigger');
        await act(async () => { trigger.click(); });
        expect(document.querySelectorAll('[data-pool-pick-timing]')).toHaveLength(3);
        expect(document.body.textContent).toContain('The pool uses the model you pick while it works');
        expect(document.body.textContent).not.toContain('stops pool failover');
        const member = document.querySelector<HTMLElement>('[data-pool-pick-member="github-copilot/gemini-4-carbon#high"]');
        if (!member) throw new Error(`no member item in: ${document.body.textContent}`);
        await act(async () => { member.click(); });
        await settle();

        expect(pinCalls).toEqual([{ sessionID: 's1', routeID: 'strong-pool', target: { providerID: 'github-copilot', id: 'gemini-4-carbon', variant: 'high' } }]);
        expect(useConfigStore.getState()).toMatchObject({ currentProviderId: 'opencode-route', currentModelId: 'strong-pool' });
        expect(container.querySelector('[data-current-model-indicator]')?.textContent).toBe(
            'Current model: github-copilot/claude-opus-5.5#max from pool strong-pool, preferring github-copilot/gemini-4-carbon#high',
        );
    });

    test('"Any model in the pool" clears the pin', async () => {
        strongPool();
        pins.current = [{ routeID: 'strong-pool', target: { providerID: 'github-copilot', id: 'gemini-4-carbon', variant: 'high' } }];
        setMessages([assistantMessage('a1', 'github-copilot', 'claude-opus-5.5', 'max')]);
        await act(async () => root.render(indicatorFor('s1')));
        await settle();
        const trigger = container.querySelector<HTMLButtonElement>('[data-current-model-indicator]');
        if (!trigger) throw new Error('no trigger');
        await act(async () => { trigger.click(); });
        const anyMember = document.querySelector<HTMLElement>('[data-pool-pick-member=""]');
        if (!anyMember) throw new Error(`no pool item in: ${document.body.textContent}`);
        await act(async () => { anyMember.click(); });
        await settle();
        expect(pinCalls).toEqual([{ sessionID: 's1', routeID: 'strong-pool', target: null }]);
        expect(container.querySelector('[data-current-model-indicator]')?.textContent).toBe(
            'Current model: github-copilot/claude-opus-5.5#max from pool strong-pool',
        );
    });

    test('renders nothing before any assistant message exists', async () => {
        setMessages([]);
        await act(async () => root.render(indicatorFor('s1')));
        expect(container.querySelector('[data-current-model-indicator]')).toBeNull();
    });

    test('renders nothing without a session id', async () => {
        setMessages([assistantMessage('a1', 'anthropic', 'claude-sonnet-5.5')]);
        await act(async () => root.render(indicatorFor(null)));
        expect(container.querySelector('[data-current-model-indicator]')).toBeNull();
    });
});
