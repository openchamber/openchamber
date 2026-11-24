import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { ChatColumnSessionContext } from './chatColumnSession';
import { FormDockModeContext } from './formsInChat';
import { I18nProvider } from '@/lib/i18n';
import type { ChatMessageEntry } from './lib/turns/types';
import type { AssistantMessage, StructuredError, ToolPart } from '@/lib/opencode/model';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';

// Bun does not implement Vite's worker URL imports.
plugin({
    name: 'question-card-row-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
            loader: 'js',
        }));
    },
});
const { default: MessageList } = await import('./MessageList');

const SESSION = 'question-card-row';
const QUESTION = 'question-call';

const user = (): ChatMessageEntry => ({
    info: { id: 'user', sessionID: SESSION, role: 'user', time: { created: 1 } },
    parts: [{ id: 'prompt', sessionID: SESSION, messageID: 'user', type: 'text', text: 'Ship it?' }],
});

const questionPart = (state: 'answered' | 'stopped' | 'waiting'): ToolPart => {
    const base = { type: 'tool', tool: 'question', id: QUESTION, callID: QUESTION, sessionID: SESSION, messageID: 'reply' } as const;
    const input = { questions: [{ question: 'Ship the release?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] };
    if (state === 'answered') {
        return {
            ...base,
            state: {
                status: 'completed', input,
                output: 'User has answered your questions: "Ship the release?"="Yes". You can now continue with the user\'s answers in mind.',
                metadata: {}, time: { start: 3, end: 4 },
            },
        };
    }
    if (state === 'waiting') return { ...base, state: { status: 'running', input, time: { start: 3 } } };
    return { ...base, state: { status: 'error', input, error: 'All fibers interrupted without error', time: { start: 3, end: 4 } } };
};

/** The assistant step: the reader's prompt, then the question call, which ends the message. */
const reply = (state: 'answered' | 'stopped' | 'waiting', error?: StructuredError): ChatMessageEntry => {
    const info: AssistantMessage = {
        id: 'reply', sessionID: SESSION, role: 'assistant', agent: 'build', providerID: 'mock', modelID: 'mock',
        finish: state === 'waiting' ? undefined : 'stop',
        time: { created: 2, completed: state === 'waiting' ? undefined : 5 },
    };
    if (error) info.error = error;
    return {
        info,
        parts: [
            // Sealed: an unfinished text block is held back while the turn runs.
            { id: 'reply-text', sessionID: SESSION, messageID: 'reply', type: 'text', text: 'Looking at the release first.', time: { start: 2, end: 3 } },
            questionPart(state),
        ],
    };
};

const start = async (state: 'answered' | 'stopped' | 'waiting', options: { formsInChat?: boolean; error?: StructuredError } = {}) => {
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
    dom.HTMLElement.prototype.getBoundingClientRect = () => new dom.DOMRect(0, 0, 800, 320);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise(() => {});
    const sdk = OpenCode.make({ baseUrl: 'https://timeline.test', fetch: () => new Promise<Response>(() => {}) });
    const unavailable = (): never => { throw new Error('Question rows must not call runtime APIs'); };
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
    await act(async () => {
        root.render(
            <RuntimeAPIContext.Provider value={runtime}>
                <ThemeSystemProvider>
                    <SyncProvider sdk={sdk} directory="/repo">
                        <I18nProvider>
                            <FormDockModeContext.Provider value={(options.formsInChat ?? false) ? 'in-chat' : 'dock'}>
                                <ChatColumnSessionContext.Provider value={{ sessionId: SESSION, directory: '/repo' }}>
                                    <MessageList
                                        sessionKey={SESSION}
                                        messages={[user(), reply(state, options.error)]}
                                        isLoadingOlder={false}
                                        scrollContainerProps={{ 'data-scrollbar': 'chat' }}
                                    />
                                </ChatColumnSessionContext.Provider>
                            </FormDockModeContext.Provider>
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
    if (!container) throw new Error('Missing timeline');
    const done = async () => {
        await act(async () => root.unmount());
        globalThis.fetch = originalFetch;
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    };
    return { container, done };
};

test('a message that ends in a question keeps one row, with the card and the turn facts under it', async () => {
    const { container, done } = await start('answered');
    try {
        const rows = [...container.querySelectorAll<HTMLElement>('[data-message-id="reply"]')];
        // The message's text row, then the card row, and only the first names
        // the message for navigation (`data-message-slice` is the row's).
        expect(rows).toHaveLength(2);
        const anchor = rows.filter((row) => !row.hasAttribute('data-message-slice'));
        expect(anchor).toHaveLength(1);
        const card = rows.find((row) => row.querySelector('[data-question-turn-header]'));
        expect(card).toBeTruthy();
        // The card did not swallow the message: the facts row is under it, and
        // the text before the call is drawn once.
        expect(card!.querySelector('.message-footer__facts')).toBeTruthy();
        expect(container.textContent!.split('Looking at the release first.').length - 1).toBe(1);
        expect(container.textContent).toContain('Yes');
    } finally {
        await done();
    }
});

test('a turn that stopped while a question waited keeps the failure text under the card', async () => {
    const { container, done } = await start('stopped', { error: { type: 'ProviderError', message: 'rate limited' } });
    try {
        expect(container.textContent).toContain('Stopped before an answer');
        expect(container.textContent).toContain('rate limited');
    } finally {
        await done();
    }
});

test('with the question in the chat, a waiting call draws no card and its message keeps its anchor', async () => {
    const { container, done } = await start('waiting', { formsInChat: true });
    try {
        expect(container.querySelector('[data-question-turn-header]')).toBeNull();
        const rows = [...container.querySelectorAll<HTMLElement>('[data-message-id="reply"]')];
        expect(rows).toHaveLength(1);
        expect(rows[0]!.textContent).toContain('Looking at the release first.');
    } finally {
        await done();
    }
});
