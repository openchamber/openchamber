import React from 'react';
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
import type { QuestionAnswerEntry } from '../../lib/questionEntries';

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

const { QuestionCollapsedSummary, QuestionExpandedContent } = await import('./QuestionToolContent');

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

const entry = (overrides: Partial<QuestionAnswerEntry> = {}): QuestionAnswerEntry => ({
    partId: 'call_1:0',
    messageId: 'msg_assistant',
    header: 'Ship it',
    question: 'Ship it?',
    options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }],
    multiple: false,
    answer: 'Yes',
    pending: false,
    ...overrides,
});

const render = (node: React.ReactNode) => renderToStaticMarkup(
    <RuntimeAPIContext.Provider value={runtimeApis}>
        <SyncProvider sdk={sdk} directory="">
            <I18nProvider>{node}</I18nProvider>
        </SyncProvider>
    </RuntimeAPIContext.Provider>,
);
const text = (node: React.ReactNode) => {
    const container = browser.document.createElement('div');
    container.innerHTML = render(node);
    return container.textContent ?? '';
};

test('expanded rows show the question and every option, and omit an answer that is the marked option', () => {
    const content = text(<QuestionExpandedContent entries={[entry()]} />);
    expect(content).toContain('Ship it?');
    expect(content).toContain('Yes');
    expect(content).toContain('No');
    expect(content).toContain('Later');
    expect(content).not.toContain('Your answer');
});

test('expanded rows show a typed answer as one more chosen option, without labels', () => {
    const markup = render(<QuestionExpandedContent entries={[entry({ answer: 'Ship it on Friday' })]} />);
    const content = text(<QuestionExpandedContent entries={[entry({ answer: 'Ship it on Friday' })]} />);
    expect(content).toContain('Ship it on Friday');
    expect(content).not.toContain('Your answer');
    // No option matches, so the only filled radio is the typed answer's.
    expect(markup.split('size-1.5 rounded-full" style="background-color:var(--status-question)').length - 1).toBe(1);
});

test('expanded rows carry no header or selection-mode label, and an unanswered row says so', () => {
    const multiple = text(<QuestionExpandedContent entries={[entry({ header: 'Release gate', multiple: true, answer: 'Yes, Later' })]} />);
    expect(multiple).not.toContain('Release gate');
    expect(multiple).not.toContain('Select multiple');
    expect(multiple).not.toContain('Select one');
    const open = text(<QuestionExpandedContent entries={[entry({ answer: null, pending: false })]} />);
    expect(open).toContain('No answer');
});

test('a question whose call is still running says it is awaiting the answer', () => {
    const open = text(<QuestionExpandedContent entries={[entry({ answer: null, pending: true })]} />);
    expect(open).toContain('Awaiting response');
    expect(open).not.toContain('No answer');
    const collapsed = text(<QuestionCollapsedSummary entries={[entry({ answer: null, pending: true })]} />);
    expect(collapsed).toContain('Awaiting response');
    expect(collapsed).not.toContain('No answer');
});

test('expanded rows mark the option the tool recommended', () => {
    const content = render(<QuestionExpandedContent entries={[entry({ answer: 'Yes (Recommended)' })]} />);
    expect(content).toContain('size-1.5 rounded-full" style="background-color:var(--status-question)');
});

test('a multi-select reply that carries the recommendation marker on one pick marks both picks once', () => {
    const content = render(<QuestionExpandedContent entries={[entry({ multiple: true, answer: 'Yes (Recommended), No' })]} />);
    // Every row is a checkbox, two of them are the picks, and the reply is not
    // drawn again as a row of its own.
    expect(content.split('rounded-[3px]').length - 1).toBe(3);
    expect(content.split('border-color:var(--status-question)').length - 1).toBe(2);
    expect(content.split('class="sr-only">Chosen<').length - 1).toBe(2);
    expect(content).not.toContain('whitespace-pre-wrap');
    expect(content).not.toContain('Yes (Recommended)');
});

test('expanded rows show an option description', () => {
    const content = text(<QuestionExpandedContent entries={[entry({
        options: [{ label: 'Yes', description: 'Ships the release now' }, { label: 'No' }],
    })]} />);
    expect(content).toContain('Ships the release now');
});

test('collapsed rows drop the recommendation marker from the answer', () => {
    const content = text(<QuestionCollapsedSummary entries={[entry({ answer: 'Yes (Recommended)' })]} />);
    expect(content).toContain('Yes');
    expect(content).not.toContain('(Recommended)');
});

test('collapsed rows keep the question and answer but leave options out', () => {
    const content = text(<QuestionCollapsedSummary entries={[entry()]} />);
    expect(content).toContain('Ship it?');
    expect(content).toContain('Yes');
    expect(content).not.toContain('Later');
});

test('a long answer offers Show more', () => {
    const content = text(<QuestionExpandedContent entries={[entry({ answer: 'x'.repeat(200) })]} />);
    expect(content).toContain('Show more');
});

test('an empty row says it is waiting', () => {
    expect(text(<QuestionExpandedContent entries={[]} />)).toContain('Awaiting response');
});
