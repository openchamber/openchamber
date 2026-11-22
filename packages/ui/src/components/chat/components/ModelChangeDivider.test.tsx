import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { I18nProvider as BaseI18nProvider } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useConfigStore } from '@/stores/useConfigStore';
import { createWebAPIs } from '../../../../../web/src/api/index';
import { ModelAttributionProvider } from '../context/ModelAttributionContext';
import ModelChangeDivider from './ModelChangeDivider';

const FROM = 'github-copilot/gemini-4-carbon#high';
const TO = 'github-copilot/claude-opus-5.5#max';
const web = createWebAPIs();
let isVSCode = false;
const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <RuntimeAPIContext.Provider value={{ ...web, runtime: { ...web.runtime, isVSCode } }}>
        <BaseI18nProvider>{children}</BaseI18nProvider>
    </RuntimeAPIContext.Provider>
);

describe('ModelChangeDivider', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;

    beforeEach(() => {
        const win = new Window({ url: 'http://localhost' });
        const globals = {
            window: win, document: win.document, HTMLElement: win.HTMLElement,
            Element: win.Element, SVGElement: win.SVGElement, NodeList: win.NodeList,
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
        isVSCode = false;
        useConfigStore.setState({ currentProviderId: '', currentModelId: '', providers: [] });
    });

    const renderDivider = () => act(async () => root.render(
        <I18nProvider>
            <ModelAttributionProvider value={{}}>
                <ModelChangeDivider from={FROM} to={TO} />
            </ModelAttributionProvider>
        </I18nProvider>,
    ));

    test('keeps both full model references in wrapping, selectable text with a full-text title', async () => {
        await renderDivider();
        const divider = container.querySelector('[data-model-changed-divider]');
        const text = divider?.querySelector('[title]');
        const expected = `Model changed: ${FROM} → ${TO}`;
        expect(text?.textContent).toBe(expected);
        expect(text?.getAttribute('title')).toBe(expected);
        // The bug: `whitespace-nowrap` (and a truncating ancestor) cut the
        // destination model off with no way to read it.
        const classes = text?.className.split(/\s+/) ?? [];
        expect(classes).not.toContain('whitespace-nowrap');
        expect(classes).not.toContain('truncate');
        expect(classes).toContain('[overflow-wrap:anywhere]');
        expect(classes).toContain('min-w-0');
        expect(classes).not.toContain('select-none');
    });

    test('offers no prefer action while a direct model is selected', async () => {
        useConfigStore.setState({ currentProviderId: 'github-copilot', currentModelId: 'claude-opus-5.5' });
        await renderDivider();
        expect(container.querySelector('[data-model-changed-prefer]')).toBeNull();
    });

    test('VS Code keeps the full notice but offers no server-only preference action', async () => {
        isVSCode = true;
        useConfigStore.setState({ currentProviderId: 'opencode-route', currentModelId: 'strong-pool' });
        await renderDivider();
        expect(container.textContent).toContain(FROM);
        expect(container.textContent).toContain(TO);
        expect(container.querySelector('[data-model-changed-prefer]')).toBeNull();
    });

    test('while a pool is selected, Prefer previous sends "prefer <from model>" without its variant', async () => {
        useConfigStore.setState({
            currentProviderId: 'opencode-route',
            currentModelId: 'strong-pool',
            providers: [{
                id: 'github-copilot', name: 'GitHub Copilot', activation: 'enabled', package: 'github-copilot',
                models: ['gemini-4-carbon', 'claude-opus-5.5'].map((id) => ({
                    id, modelID: id, providerID: 'github-copilot', name: id,
                    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [],
                    time: { released: 0 }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: 'active', enabled: true, limit: { context: 0, output: 0 },
                })),
            }],
        });
        const requests: Array<{ url: string; body: unknown }> = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ status: 'unknown', reason: 'test' }), { status: 200 });
        }, { preconnect: async () => {} });
        try {
            await renderDivider();
            const button = container.querySelector<HTMLButtonElement>('[data-model-changed-prefer]');
            expect(button?.getAttribute('title')).toContain('github-copilot/gemini-4-carbon');
            await act(async () => {
                button?.click();
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        } finally {
            globalThis.fetch = originalFetch;
        }
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toContain('/api/model-routes/interpret');
        expect(requests[0]?.body).toEqual({
            text: 'prefer github-copilot/gemini-4-carbon',
            context: {
                providers: ['github-copilot'],
                models: [
                    { id: 'gemini-4-carbon', providerID: 'github-copilot' },
                    { id: 'claude-opus-5.5', providerID: 'github-copilot' },
                ],
            },
        });
    });

    test('names both models without a reason when none is known', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <ModelAttributionProvider value={{}}>
                    <ModelChangeDivider from="openai/gpt-6-luna" to="github-copilot/gpt-6-luna#low" />
                </ModelAttributionProvider>
            </I18nProvider>,
        ));
        const divider = container.querySelector('[data-model-changed-divider]');
        expect(divider?.textContent).toContain('openai/gpt-6-luna');
        expect(divider?.textContent).toContain('github-copilot/gpt-6-luna#low');
        expect(divider?.textContent).not.toContain('(');
    });

    test('adds the failover reason when the attribution lookup has one', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <ModelAttributionProvider value={{
                    msg_1: {
                        providerID: 'github-copilot', modelID: 'gpt-6-luna', variant: 'low', routeID: 'fast-strong',
                        selection: { mode: 'ordered', reason: 'ordered' },
                        failover: {
                            providerID: 'openai', modelID: 'gpt-6-luna', variant: null,
                            errorTag: 'Timeout', errorMessage: 'first-token timeout',
                        },
                    },
                }}>
                    <ModelChangeDivider from="openai/gpt-6-luna" to="github-copilot/gpt-6-luna#low" assistantMessageId="msg_1" />
                </ModelAttributionProvider>
            </I18nProvider>,
        ));
        const divider = container.querySelector('[data-model-changed-divider]');
        expect(divider?.textContent).toContain('first-token timeout');
    });

    test('falls back to the selection reason when there was no failover', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <ModelAttributionProvider value={{
                    msg_1: {
                        providerID: 'github-copilot', modelID: 'gpt-6-luna', variant: 'low', routeID: 'fast-strong',
                        selection: { mode: 'round-robin', reason: 'drawn' },
                        failover: null,
                    },
                }}>
                    <ModelChangeDivider from="openai/gpt-6-luna" to="github-copilot/gpt-6-luna#low" assistantMessageId="msg_1" />
                </ModelAttributionProvider>
            </I18nProvider>,
        ));
        const divider = container.querySelector('[data-model-changed-divider]');
        expect(divider?.textContent).toContain('drawn');
    });
});
