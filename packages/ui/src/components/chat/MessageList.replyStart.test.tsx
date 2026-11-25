import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import type { MessageListHandle } from './MessageList';
import { ChatColumnSessionContext } from './chatColumnSession';
import { I18nProvider } from '@/lib/i18n';
import type { ChatMessageEntry } from './lib/turns/types';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';

// Bun does not implement Vite's worker URL imports.
plugin({
    name: 'reply-start-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
            loader: 'js',
        }));
    },
});
const { default: MessageList } = await import('./MessageList');

const SESSION = 'reply-start-navigation';

// Two turns, each a prompt row and a reply row with prose.
const messages = (): ChatMessageEntry[] => {
    const turn = (prefix: string, created: number): ChatMessageEntry[] => {
        const userId = `${prefix}-user`;
        const replyId = `${prefix}-reply`;
        return [
            {
                info: { id: userId, sessionID: SESSION, role: 'user', time: { created } },
                parts: [{ id: `${prefix}-prompt`, sessionID: SESSION, messageID: userId, type: 'text', text: 'Question' }],
            },
            {
                info: {
                    id: replyId,
                    sessionID: SESSION,
                    role: 'assistant',
                    agent: 'build',
                    providerID: 'mock',
                    modelID: 'mock',
                    finish: 'stop',
                    time: { created: created + 1, completed: created + 2 },
                },
                parts: [{ id: `${replyId}-text`, sessionID: SESSION, messageID: replyId, type: 'text', text: 'Answer' }],
            },
        ];
    };
    return [...turn('older', 1), ...turn('newer', 10)];
};

const stubRect = (element: Element, top: number, height = 320): void => {
    const rect = {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 800,
        width: 800,
        x: 0,
        y: top,
        toJSON: () => ({}),
    };
    Object.defineProperty(element, 'getBoundingClientRect', { value: () => rect, configurable: true });
};

const start = async () => {
    const dom = new Window({ url: 'https://app.test' });
    const values = {
        window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element,
        Node: dom.Node, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
        getComputedStyle: dom.getComputedStyle.bind(dom), ResizeObserver: dom.ResizeObserver, MutationObserver: dom.MutationObserver,
        requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    Object.defineProperties(dom.HTMLElement.prototype, {
        clientHeight: { configurable: true, get: () => 800 },
        clientWidth: { configurable: true, get: () => 800 },
    });
    // The scroll node sits at the top of the window; every row's position is
    // stubbed per test, relative to that edge.
    dom.HTMLElement.prototype.getBoundingClientRect = () => new dom.DOMRect(0, 0, 800, 320);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise(() => {});
    const sdk = OpenCode.make({ baseUrl: 'https://timeline.test', fetch: () => new Promise<Response>(() => {}) });
    const unavailable = (): never => { throw new Error('Reply navigation must not call runtime APIs'); };
    const runtime: RuntimeAPIs = {
        runtime: { platform: 'web', isDesktop: false, isVSCode: false },
        get terminal() { return unavailable(); }, get git() { return unavailable(); },
        get files() { return unavailable(); }, get settings() { return unavailable(); },
        get permissions() { return unavailable(); }, get notifications() { return unavailable(); },
        get sourceControl() { return unavailable(); },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const ref = React.createRef<MessageListHandle>();
    await act(async () => {
        root.render(
            <RuntimeAPIContext.Provider value={runtime}>
                <ThemeSystemProvider>
                    <SyncProvider sdk={sdk} directory="/repo">
                        <I18nProvider>
                            <ChatColumnSessionContext.Provider value={{ sessionId: SESSION, directory: '/repo' }}>
                                <MessageList
                                    ref={ref}
                                    sessionKey={SESSION}
                                    messages={messages()}
                                    isLoadingOlder={false}
                                    scrollContainerProps={{ 'data-scrollbar': 'chat' }}
                                />
                            </ChatColumnSessionContext.Provider>
                        </I18nProvider>
                    </SyncProvider>
                </ThemeSystemProvider>
            </RuntimeAPIContext.Provider>,
        );
    });
    for (let index = 0; index < 5; index += 1) {
        await act(async () => { await new Promise<void>((resolve) => dom.setTimeout(resolve, 0)); });
    }
    const container = host.querySelector<HTMLElement>('[data-scrollbar="chat"]');
    if (!container || !ref.current) throw new Error('Missing timeline');
    const row = (messageId: string): HTMLElement => {
        const element = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
        if (!element) throw new Error(`Missing row ${messageId}`);
        return element;
    };
    // A reply is measured by its prose, not by its row.
    const placeReply = (messageId: string, proseTop: number): void => {
        const element = row(messageId);
        stubRect(element, proseTop - 40);
        const prose = element.querySelector<HTMLElement>('[data-message-text-export-source]');
        if (!prose) throw new Error(`Missing prose in ${messageId}`);
        stubRect(prose, proseTop, 200);
    };
    const placeRow = (messageId: string, top: number): void => stubRect(row(messageId), top);
    const done = async () => {
        await act(async () => root.unmount());
        globalThis.fetch = originalFetch;
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    };
    return { ref, row, placeReply, placeRow, done };
};

test('a reply whose first row is virtualized out is the target while its slice row is at the top', async () => {
    const { ref, row, placeReply, placeRow, done } = await start();
    try {
        // The reader is two screens into the newer reply: both prompts and the
        // older reply are above the top, the newer reply's own first row is out
        // of the list, and only a slice row of it sits at the content top.
        placeRow('older-user', -1400);
        placeReply('older-reply', -1100);
        placeRow('newer-user', -700);
        const slice = row('newer-reply');
        slice.setAttribute('data-message-slice', '1');
        stubRect(slice, -100);

        expect(ref.current?.findPreviousReplyStart(['older-reply', 'newer-reply'])).toBe('newer-reply');
    } finally {
        await done();
    }
});

test('a reply whose first row has no prose is not a reply start', async () => {
    const { ref, row, placeReply, placeRow, done } = await start();
    try {
        placeRow('older-user', -1400);
        placeReply('older-reply', -1100);
        placeRow('newer-user', -700);
        // The newer reply opens with tool rows: its text is in a later row, so
        // landing on this row would put the reader on the work, not the reply.
        const toolOnly = row('newer-reply');
        for (const source of toolOnly.querySelectorAll('[data-message-text-export-source]')) {
            source.removeAttribute('data-message-text-export-source');
        }
        stubRect(toolOnly, -100);

        expect(ref.current?.findPreviousReplyStart(['older-reply', 'newer-reply'])).toBe('older-reply');
    } finally {
        await done();
    }
});

test('an unmounted reply older than the row at the content top is the target', async () => {
    const { ref, row, placeReply, done } = await start();
    try {
        // The older reply has no row in the list at all; the reader is at the
        // top of the newer turn, whose reply is below the top edge.
        row('older-reply').removeAttribute('data-message-id');
        stubRect(row('older-user'), -1400);
        stubRect(row('newer-user'), 0);
        placeReply('newer-reply', 300);

        expect(ref.current?.findPreviousReplyStart(['older-reply', 'newer-reply'])).toBe('older-reply');
    } finally {
        await done();
    }
});
