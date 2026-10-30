import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Part, AssistantMessage } from '@/lib/opencode/model';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnChangedFile, TurnRecord } from '../lib/turns/types';
import { LiveTurnActivity } from './LiveTurnActivity';
import { useWorkflowRunsStore } from '@/lib/workflows/store';
import type { WorkflowRun } from '@/lib/workflows/model';
import { PendingWorkflowApprovals } from '../workflows/PendingWorkflowApprovals';
import { WorkflowsPanel } from '../workflows/WorkflowsPanel';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncChildStores } from '@/sync/sync-refs';
import { ChatColumnSessionContext } from '../chatColumnSession';

plugin({
    name: 'live-activity-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
        }));
        // Expand Vite's eager asset glob into the same real file URL map for
        // Bun. This is a loader transform, not a replacement of the logo hook.
        build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
            const folder = resolve(dirname(path), '../assets/provider-logos');
            const logos = Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.svg'))
                .map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(folder, name)).href]));
            const contents = readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`);
            return { contents, loader: 'ts' };
        });
    },
});

const unavailable = (): never => { throw new Error('Activity rendering must not call runtime APIs'); };
const runtimeApis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get sourceControl() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
};
const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const theme = getDefaultTheme(true);
const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], customThemesLoading: false,
    setTheme: unexpectedThemeChange, reloadCustomThemes: unexpectedThemeChange, importTheme: unexpectedThemeChange,
    deleteImportedTheme: unexpectedThemeChange, isSystemPreference: false, setSystemPreference: unexpectedThemeChange,
    themeMode: 'dark', setThemeMode: unexpectedThemeChange, lightThemeId: getDefaultTheme(false).metadata.id,
    darkThemeId: theme.metadata.id, setLightThemePreference: unexpectedThemeChange, setDarkThemePreference: unexpectedThemeChange,
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });
// The answer's action bar also has an aria-expanded button, the branch menu
// trigger, so the changed-file toggle is the one that opens no popup.
const changedFilesToggle = () => document.querySelector<HTMLButtonElement>('[data-fixture-message="final"] button[aria-expanded]:not([aria-haspopup])');
let MessageBody: typeof import('../message/MessageBody').default;

function assistant(id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: finish ? 3 : undefined },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    };
    return { info, parts };
}
function text(id: string, content: string): Part {
    return { type: 'text', id, text: content, sessionID: 'session', messageID: 'message' };
}
const readPart: Part = {
    type: 'tool', tool: 'read', id: 'read', callID: 'read', sessionID: 'session', messageID: 'progress',
    state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: 'code', metadata: {}, time: { start: 1, end: 2 } },
};
function turn(messages: ChatMessageEntry[]): TurnRecord {
    return projectTurnRecords([{
        info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } },
        parts: [text('request', 'Request')],
    }, ...messages]).turns[0];
}

function Harness({ record, retired = false, changedFiles, isLatestTurn = true, onCopyMessage, onCopyTurn }: {
    record: TurnRecord;
    retired?: boolean;
    changedFiles?: TurnChangedFile[];
    isLatestTurn?: boolean;
    onCopyMessage?: (messageId: string) => boolean;
    onCopyTurn?: () => Promise<boolean>;
}) {
    const [expanded, setExpanded] = React.useState(false);
    const renderMessage = (message: ChatMessageEntry) => (
        <div key={message.info.id} data-fixture-message={message.info.id}>
            <MessageBody
                messageId={message.info.id} parts={message.parts} isUser={false}
                isMessageCompleted={message.info.role === 'assistant' && Boolean(message.info.finish)}
                messageFinish={message.info.role === 'assistant' ? message.info.finish : undefined}
                isMobile={false} copiedCode={null} onCopyCode={() => undefined} expandedTools={new Set()}
                onToggleTool={() => undefined} onShowPopup={() => undefined} streamPhase="completed" allowAnimation={false}
                hasTextContent={message.parts.some((part) => part.type === 'text')} showReasoningTraces
                onCopyMessage={onCopyMessage ? () => onCopyMessage(message.info.id) : undefined}
                onCopyTurn={message === record.assistantMessages.at(-1) ? onCopyTurn : undefined}
                turnGroupingContext={{
                    turnId: 'user', isFirstAssistantInTurn: message === record.assistantMessages[0],
                    isLastAssistantInTurn: message === record.assistantMessages.at(-1),
                    isLatestTurn, changedFiles, isWorking: false, hasTools: record.hasTools, hasReasoning: record.hasReasoning,
                }}
            />
        </div>
    );
    return <RuntimeAPIContext.Provider value={runtimeApis}>
        <ThemeSystemContext.Provider value={themeContext}>
            <SyncProvider sdk={sdk} directory="/project">
                <I18nProvider>
                    <LiveTurnActivity turn={record} hasLaterAssistant={retired} expanded={expanded}
                        onToggle={() => setExpanded((value) => !value)} renderMessage={renderMessage} />
                </I18nProvider>
            </SyncProvider>
        </ThemeSystemContext.Provider>
    </RuntimeAPIContext.Provider>;
}

// The first test pays for loading the real message body and for its first
// render. Under the full parallel suite that crossed the 5 second default on
// Windows; later tests take well under a second.
setDefaultTimeout(30_000);

describe('live Activity with the real message body', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;
    beforeEach(async () => {
        const win = new Window({ url: 'http://localhost', settings: { device: { prefersReducedMotion: 'reduce' } } });
        const globals = {
            window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
            customElements: win.customElements,
            Node: win.Node, NodeList: win.NodeList, Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
            HTMLAnchorElement: win.HTMLAnchorElement,
            MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
            requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        // Reduced motion makes the disclosure lifecycle deterministic without
        // replacing the real component or animation module.
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        useUIStore.setState({ collapsibleThinkingBlocks: false, showSplitAssistantMessageActions: false });
        useDirectoryStore.setState({ currentDirectory: '/project' });
        useI18nStore.getState().setLocale('en');
        MessageBody = (await import('../message/MessageBody')).default;
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        useWorkflowRunsStore.getState().reset();
        restore();
    });

    test('keeps both proposed workflow cards outside Activity while approval is pending', async () => {
        useUIStore.setState({ agentWorkflowFeatureAvailable: true });
        const proposal = (id: string, messageID: string): Part => ({
            type: 'tool', tool: 'openchamber_workflow', id, callID: id, sessionID: 'session', messageID,
            state: { status: 'completed', input: { action: 'workflow.run' },
                output: JSON.stringify({ ok: true, action: 'workflow.run', data: { runId: id } }),
                time: { start: 1, end: 2 } },
        });
        const runs: WorkflowRun[] = ['first', 'second'].map((id) => ({
            id, parentSessionId: 'session', directory: '/project', name: `Workflow ${id}`, description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: ['Review'], agents: [], logs: [],
        }));
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs } } });
        const first = assistant('first-step', [proposal('first', 'first-step')], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([first])} />));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        const second = assistant('second-step', [proposal('second', 'second-step')], 'tool-calls');
        const record = turn([first, second, assistant('final', [text('answer', 'Choose the plans')], 'stop')]);
        await act(async () => root.render(<Harness record={record} />));
        const cards = () => [...container.querySelectorAll('[data-component="workflow-run"]')].map((card) => card.textContent);
        expect(cards()).toHaveLength(2);
        expect(cards()[0]).toContain('Workflow first');
        expect(cards()[1]).toContain('Workflow second');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(cards()).toHaveLength(2);
    });

    test('shows every pending run missing from loaded calls, then hands it over without duplication', async () => {
        useUIStore.setState({ agentWorkflowFeatureAvailable: true });
        const runs: WorkflowRun[] = ['first', 'second'].map((id) => ({
            id, parentSessionId: 'session', directory: '/project', name: `Workflow ${id}`, description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: [], agents: [], logs: [],
        }));
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs } } });
        const draw = (messages: ChatMessageEntry[], sessionId = 'session') => <SyncProvider sdk={sdk} directory="/project">
            <I18nProvider><PendingWorkflowApprovals sessionId={sessionId} messages={messages} /></I18nProvider>
        </SyncProvider>;
        await act(async () => root.render(draw([])));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(2);
        const call: Part = {
            type: 'tool', tool: 'openchamber_workflow', id: 'call', callID: 'call', sessionID: 'session', messageID: 'step',
            state: { status: 'completed', input: { action: 'workflow.run' },
                output: JSON.stringify({ ok: true, action: 'workflow.run', data: { runId: 'first' } }), time: { start: 1, end: 2 } },
        };
        await act(async () => root.render(draw([assistant('step', [call], 'tool-calls')])));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        expect(container.textContent).toContain('Workflow second');
        await act(async () => useWorkflowRunsStore.getState().apply({ ...runs[1], state: 'declined' }));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(0);
        await act(async () => root.render(draw([], 'other')));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(0);
    });

    test('the real live row and footer share workflow call parts while the message snapshot stays stale', async () => {
        // Happy DOM has no layout. Give the real virtualized list a viewport
        // so its row and footer both mount rather than remaining unmeasured.
        const geometry = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return new window.DOMRect(0, 0, 720, 600);
        });
        const { default: MessageList } = await import('../MessageList');
        // Leave bootstrap pending so only the test publishes the real live store.
        const liveSdk = OpenCode.make({ baseUrl: 'http://workflow.test', fetch: () => new Promise<Response>(() => {}) });
        useUIStore.setState({ agentWorkflowFeatureAvailable: true, activityRenderMode: 'summary' });
        const run: WorkflowRun = {
            id: 'streaming-run', parentSessionId: 'session', directory: '/project', name: 'Streaming approval', description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: [], agents: [], logs: [],
        };
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs: [run] } } });
        const step = assistant('live-step', [text('progress', 'Preparing approval')]);
        const record = turn([step]);
        let messages = [record.userMessage, step];
        const draw = () => <RuntimeAPIContext.Provider value={runtimeApis}>
            <ThemeSystemContext.Provider value={themeContext}>
                <SyncProvider sdk={liveSdk} directory="/project">
                    <I18nProvider>
                        <ChatColumnSessionContext.Provider value={{ sessionId: 'session', directory: '/project' }}>
                            <MessageList sessionKey="session" directory="/project" messages={messages}
                                sessionIsWorking activeStreamingMessageId={messages.at(-1)?.info.id} activeStreamingPhase="streaming" isLoadingOlder={false} />
                        </ChatColumnSessionContext.Provider>
                    </I18nProvider>
                </SyncProvider>
            </ThemeSystemContext.Provider>
        </RuntimeAPIContext.Provider>;
        await act(async () => root.render(draw()));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        const store = getSyncChildStores().getChild('/project');
        if (!store) throw new Error('Expected mounted directory store');
        const call: Part = {
            type: 'tool', tool: 'openchamber_workflow', id: 'live-call', callID: 'live-call', sessionID: 'session', messageID: 'live-step',
            state: { status: 'completed', input: { action: 'workflow.run' },
                output: JSON.stringify({ ok: true, action: 'workflow.run', data: { runId: run.id } }), time: { start: 1, end: 2 } },
        };
        await act(async () => store.setState({ part: { 'live-step': [...step.parts, call] } }));
        expect(messages[1].parts).toEqual(step.parts);
        expect(container.querySelectorAll('[data-turn-id] [data-component="workflow-run"]')).toHaveLength(1);
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        await act(async () => useUIStore.setState({ activityRenderMode: 'collapsed' }));
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        // A later step can stream while the preceding completed call still lives
        // only in the part store. Both consumers must keep overlaying that step.
        const next = assistant('next-step', [text('continuation', 'Continuing the work')]);
        messages = [...messages, next];
        await act(async () => root.render(draw()));
        expect(container.querySelectorAll('[data-turn-id] [data-component="workflow-run"]')).toHaveLength(1);
        expect(container.querySelectorAll('[data-component="workflow-run"]')).toHaveLength(1);
        geometry.mockRestore();
    });

    test('the panel declines through the same endpoint and holds both approval buttons during the request', async () => {
        useUIStore.setState({ agentWorkflowFeatureAvailable: true });
        useSessionUIStore.setState({ currentSessionId: 'session' });
        const run: WorkflowRun = {
            id: 'pending', parentSessionId: 'session', directory: '/project', name: 'Review files', description: 'Review files',
            state: 'awaiting-approval', attempt: 0, createdAt: 1, currentPhase: null, phases: [], agents: [], logs: [],
        };
        useWorkflowRunsStore.setState({ bySession: { session: { status: 'ready', runs: [run] } }, byDirectory: { '/project': 'ready' } });
        const requests: { url: string; method?: string }[] = [];
        let finish: () => void = () => {};
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            requests.push({ url, method: init?.method });
            if (url.endsWith('/pending/decline')) await new Promise<void>((resolve) => { finish = resolve; });
            return Response.json(url.includes('/saved') ? { workflows: [] } : {});
        });
        try {
            await act(async () => root.render(<I18nProvider><WorkflowsPanel directory="/project" /></I18nProvider>));
            const approve = container.querySelector<HTMLButtonElement>('button[aria-label="Run workflow"]');
            const decline = [...container.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === "Don't run");
            expect(approve).not.toBeNull();
            expect(decline).not.toBeNull();
            await act(async () => decline?.click());
            expect(requests.filter((request) => request.url.endsWith('/pending/decline'))).toEqual([
                { url: '/api/openchamber/workflows/pending/decline', method: 'POST' },
            ]);
            expect(approve?.disabled).toBe(true);
            expect(decline?.disabled).toBe(true);
            await act(async () => finish());
            expect(approve?.disabled).toBe(false);
            expect(decline?.disabled).toBe(false);
        } finally {
            finish();
            fetchSpy.mockRestore();
        }
    });

    test('keeps active prose and tools visible; stop folds history but leaves the answer', async () => {
        const progress = assistant('progress', [text('progress-text', 'Checking the source'), readPart], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([progress])} />));
        expect(container.textContent).toContain('Checking the source');
        // The header shows from the first step, folded to the latest rows.
        expect(container.querySelector('button[aria-controls]')?.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).toContain('Activity');
        const final = assistant('final', [text('final-text', 'The final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        expect(container.textContent).toContain('The final answer');
        expect(container.textContent).not.toContain('Checking the source');
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.getAttribute('aria-expanded')).toBe('false');
        expect(header?.textContent).toContain('Explored codebase');
        await act(async () => header?.click());
        expect(header?.textContent).toContain('Explored codebase');
        expect(container.textContent).toContain('Checking the source');
        expect(container.textContent).toContain('The final answer');
        await act(async () => root.render(<Harness record={turn([progress, { ...final, parts: [...final.parts] }])} />));
        expect(header?.getAttribute('aria-expanded')).toBe('true');
    });

    test('draws a page the agent showed above the answer, outside the folded Activity', async () => {
        const pagePart = (id: string, messageID: string, ok: boolean): Part => ({
            type: 'tool', tool: 'openchamber_render', id, callID: id, sessionID: 'session', messageID,
            state: {
                status: 'completed', input: { action: 'render.page', parameters: { html: '<p>chart</p>', title: `Page ${id}` } },
                output: '{}', metadata: { openchamber: { ok } }, time: { start: 1, end: 2 },
            },
        });
        const progress = assistant('progress', [text('progress-text', 'Drawing'), readPart, pagePart('early', 'progress', true), pagePart('refused', 'progress', false)], 'tool-calls');
        const final = assistant('final', [pagePart('late', 'final', true), text('final-text', 'Here it is')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        const frames = () => [...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'));
        // Both accepted pages sit with the answer, in the order they ran; the refused one does not.
        expect(frames()).toEqual(['Page early', 'Page late']);
        const finalMessage = container.querySelector('[data-fixture-message="final"]');
        expect(finalMessage?.textContent?.indexOf('Here it is')).toBeGreaterThan(-1);
        expect(finalMessage?.querySelectorAll('iframe')).toHaveLength(2);
        expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
        // Opening Activity shows the steps without drawing the pages a second time.
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Drawing');
        expect(frames()).toEqual(['Page early', 'Page late']);
    });

    test('keeps a page in view in a turn that ended without an answer', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'completed', input: { action: 'render.page', html: '<p>chart</p>', title: 'Drawn page' },
                output: '{}', metadata: { openchamber: { ok: true } }, time: { start: 1, end: 2 },
            },
        };
        const record = turn([assistant('progress', [text('progress-text', 'Still working'), readPart, page], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} retired />));
        // The steps fold away; the page stays below the fold, drawn once.
        expect(container.textContent).not.toContain('Still working');
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Drawn page']);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    test('draws what the agent does after a page below it while the turn works', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'asked',
            state: {
                status: 'completed', input: { action: 'render.page', html: '<p>pick</p>', title: 'Pick a layout', awaitAnswer: true },
                output: '{}', metadata: { openchamber: { ok: true, answer: { answered: true, summary: 'B', data: null } } }, time: { start: 1, end: 2 },
            },
        };
        const before = assistant('before', [text('before-text', 'Looking around'), readPart], 'tool-calls');
        const asked = assistant('asked', [page], 'tool-calls');
        // The reply is still being written: not yet marked final.
        const writing = assistant('writing', [text('writing-text', 'Building layout B')], undefined);
        await act(async () => root.render(<Harness record={turn([before, asked, writing])} />));

        const html = container.innerHTML;
        expect(html.indexOf('title="Pick a layout"')).toBeGreaterThan(-1);
        expect(html.indexOf('Building layout B')).toBeGreaterThan(html.indexOf('title="Pick a layout"'));
        expect(html.indexOf('Looking around')).toBeLessThan(html.indexOf('title="Pick a layout"'));
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    test('keeps a page that waits for the user\'s answer in view while its call runs', async () => {
        const page: Part = {
            type: 'tool', tool: 'openchamber_render', id: 'page', callID: 'page', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'running', input: { action: 'render.page', html: '<p>pick</p>', title: 'Pick a layout', awaitAnswer: true },
                time: { start: 1 },
            },
        };
        const record = turn([assistant('progress', [text('progress-text', 'Asking'), readPart, page], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).not.toContain('Asking');
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Pick a layout']);
        expect(container.querySelector('[data-html-render-status="waiting"]')).not.toBeNull();
    });

    test('keeps thinking in the final message inside Activity, not outside with the answer', async () => {
        const thinking: Part = { type: 'reasoning', id: 'thinking', messageID: 'final', sessionID: 'session', text: 'Private reasoning content', time: { start: 1, end: 2 } };
        const final = assistant('final', [thinking, text('final-text', 'Public answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([final])} />));
        expect(container.textContent).toContain('Public answer');
        expect(container.textContent).not.toContain('Private reasoning content');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Private reasoning content');
        expect(container.textContent).toContain('Public answer');
    });

    test('an interrupted turn folds all prose without fabricating a final answer', async () => {
        const record = turn([assistant('progress', [text('progress-text', 'Still working'), readPart], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} />));
        expect(container.textContent).toContain('Still working');
        expect(container.textContent).toContain('Activity');
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).not.toContain('Still working');
        expect(container.textContent).toContain('Activity');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
    });

    test('the answer copies the whole turn while each earlier step copies only itself', async () => {
        useUIStore.setState({ showSplitAssistantMessageActions: true });
        const copiedMessages: string[] = [];
        let copiedTurns = 0;
        const progress = assistant('progress', [text('progress-text', 'Checking the source'), readPart], 'tool-calls');
        const final = assistant('final', [text('final-text', 'The final answer')], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])}
            onCopyMessage={(messageId) => { copiedMessages.push(messageId); return true; }}
            onCopyTurn={async () => { copiedTurns += 1; return true; }} />));
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());

        const copyButton = (messageId: string) => container.querySelector<HTMLButtonElement>(
            `[data-fixture-message="${messageId}"] button[aria-label="Copy message text"]`,
        );
        await act(async () => copyButton('final')?.click());
        expect(copiedTurns).toBe(1);
        expect(copiedMessages).toEqual([]);

        await act(async () => copyButton('progress')?.click());
        expect(copiedTurns).toBe(1);
        expect(copiedMessages).toEqual(['progress']);
    });

    test('keeps file statistics visible when expanded and uses an ASCII minus', async () => {
        const edit: Part = {
            type: 'tool', tool: 'edit', id: 'edit', callID: 'edit', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: '',
                metadata: { diff: '@@ -1,1 +1,2 @@\n-old\n+new\n+added' }, time: { start: 1, end: 2 } },
        };
        await act(async () => root.render(<Harness record={turn([
            assistant('progress', [edit], 'tool-calls'),
            assistant('final', [text('answer', 'Done')], 'stop'),
        ])} />));
        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        expect(header?.textContent).toContain('Changed 1 file');
        expect(header?.textContent).toContain('+2/-1');
        await act(async () => header?.click());
        expect(header?.textContent).toContain('Changed 1 file');
        expect(header?.textContent).toContain('+2/-1');
    });

    test('shows at most four changed files and folds the rest into one chip, including at the threshold', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        for (const count of [0, 1, 3, 4, 5, 100]) {
            const files = Array.from({ length: count }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
            await act(async () => root.render(<Harness record={record} changedFiles={files} />));
            expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(Math.min(count, 4));
            const toggle = changedFilesToggle();
            if (count <= 4) {
                expect(toggle).toBeNull();
            } else {
                expect(toggle?.textContent).toBe(`+${count - 4}`);
                expect(toggle?.getAttribute('aria-label')).toBe(`Other changed files (${count - 4})`);
                expect(toggle?.getAttribute('aria-expanded')).toBe('false');
                expect(container.textContent).not.toContain('file-4.ts');
            }
        }
    });

    test('reveals the rest in source order, keeps them through updates and locale changes, then hides them with focus intact', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        const files = Array.from({ length: 100 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
        await act(async () => root.render(<Harness record={record} changedFiles={files} />));
        const toggle = changedFilesToggle();
        if (!toggle) throw new Error('Missing changed-file toggle');
        toggle.focus();
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(toggle.getAttribute('aria-label')).toBe('Show fewer files');
        expect(Array.from(container.querySelectorAll('button[aria-label^="Open src/file-"]'), (button) => button.getAttribute('title')))
            .toEqual(files.map((file) => file.file));
        expect(toggle.previousElementSibling?.getAttribute('title')).toBe('src/file-99.ts');
        await act(async () => root.render(<Harness record={record} changedFiles={[...files]} />));
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        await act(async () => {
            useI18nStore.getState().setLocale('uk');
            await import('@/lib/i18n/messages/uk');
        });
        expect(toggle.getAttribute('aria-label')).toBe('Показати менше файлів');
        await act(async () => toggle.click());
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(toggle.textContent).toBe('+96');
        expect(toggle.getAttribute('aria-label')).toBe('Інші змінені файли (96)');
        expect(document.activeElement).toBe(toggle);
        expect(container.textContent).not.toContain('file-4.ts');
        expect(container.querySelectorAll('button[aria-label^="Відкрити src/file-"]')).toHaveLength(4);
    });

    test('a file without line counts shows its name alone, and one outside the turn diff is not a button', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        await act(async () => root.render(<Harness record={record} changedFiles={[
            { file: 'src/a.ts' },
            { file: 'src/b.ts', additions: 1, deletions: 2 },
            { file: 'src/c.ts', additions: 1, deletions: 0, inTurnDiff: false },
        ]} />));
        expect(container.querySelector('button[aria-label="Open src/a.ts"]')?.textContent).toBe('a.ts');
        expect(container.querySelector('button[aria-label="Open src/b.ts"]')?.textContent).toBe('b.ts+1/-2');
        expect(container.querySelector('button[aria-label="Open src/c.ts"]')).toBeNull();
        expect(container.querySelector('span[title="src/c.ts"]')?.textContent).toBe('c.ts+1/-0');
    });

    test('keeps historical files informational and withholds the list before stop', async () => {
        const files = Array.from({ length: 5 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
        const final = assistant('final', [text('answer', 'Done')], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([final])} changedFiles={files} isLatestTurn={false} />));
        expect(container.textContent).not.toContain('file-0.ts');
        await act(async () => root.render(<Harness record={turn([assistant('final', final.parts, 'stop')])} changedFiles={files} isLatestTurn={false} />));
        expect(container.textContent).toContain('file-0.ts');
        await act(async () => changedFilesToggle()?.click());
        expect(container.textContent).toContain('file-4.ts');
        expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(0);
    });
});
