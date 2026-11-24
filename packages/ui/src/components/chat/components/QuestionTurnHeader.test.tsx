import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import type { Part, ToolPart } from '@/lib/opencode/model';

// The question row renders question text through the markdown renderer, which
// reads browser globals and resolves a Vite-supplied worker URL.
const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
    customElements: browser.customElements,
    Event: browser.Event, CustomEvent: browser.CustomEvent,
    MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});

plugin({
    name: 'question-tool-content-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
            loader: 'js',
        }));
    },
});

const { QuestionTurnHeader } = await import('./QuestionTurnHeader');
const { questionSentence } = await import('../lib/questionEntries');
const { useUIStore } = await import('@/stores/useUIStore');

const unavailable = (): never => { throw new Error('Question rendering must not call runtime APIs'); };
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

const ask = (questions: { question: string; answer: string }[], id = 'ask'): Part => ({
    type: 'tool', tool: 'question', id, callID: id, sessionID: 'session', messageID: 'msg_assistant',
    state: {
        status: 'completed',
        input: { questions: questions.map(({ question }, index) => ({ question, header: `H${index}`, options: [{ label: 'Yes' }, { label: 'No' }] })) },
        output: `User has answered your questions: ${questions.map(({ question, answer }) => `"${question}"="${answer}"`).join(', ')}. You can now continue with the user's answers in mind.`,
        metadata: {}, time: { start: 1, end: 2 },
    },
} as Part);

const wrap = (node: React.ReactNode) => (
    <RuntimeAPIContext.Provider value={runtimeApis}>
        <SyncProvider sdk={sdk} directory="">
            <I18nProvider>{node}</I18nProvider>
        </SyncProvider>
    </RuntimeAPIContext.Provider>
);
const render = (node: React.ReactNode) => renderToStaticMarkup(wrap(node));
const text = (node: React.ReactNode) => {
    const container = browser.document.createElement('div');
    container.innerHTML = render(node);
    return container.textContent ?? '';
};

const card = (part: Part, open = false) => (
    <QuestionTurnHeader part={part} messageId="msg_assistant" placement="row" open={open} onToggle={() => {}} />
);

test('the card shows the question and only the chosen answer, without the recommendation marker', () => {
    const content = text(card(ask([{ question: 'Ship it?', answer: 'Yes (Recommended)' }])));
    expect(content).toContain('Ship it?');
    expect(content).toContain('Yes');
    expect(content).not.toContain('(Recommended)');
    expect(content).not.toContain('No');
});

const batch = () => ask([
    { question: 'Retry on timeout?', answer: 'Yes, retry once' },
    { question: 'Update the README?', answer: 'No' },
]);

test('collapsed, every question is the same two lines: the question, then its answer', () => {
    // One question and a batch read the same way; the count never changes the
    // shape, which is what made a batch look like a table.
    const one = text(card(ask([{ question: 'Retry on timeout?', answer: 'Yes, retry once' }])));
    const many = text(card(batch()));
    for (const content of [one, many]) {
        expect(content).toContain('Retry on timeout?');
        expect(content).toContain('Yes, retry once');
    }
    expect(many).toContain('Update the README?');
    // No two-column grid: the header is not used as a table label alone.
    expect(many).not.toContain('H0');
    expect(many).not.toContain('H1');
});

const mounted = async (run: (container: HTMLElement, mount: (node: React.ReactNode) => Promise<void>) => Promise<void>) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await run(container, async (node) => { await act(async () => root.render(wrap(node))); });
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
};
const click = async (element: Element | null | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => element!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }) as unknown as MouseEvent));
};
const buttonNamed = (container: HTMLElement, name: string) => [...container.querySelectorAll('button')].find((button) => button.textContent === name);
const optionMarks = (container: HTMLElement) => container.querySelectorAll('.rounded-full.border').length;

test('opened, every question lists its options, one question or many', async () => {
    await mounted(async (container, mount) => {
        await mount(card(batch(), true));
        expect(container.textContent).toContain('Retry on timeout?');
        // Two options each, and the first answer was typed: one more marked row.
        // Opening is the only step; there is no second "Show options".
        expect(optionMarks(container)).toBe(5);
        expect(buttonNamed(container, 'Show options')).toBeUndefined();
    });
});

test('a pinned batch leaves a one-line bar of its answers once it scrolls away, which opens the card there', async () => {
    useUIStore.setState({ stickyUserHeader: true });
    try {
        await mounted(async (container) => {
            container.setAttribute('data-scrollbar', 'chat');
            const row = document.createElement('div');
            container.appendChild(row);
            const rowRoot = createRoot(row);
            await act(async () => rowRoot.render(wrap(card(batch()))));
            // In place, nothing covers the chat's top.
            expect(row.querySelector('[data-turn-sticky-header]')).toBeNull();
            // The list pins the row and reports how far it moved it.
            row.style.setProperty('--sticky-row-offset', '600px');
            await act(async () => { row.dispatchEvent(new browser.Event('stickyrowoffset', { bubbles: true }) as unknown as Event); });
            const bar = row.querySelector('[data-question-bar]');
            expect(bar?.hasAttribute('data-turn-sticky-header')).toBe(true);
            expect(bar?.textContent).toContain('2 answers');
            expect(bar?.textContent).toContain('Yes, retry once, No');
            const barButton = bar?.querySelector('button');
            expect(barButton?.getAttribute('aria-expanded')).toBe('false');
            await click(barButton);
            // The bar stays the control that was pressed, so the state it now
            // reports is the one it announced.
            expect(bar?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
            expect(bar?.textContent).toContain('Retry on timeout?');
            await click(buttonNamed(row, 'Show less') ?? [...row.querySelectorAll('[data-question-bar] button')].find((button) => button.textContent === 'Show less'));
            expect(row.querySelector('[data-question-bar]')?.textContent).toContain('2 answers');
            // Back at its place, the bar goes.
            row.style.removeProperty('--sticky-row-offset');
            await act(async () => { row.dispatchEvent(new browser.Event('stickyrowoffset', { bubbles: true }) as unknown as Event); });
            expect(row.querySelector('[data-question-bar]')).toBeNull();
            await act(async () => rowRoot.unmount());
        });
    } finally {
        useUIStore.setState({ stickyUserHeader: false });
    }
});

test('the card is a toggle that reports whether the options are open', () => {
    expect(render(card(ask([{ question: 'Ship it?', answer: 'Yes' }])))).toContain('aria-expanded="false"');
    expect(render(card(ask([{ question: 'Ship it?', answer: 'Yes' }]), true))).toContain('aria-expanded="true"');
});

type AskedQuestion = { question: string; header: string; options: { label: string; description?: string }[]; multiple?: boolean };

const askWith = (questions: {
    question: string;
    answer: string;
    multiple?: boolean;
    options?: { label: string; description?: string }[];
}[]): ToolPart => {
    const asked = questions.map((question) => {
        const askedQuestion: AskedQuestion = {
            question: question.question,
            header: 'H',
            options: question.options ?? [{ label: 'Yes' }, { label: 'No' }],
        };
        if (question.multiple) askedQuestion.multiple = true;
        return askedQuestion;
    });
    return {
        type: 'tool', tool: 'question', id: 'ask', callID: 'ask', sessionID: 'session', messageID: 'msg_assistant',
        state: {
            status: 'completed',
            input: { questions: asked },
            output: `User has answered your questions: ${questions.map(({ question, answer }) => `"${question}"="${answer}"`).join(', ')}. You can now continue with the user's answers in mind.`,
            metadata: {}, time: { start: 1, end: 2 },
        },
    };
};

const domOf = (node: React.ReactNode) => {
    const container = browser.document.createElement('div');
    container.innerHTML = render(node);
    return container;
};

test('a multi-select question marks its picks with checkboxes, a single-select one with dots', () => {
    const multiple = render(card(askWith([{ question: 'Which ones?', answer: 'Yes', multiple: true }]), true));
    expect(multiple).toContain('rounded-[3px]');
    expect(multiple).not.toContain('rounded-full');
    const single = render(card(askWith([{ question: 'Which one?', answer: 'Yes' }]), true));
    expect(single).toContain('rounded-full');
    expect(single).not.toContain('rounded-[3px]');
});

test('every span that carries its own text direction aligns with the interface', () => {
    const open = domOf(card(askWith([{
        question: 'Ship it?',
        answer: 'Not yet',
        options: [{ label: 'Yes', description: 'Merge now' }, { label: 'No', description: 'Wait for review' }],
    }]), true));
    const spans = [...open.querySelectorAll('[dir="auto"]')];
    expect(spans.length).toBeGreaterThan(4);
    // A right-to-left interface aligns a left-to-right answer with its rows;
    // the class is what carries the interface's start edge into the span.
    for (const span of spans) expect(span.classList.contains('oc-ui-start-align')).toBe(true);
});

test('option text nobody chose reads at full muted strength, not a fraction of the foreground', () => {
    const open = render(card(askWith([{
        question: 'Ship it?',
        answer: 'Not yet',
        options: [{ label: 'Yes', description: 'Merge now' }, { label: 'No', description: 'Wait for review' }],
    }]), true));
    expect(open).toContain('text-muted-foreground');
    expect(open).not.toContain('text-foreground/50');
    expect(open).not.toContain('text-foreground/60');
});

test('the chosen option says so in words a screen reader hears', () => {
    const open = domOf(card(askWith([{ question: 'Ship it?', answer: 'No' }]), true));
    const hidden = [...open.querySelectorAll('.sr-only')].map((element) => element.textContent);
    expect(hidden).toContain('Chosen');
});

test('a question left blank in an answered call is not reported as a stopped run', () => {
    const content = text(card(ask([
        { question: 'Ship it?', answer: 'Yes' },
        { question: 'Tag the release?', answer: '' },
    ])));
    expect(content).toContain('Not answered');
    expect(content).not.toContain('Stopped before an answer');
});

test('the question sentence is the last one that asks, after any lead-in', () => {
    expect(questionSentence('src/fetch.ts sets TIMEOUT_MS = 5000. (Note: the file does not exist yet.) Should I change it, and how?'))
        .toBe('Should I change it, and how?');
    expect(questionSentence('Want me to send the reply?')).toBe('Want me to send the reply?');
    expect(questionSentence('Pick a colour')).toBe('Pick a colour');
});

test('opened, the card lists every option and marks the chosen one; a typed answer is one more marked row', () => {
    const chosen = render(card(ask([{ question: 'Ship it?', answer: 'No' }]), true));
    const chosenText = text(card(ask([{ question: 'Ship it?', answer: 'No' }]), true));
    expect(chosenText).toContain('Yes');
    expect(chosenText).toContain('No');
    expect(chosen.split('size-1.5 rounded-full').length - 1).toBe(1);
    const typed = text(card(ask([{ question: 'Ship it?', answer: 'Ship it on Friday' }]), true));
    expect(typed).toContain('Yes');
    expect(typed).toContain('Ship it on Friday');
});

test('the card is a part of its message, not the row: the row carries the message anchor', () => {
    // `ChatMessage` draws the row around the card, so the anchor and the
    // slice live there; a second copy on the card would be a second row.
    expect(render(card(ask([{ question: 'Ship it?', answer: 'Yes' }])))).not.toContain('data-message-id=');
    expect(render(card(ask([{ question: 'Ship it?', answer: 'Yes' }])))).toContain('data-question-turn-header');
});

test('a question row and a fold preview of the same part share one open state, which survives a remount', async () => {
    const part = ask([{ question: 'Ship the release?', answer: 'Yes' }], 'ask_shared');
    const row = () => <QuestionTurnHeader part={part} messageId="msg_assistant" placement="row" />;
    const preview = () => <QuestionTurnHeader part={part} messageId="msg_assistant" pinnable={false} placement="preview" />;
    await mounted(async (container, mount) => {
        await mount(<>{row()}{preview()}</>);
        expect(container.querySelectorAll('[aria-expanded="false"]').length).toBe(2);
        await click(buttonNamed(container, 'Show more'));
        // The preview follows the transcript row's decision.
        expect(container.querySelectorAll('[aria-expanded="true"]').length).toBe(2);
    });
    // Drawn again after a session switch: the decision is remembered.
    await mounted(async (container, mount) => {
        await mount(row());
        expect(container.querySelector('[aria-expanded="true"]')).toBeTruthy();
    });
});

test('the card\'s tail corner is its inline end, so it points outward in Arabic too', () => {
    const markup = render(card(ask([{ question: 'Ship it?', answer: 'Yes' }])));
    expect(markup).toContain('border-end-end-radius:var(--radius-sm)');
    expect(markup).not.toContain('border-bottom-right-radius');
});

test('the card fits its content, aligns right and uses transcript typography', () => {
    const markup = render(card(ask([{ question: 'Ship it?', answer: 'Yes' }])));
    expect(markup).toContain('flex flex-col items-end');
    expect(markup).toContain('max-w-[85%]');
    expect(markup).toContain('typography-meta');
    expect(markup).toContain('typography-markdown');
    expect(markup).not.toContain('text-base');
    // The card is the prompt bubble with the question colour mixed into the
    // bubble's own fill, so it is opaque and follows the theme's bubble colour.
    // Mixing the role's `-background` tint instead would carry that tint's own
    // alpha through and leave the transcript readable through the card.
    expect(markup).toContain('background-color:color-mix(in srgb, var(--status-question) 14%, var(--chat-user-message-bg))');
    expect(markup).not.toContain('--status-question-background');
    expect(markup).not.toContain('--surface-background');
    // The prompt bubble's padding and radii, so the card lines up with a prompt.
    expect(markup).toContain('px-5 py-3 shadow-none border border-primary/5');
    expect(markup).toContain('border-radius:var(--radius-xl)');
    // The APK build asserts this reaches the packaged bundle.
    expect(markup).toContain('data-question-card-bubble');
    // A question carries its own mark, so it never reads as a quoted line.
    expect(markup).toContain('#oc-question');
});

test('text is selectable and expansion uses the native message link instead of a clickable card', () => {
    const part = ask([{ question: 'Ship it?', answer: 'Yes' }]);
    const markup = render(card(part));
    expect(markup).toContain('select-text');
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('brightness-110');
    expect(text(card(part))).toContain('Show more');
    expect(text(card(part, true))).toContain('Show less');
    expect(markup).toContain('hover:underline');
});

test('native click parity: collapsed text opens, selected text does not, open text does not close, links toggle once', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const part = ask([{ question: 'Ship it?', answer: 'Yes' }]);
    let toggles = 0;
    const draw = async (open: boolean) => {
        await act(async () => root.render(wrap(
            <QuestionTurnHeader part={part} messageId="msg_assistant" placement="row" open={open} onToggle={() => { toggles += 1; }} />,
        )));
    };
    const click = async (element: Element) => {
        await act(async () => element.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }) as unknown as MouseEvent));
    };
    try {
        await draw(false);
        const question = container.querySelector('[title="Ship it?"]')!;
        await click(question);
        expect(toggles).toBe(1);

        const range = document.createRange();
        range.selectNodeContents(question);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        await click(question);
        expect(toggles).toBe(1);
        expect(window.getSelection()!.toString()).toBe('Ship it?');
        window.getSelection()!.removeAllRanges();

        await draw(true);
        await click(container.querySelector('[title="Ship it?"]')!);
        expect(toggles).toBe(1);
        await click(container.querySelector('button')!);
        expect(toggles).toBe(2);

        await draw(false);
        await click(container.querySelector('button')!);
        expect(toggles).toBe(3);
    } finally {
        window.getSelection()!.removeAllRanges();
        await act(async () => root.unmount());
        container.remove();
    }
});

const callIn = (state: Record<string, unknown>): Part => ({
    type: 'tool', tool: 'question', id: 'ask', callID: 'ask', sessionID: 'session', messageID: 'msg_assistant',
    state: { input: { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] }, ...state },
} as unknown as Part);

test('a question without an answer keeps the card and says what happened', () => {
    const waiting = text(card(callIn({ status: 'running', time: { start: 1 } })));
    expect(waiting).toContain('Ship it?');
    expect(waiting).toContain('Awaiting response');
    const dismissed = text(card(callIn({ status: 'error', error: 'The user dismissed this question', errorType: 'QuestionRejectedError', time: { start: 1, end: 2 } })));
    expect(dismissed).toContain('Not answered');
    const stopped = text(card(callIn({ status: 'error', error: 'All fibers interrupted without error', time: { start: 1, end: 2 } })));
    expect(stopped).toContain('Stopped before an answer');
    for (const markup of [waiting, dismissed, stopped]) expect(markup).toContain('Show more');
});

test('only an answered card sticks, and an unanswered one lists the options with none marked', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const mount = async (node: React.ReactNode) => { await act(async () => root.render(wrap(node))); return container.innerHTML; };
    const dismissed = callIn({ status: 'error', error: 'The user dismissed this question', errorType: 'QuestionRejectedError', time: { start: 1, end: 2 } });
    useUIStore.setState({ stickyUserHeader: true });
    try {
        const sticky = await mount(card(ask([{ question: 'Ship it?', answer: 'Yes' }])));
        expect(sticky).toContain('data-turn-sticky-header');
        // The fade sits in the wrapper's bottom reserve, clear of the card.
        expect(sticky).toContain('pb-9');
        expect(await mount(card(dismissed))).not.toContain('data-turn-sticky-header');
        const open = await mount(card(dismissed, true));
        expect(container.textContent).toContain('Yes');
        expect(open.split('size-1.5 rounded-full').length - 1).toBe(0);
    } finally {
        useUIStore.setState({ stickyUserHeader: false });
        await act(async () => root.unmount());
        container.remove();
    }
});

test('with questions in the chat, a waiting question draws no card at its call; answered ones still do', async () => {
    const { FormDockModeContext } = await import('../formsInChat');
    const inChat = (node: React.ReactNode) => <FormDockModeContext.Provider value="in-chat">{node}</FormDockModeContext.Provider>;
    const waiting = callIn({ status: 'running', time: { start: 1 } });
    expect(text(inChat(card(waiting)))).toBe('');
    expect(text(card(waiting))).toContain('Awaiting response');
    expect(text(inChat(card(ask([{ question: 'Ship it?', answer: 'Yes' }]))))).toContain('Yes');
});
