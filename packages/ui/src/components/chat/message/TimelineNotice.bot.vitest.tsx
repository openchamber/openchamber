import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createRoot, type Root } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { DedicatedMobileAppProvider, type MobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import type { Message } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import { SyncProvider } from '@/sync/sync-context';
import { loadMarkdownRendererModule } from '../markdownRendererLoader';
import { TimelineNotice } from './TimelineNotice';

const unavailable = (): never => { throw new Error('Notice rendering must not call runtime APIs'); };
const originalFetch = globalThis.fetch;
const wire: typeof fetch = async (input) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input), 'http://localhost').pathname;
    if (pathname.endsWith('/event')) return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    if (pathname.endsWith('/fs/home')) return Response.json({ home: '/home/test' });
    if (pathname.endsWith('/session-warming')) return Response.json({ revision: 1, enabled: false, minutes: 60, sessions: [] });
    return Response.json({ data: [], cursor: {} });
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: wire });
const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); }, get git() { return unavailable(); },
    get files() { return unavailable(); }, get settings() { return unavailable(); },
    get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
const message: Message = {
    id: 'msg_bot', sessionID: 'ses_bot', role: 'synthetic', text: 'Review feedback details', description: 'Provider summary', time: { created: 1 },
    metadata: { source: 'openchamber-notice', kind: 'bot', projectId: 'project', itemId: 'item', eventId: 'event' },
};

describe('bot timeline notice', () => {
    let window: Window;
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(async () => {
        window = new Window({ url: 'http://localhost' });
        window.document.write('<!doctype html><html><body></body></html>');
        const globals = {
            window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
            HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, NodeList: window.NodeList, SVGElement: window.SVGElement,
            Text: window.Text, DocumentFragment: window.DocumentFragment,
            HTMLAnchorElement: window.HTMLAnchorElement, HTMLTableElement: window.HTMLTableElement, HTMLVideoElement: window.HTMLVideoElement,
            ResizeObserver: window.ResizeObserver, IntersectionObserver: window.IntersectionObserver,
            MutationObserver: window.MutationObserver, CustomEvent: window.CustomEvent,
            requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
            getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
            fetch: wire,
        };
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        await loadMarkdownRendererModule();
        host = document.createElement('div'); document.body.append(host); root = createRoot(host);
        useUIStore.setState({ isBotsPageOpen: false, botsPageTarget: null });
    });
    afterEach(async () => { await act(async () => root.unmount()); await window.happyDOM.close(); globalThis.fetch = originalFetch; });
    const render = async (mobile?: MobileAppActions) => {
        const notice = <TimelineNotice message={message} />;
        await act(async () => root.render(
            <RuntimeAPIContext.Provider value={apis}><SyncProvider sdk={sdk} directory=""><I18nProvider>
                {mobile ? <DedicatedMobileAppProvider actions={mobile}>{notice}</DedicatedMobileAppProvider> : notice}
            </I18nProvider></SyncProvider></RuntimeAPIContext.Provider>,
        ));
    };
    const expand = () => act(async () => host.querySelector<HTMLElement>('[role="button"][aria-expanded]')?.click());

    test('renders a collapsed system line and expands the complete provider text', async () => {
        // Given a synthetic bot event at the timeline's real renderer.
        await render();
        const toggle = host.querySelector<HTMLElement>('[role="button"][aria-expanded]');
        expect(host.textContent).toContain('Bot update');
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector('[data-message-role="user"]')).toBeNull();
        // When its disclosure opens.
        await act(async () => toggle?.click());
        // Then the existing disclosure exposes the full delivered text.
        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
        expect(host.textContent).toContain(message.text);
    });

    test('opens the recorded bot item using desktop navigation', async () => {
        // Given a rendered bot notice.
        await render(); await expand();
        const open = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open item');
        // When the item action is pressed.
        await act(async () => open?.click());
        // Then navigation targets the metadata's exact project and item.
        expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project', itemId: 'item' });
        expect(useUIStore.getState().isBotsPageOpen).toBe(true);
    });

    test('opens the recorded item in the dedicated mobile surface', async () => {
        // Given mobile navigation provided by the app shell.
        let opened = 0;
        const mobile: MobileAppActions = { openBots: () => { opened += 1; }, openChanges: unavailable, openFiles: unavailable,
            openSourceBoard: unavailable, openSettingsPage: unavailable, openUpdate: unavailable, openScheduledTasks: unavailable };
        await render(mobile); await expand();
        // When the same item action is pressed.
        await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open item')?.click());
        // Then mobile opens its own surface with the recorded item selected.
        expect(opened).toBe(1);
        expect(useUIStore.getState().botsPageTarget).toEqual({ projectId: 'project', itemId: 'item' });
        expect(useUIStore.getState().isBotsPageOpen).toBe(false);
    });
});
