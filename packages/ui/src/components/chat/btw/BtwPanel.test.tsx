import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { OpenCode } from '@opencode/client';
import { CONTEXT_METADATA_KEY } from '@/lib/messages/contextParts';
import { I18nProvider } from '@/lib/i18n';
import type { Session, SyntheticMessage, UserMessage } from '@/lib/opencode/model';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { createWebAPIs } from '../../../../../web/src/api/index';

// Bun does not implement Vite's worker URL imports.
plugin({ name: 'btw-worker-url', setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
} });
const { BtwPanel } = await import('./BtwPanel');

const directory = '/repo';
const sessionID = 'ses_btw';
const session: Session = {
    id: sessionID, projectID: 'project', directory, title: 'BTW', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 1 },
};
const quote: SyntheticMessage = {
    id: 'msg_1', sessionID, role: 'synthetic', time: { created: 1 }, text: 'Comment on an earlier message',
    metadata: { [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote: 'Earlier answer', text: 'Why is that?' } },
};
const user: UserMessage = { id: 'msg_2', sessionID, role: 'user', time: { created: 2 } };
const panel = {
    parentPromoted: false, btwSessionId: sessionID, btwDirectory: directory,
    boundaryMessageID: null, collapsed: false, creating: false, pending: false,
};
const names = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;

describe('BtwPanel', () => {
    let root: Root;
    let win: Window;
    let container: HTMLDivElement;
    let previous: Array<readonly [typeof names[number], PropertyDescriptor | undefined]>;
    let originalFetch: typeof fetch;
    const sdk = OpenCode.make({ baseUrl: 'http://btw.test', fetch: () => new Promise<Response>(() => undefined) });

    beforeEach(async () => {
        win = new Window({ url: 'http://localhost' });
        previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
            HTMLElement: win.HTMLElement, Event: win.Event, CustomEvent: win.CustomEvent, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
            requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
        for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
        originalFetch = globalThis.fetch;
        globalThis.fetch = () => new Promise<Response>(() => undefined);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => root.render(
            <SyncProvider sdk={sdk} directory={directory}>
                <RuntimeAPIContext.Provider value={createWebAPIs()}>
                    <ThemeSystemProvider><I18nProvider>
                        <BtwPanel parentSessionId="parent" panel={panel} hidden={false} onExit={() => {}} />
                    </I18nProvider></ThemeSystemProvider>
                </RuntimeAPIContext.Provider>
            </SyncProvider>,
        ));
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        globalThis.fetch = originalFetch;
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        void win.happyDOM.close();
    });

    test('renders a comment-only message in the transcript', async () => {
        const store = getSyncChildStores().getChild(directory);
        if (!store) throw new Error('Expected mounted directory store');
        await act(async () => store.setState({
            session: [session],
            message: { [sessionID]: [quote, user] },
            part: { [user.id]: [{ id: 'part', sessionID, messageID: user.id, type: 'text', text: '' }] },
        }));
        expect(container.textContent).toContain('Quoted from an earlier message');
        expect(container.textContent).toContain('Why is that?');
        const card = container.querySelector<HTMLElement>('[role="button"]');
        expect(card).not.toBeNull();
        await act(async () => card?.click());
        expect(container.textContent).toContain('Earlier answer');
    });

    test('keeps inherited context outside the boundary and renders a late context echo', async () => {
        await act(async () => root.render(
            <SyncProvider sdk={sdk} directory={directory}>
                <RuntimeAPIContext.Provider value={createWebAPIs()}>
                    <ThemeSystemProvider><I18nProvider>
                        <BtwPanel parentSessionId="parent" panel={{ ...panel, boundaryMessageID: 'boundary' }} hidden={false} onExit={() => {}} />
                    </I18nProvider></ThemeSystemProvider>
                </RuntimeAPIContext.Provider>
            </SyncProvider>,
        ));
        const store = getSyncChildStores().getChild(directory);
        if (!store) throw new Error('Expected mounted directory store');
        const inherited: UserMessage = { ...user, id: 'boundary' };
        const inheritedQuote: SyntheticMessage = {
            ...quote, id: 'old', metadata: { [CONTEXT_METADATA_KEY]: { kind: 'chat-quote', quote: 'Old quote', text: 'Old comment' } },
        };
        await act(async () => store.setState({
            session: [session],
            message: { [sessionID]: [inheritedQuote, inherited, user, quote] },
            part: { [user.id]: [{ id: 'part', sessionID, messageID: user.id, type: 'text', text: '' }] },
        }));
        expect(container.textContent).toContain('Why is that?');
        expect(container.textContent).not.toContain('Old comment');
    });
});
