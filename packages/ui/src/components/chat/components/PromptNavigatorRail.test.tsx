import React, { act } from 'react';
import { afterEach, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import type { Part } from '@/lib/opencode/model';
import type { QuestionAnswerEntry } from '../lib/questionEntries';
import { PromptNavigatorRail } from './PromptNavigatorRail';

const browser = new Window({ url: 'http://localhost/' });
class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, SVGElement: browser.SVGElement,
    customElements: browser.customElements,
    Event: browser.Event, CustomEvent: browser.CustomEvent, MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: ResizeObserverStub,
});

const unavailable = (): never => { throw new Error('Prompt navigation must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => Response.json([]) });

const prompt: Part = { id: 'msg_user:text:0', sessionID: 'ses_1', messageID: 'msg_user', type: 'text', text: 'Deploy the release' };
const question: QuestionAnswerEntry = {
    partId: 'call_1:0',
    messageId: 'msg_assistant',
    header: 'Ship it',
    question: 'Ship it?',
    options: [{ label: 'Yes' }, { label: 'No' }],
    multiple: false,
    answer: 'Yes',
    pending: false,
};

afterEach(() => {
    useUIStore.setState({ listQuestionsInPromptSelector: false, isPromptNavigatorPanelOpen: false });
});

const renderRail = async (
    listQuestions: boolean,
    onSelectQuestion: (messageId: string) => void,
    entry: QuestionAnswerEntry = question,
) => {
    useUIStore.setState({ listQuestionsInPromptSelector: listQuestions, isPromptNavigatorPanelOpen: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    await act(async () => {
        root.render(
            <RuntimeAPIContext.Provider value={runtimeApis}>
                <SyncProvider sdk={sdk} directory="">
                    <I18nProvider>
                        <PromptNavigatorRail
                            sessionId="ses_1"
                            directory=""
                            turnIds={['msg_user']}
                            previewsByTurnId={new Map([['msg_user', [prompt]]])}
                            questionsByTurnId={new Map([['msg_user', [entry]]])}
                            activeTurnId="msg_user"
                            onSelectTurn={() => {}}
                            onSelectQuestion={onSelectQuestion}
                            canLoadEarlier={false}
                            isLoadingOlder={false}
                            onLoadEarlier={() => {}}
                        />
                    </I18nProvider>
                </SyncProvider>
            </RuntimeAPIContext.Provider>,
        );
    });
    return { container, root };
};

test('the selector nests an answered question under its prompt', async () => {
    const selected: string[] = [];
    const { container, root } = await renderRail(true, (messageId) => selected.push(messageId));
    try {
        expect(container.textContent).toContain('Deploy the release');
        expect(container.textContent).toContain('Ship it?');
        expect(container.textContent).toContain('Yes');
        const row = [...container.querySelectorAll('[title]')].find((node) => node.getAttribute('title')?.startsWith('Ship it?'));
        if (!(row instanceof HTMLElement)) throw new Error('Expected the question row');
        await act(async () => { row.click(); });
        expect(selected).toEqual(['msg_assistant']);
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});

test('the question row shows the answer without the tool\'s recommendation marker, on its own line', async () => {
    const recommended: QuestionAnswerEntry = {
        ...question,
        question: 'Which branch should the deploy use, given the freeze that starts tomorrow morning?',
        answer: 'release/2.7 (Recommended)',
    };
    const { container, root } = await renderRail(true, () => {}, recommended);
    try {
        const row = container.querySelector<HTMLElement>('[id="prompt-navigator-question-call_1:0"]');
        if (!row) throw new Error('Expected the question row');
        expect(row.getAttribute('title')).toBe(`${recommended.question} — release/2.7`);
        expect(row.textContent).not.toContain('(Recommended)');
        // The question and the answer are separate truncating lines, so a long
        // question cannot hide the answer the row exists for.
        const lines = [...row.querySelectorAll('span.block.truncate')].map((line) => line.textContent);
        expect(lines).toEqual([recommended.question, 'release/2.7']);
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});

test('the keyboard reaches a question row and Enter jumps to its message', async () => {
    const selected: string[] = [];
    const { container, root } = await renderRail(true, (messageId) => selected.push(messageId));
    try {
        const list = container.querySelector('[role="listbox"]');
        if (!(list instanceof HTMLElement)) throw new Error('Expected the listbox');
        await act(async () => {
            list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
        await act(async () => {
            list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(selected).toEqual(['msg_assistant']);
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});

test('a question arriving under an earlier prompt keeps the keyboard highlight on its row', async () => {
    const turns: string[] = [];
    useUIStore.setState({ listQuestionsInPromptSelector: true, isPromptNavigatorPanelOpen: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const secondPrompt: Part = { id: 'msg_b:text:0', sessionID: 'ses_1', messageID: 'msg_b', type: 'text', text: 'Ship the release' };
    const render = async (questions: QuestionAnswerEntry[]) => act(async () => {
        root.render(
            <RuntimeAPIContext.Provider value={runtimeApis}>
                <SyncProvider sdk={sdk} directory="">
                    <I18nProvider>
                        <PromptNavigatorRail
                            sessionId="ses_1"
                            directory=""
                            turnIds={['msg_user', 'msg_b']}
                            previewsByTurnId={new Map([['msg_user', [prompt]], ['msg_b', [secondPrompt]]])}
                            questionsByTurnId={new Map([['msg_user', questions]])}
                            activeTurnId="msg_b"
                            onSelectTurn={(turnId) => turns.push(turnId)}
                            onSelectQuestion={() => {}}
                            canLoadEarlier={false}
                            isLoadingOlder={false}
                            onLoadEarlier={() => {}}
                        />
                    </I18nProvider>
                </SyncProvider>
            </RuntimeAPIContext.Provider>,
        );
    });
    try {
        await render([]);
        // A question completes under the earlier prompt while the panel is open.
        await render([question]);
        const list = container.querySelector('[role="listbox"]');
        if (!(list instanceof HTMLElement)) throw new Error('Expected the listbox');
        await act(async () => {
            list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(turns).toEqual(['msg_b']);
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});

test('the selector leaves questions out when the setting is off', async () => {
    const { container, root } = await renderRail(false, () => {});
    try {
        expect(container.textContent).toContain('Deploy the release');
        expect(container.textContent).not.toContain('Ship it?');
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});

test('turning the setting off closes question rows in an open selector', async () => {
    const { container, root } = await renderRail(true, () => {});
    try {
        expect(container.textContent).toContain('Ship it?');
        await act(async () => {
            useUIStore.setState({ listQuestionsInPromptSelector: false });
        });
        expect(container.textContent).toContain('Deploy the release');
        expect(container.textContent).not.toContain('Ship it?');
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});
