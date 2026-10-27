import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Part, AssistantMessage, ToolPart } from '@/lib/opencode/model';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider, useDirectoryStore as useSyncDirectoryStore } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnChangedFile, TurnRecord } from '../lib/turns/types';
import { LiveTurnActivity } from './LiveTurnActivity';
import { loadOpenUIProgram } from '../openuiRendererLoader';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { opencodeClient } from '@/lib/opencode/client';

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
const fixtureFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/event')) return new Response(new ReadableStream({ start(controller) {
        init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
    if (url.includes('/session-warming')) return Response.json({ revision: 1, enabled: false, minutes: 5, sessions: [] });
    if (url.includes('/api/fs/home')) return Response.json({ home: '/home/test' });
    if (url.includes('/api/location')) return Response.json({ directory: '/project', project: { directory: '/project' } });
    if (url.includes('/api/project') || url.includes('/api/config')) return Response.json([]);
    if (url.includes('/api/form') || url.includes('/api/permission')) return Response.json({ data: [] });
    if (url.includes('/api/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
    if (url.includes('/api/session/active')) return Response.json({ data: {} });
    if (url.includes('/api/shell')) return Response.json({ location: { directory: '/project' }, data: [] });
    if (url.includes('/api/session')) return Response.json({ data: [], cursor: {} });
    throw new Error(`Unexpected Activity request: ${url}`);
};
const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: fixtureFetch });
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

function SavedParts({ record, children }: { record: TurnRecord; children: React.ReactNode }) {
    const store = useSyncDirectoryStore('/project', { bootstrap: false });
    const [saved, setSaved] = React.useState<TurnRecord | null>(null);
    React.useLayoutEffect(() => {
        store.setState({ part: Object.fromEntries(record.assistantMessages.map((message) => [message.info.id, message.parts])) });
        setSaved(record);
    }, [record, store]);
    return saved ? children : null;
}

async function waitForFrames(container: HTMLElement, count: number) {
    for (let attempt = 0; attempt < 25 && container.querySelectorAll('iframe').length !== count; attempt++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    expect(container.querySelectorAll('iframe')).toHaveLength(count);
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
                <SavedParts record={record}>
                    <I18nProvider>
                        <LiveTurnActivity turn={record} hasLaterAssistant={retired} expanded={expanded}
                            onToggle={() => setExpanded((value) => !value)} renderMessage={renderMessage} />
                    </I18nProvider>
                </SavedParts>
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
        win.document.write('<!doctype html><html><head></head><body></body></html>');
        const globals = {
            window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage,
            customElements: win.customElements,
            Node: win.Node, NodeList: win.NodeList, Element: win.Element, HTMLElement: win.HTMLElement, SVGElement: win.SVGElement,
            HTMLAnchorElement: win.HTMLAnchorElement,
            MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
            requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
            fetch: fixtureFetch,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        // Reduced motion makes the disclosure lifecycle deterministic without
        // replacing the real component or animation module.
        restore = () => {
            void win.happyDOM.abort();
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
        useUIStore.setState({ collapsibleThinkingBlocks: false, showSplitAssistantMessageActions: false, agentRenderToolEnabled: true });
        useDirectoryStore.setState({ currentDirectory: '/project' });
        useI18nStore.getState().setLocale('en');
        configureRuntimeUrlResolver({ apiBaseUrl: 'http://localhost' });
        opencodeClient.reconnectToRuntimeBaseUrl();
        MessageBody = (await import('../message/MessageBody')).default;
        await loadOpenUIProgram();
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        restore();
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

    test('keeps Markdown HtmlViews with the final answer and mounts each once when Activity opens', async () => {
        const ui = 'root = Stack([HtmlView("<p>First</p>", null, "First page"), HtmlView("<p>Second</p>", null, "Second page")])';
        const progress = assistant('progress', [text('progress-text', 'Drawing'), readPart], 'tool-calls');
        const final = assistant('final', [{ ...text('final-text', `\`\`\`openui-lang\n${ui}\n\`\`\`\n\nHere it is`), messageID: 'final' }], 'stop');
        await act(async () => root.render(<Harness record={turn([progress, final])} />));
        await waitForFrames(container, 2);
        const frames = () => [...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'));
        expect(frames()).toEqual(['First page', 'Second page']);
        const finalMessage = container.querySelector('[data-fixture-message="final"]');
        expect(finalMessage?.textContent).toContain('Here it is');
        expect(finalMessage?.querySelectorAll('iframe')).toHaveLength(2);
        expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
        const firstFrame = container.querySelector('iframe');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Drawing');
        expect(frames()).toEqual(['First page', 'Second page']);
        expect(container.querySelector('iframe')).toBe(firstFrame);
    });

    test('keeps a waiting HtmlView outside a retired Activity fold without duplicate mounts', async () => {
        const page: Part = {
            type: 'tool', tool: 'prompt_openui', id: 'page', callID: 'page', sessionID: 'session', messageID: 'progress',
            state: {
                status: 'running', input: { ui: 'root = Stack([HtmlView("<p>pick</p>", null, "Pick a layout")])' },
                time: { start: 1 },
            },
        };
        const record = turn([assistant('progress', [text('progress-text', 'Asking'), readPart, page], 'tool-calls')]);
        await act(async () => root.render(<Harness record={record} retired />));
        await waitForFrames(container, 1);
        expect(container.textContent).not.toContain('Asking');
        expect([...container.querySelectorAll('iframe')].map((frame) => frame.getAttribute('title'))).toEqual(['Pick a layout']);
        const frame = container.querySelector('iframe');
        expect(frame?.closest('[data-live-activity-content]')).toBeNull();
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Asking');
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
        expect(container.querySelector('iframe')).toBe(frame);
    });

    test('returns an answered OpenUI prompt and subsequent work to Activity', async () => {
        const prompt: ToolPart = {
            type: 'tool', tool: 'prompt_openui', id: 'prompt', callID: 'prompt', sessionID: 'session', messageID: 'asked',
            state: { status: 'running', input: { ui: 'root = Stack([TextContent("Choose the next step"), HtmlView("<p>pick</p>", null, "Pick a layout")])' }, time: { start: 1 } },
        };
        const asked = assistant('asked', [prompt], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([asked])} />));
        await waitForFrames(container, 1);
        const interfaces = () => container.querySelectorAll('[data-oc-openui-source]');
        expect(interfaces().length).toBe(1);
        expect(interfaces()[0].closest('[data-live-activity-content]') === null).toBe(true);

        const answered: ToolPart = { ...prompt, state: {
            status: 'completed', input: prompt.state.input, output: '', time: { start: 1, end: 2 },
            metadata: { openchamber: { ok: true, answer: { answered: true, summary: 'Start implementation', data: null } } },
        } };
        const continued = assistant('continued', [text('working', 'Implementing the chosen direction'), readPart], 'tool-calls');
        const before = assistant('before', [text('before-text', 'Looking around')], 'tool-calls');
        const progress = [before, assistant('asked', [answered], 'tool-calls'), continued];
        await act(async () => root.render(<Harness record={turn(progress)} />));
        await waitForFrames(container, 1);
        expect(interfaces().length).toBe(1);
        expect(interfaces()[0].closest('[data-live-activity-content]') !== null).toBe(true);
        expect(container.querySelector('[data-live-activity-content] [data-fixture-message="continued"]') !== null).toBe(true);
        expect(container.innerHTML.indexOf('Looking around')).toBeLessThan(container.innerHTML.indexOf('title="Pick a layout"'));
        expect(container.innerHTML.indexOf('Implementing the chosen direction')).toBeGreaterThan(container.innerHTML.indexOf('title="Pick a layout"'));

        const final = assistant('final', [text('answer', 'Implementation complete')], 'stop');
        await act(async () => root.render(<Harness record={turn([...progress, final])} />));
        expect(interfaces().length).toBe(0);
        expect(container.querySelectorAll('iframe')).toHaveLength(0);
        expect(container.textContent).toContain('Implementation complete');
        expect(container.textContent).not.toContain('Implementing the chosen direction');

        const header = container.querySelector<HTMLButtonElement>('button[aria-controls]');
        await act(async () => header?.click());
        await waitForFrames(container, 1);
        expect(interfaces().length).toBe(1);
        expect(interfaces()[0].closest('[data-live-activity-content]') !== null).toBe(true);
        expect(container.textContent).toContain('Answered: Start implementation');
        await act(async () => header?.click());
        expect(interfaces().length).toBe(0);
        expect(container.querySelectorAll('iframe')).toHaveLength(0);
    });

    test('folds a stopped OpenUI prompt in a retired turn and restores it on expansion', async () => {
        const stopped: ToolPart = {
            type: 'tool', tool: 'prompt_openui', id: 'prompt', callID: 'prompt', sessionID: 'session', messageID: 'asked',
            state: { status: 'error', input: { ui: 'root = Stack([TextContent("Choose the next step")])' }, error: 'Stopped', time: { start: 1, end: 2 } },
        };
        await act(async () => root.render(<Harness record={turn([assistant('asked', [stopped], 'tool-calls')])} retired />));
        expect(container.querySelectorAll('[data-oc-openui-source]').length).toBe(0);
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.querySelectorAll('[data-oc-openui-source]').length).toBe(1);
        expect(container.querySelector('[data-live-activity-content] [data-oc-openui-source]') !== null).toBe(true);
        expect(container.textContent).toContain('Not answered');
    });

    test('folds a settled OpenUI prompt in the final message with its other tool parts', async () => {
        const prompt: ToolPart = {
            type: 'tool', tool: 'prompt_openui', id: 'prompt', callID: 'prompt', sessionID: 'session', messageID: 'final',
            state: {
                status: 'completed', input: { ui: 'root = Stack([TextContent("Choose the next step")])' }, output: '',
                metadata: { openchamber: { ok: true, answer: { answered: false, reason: 'chat' } } }, time: { start: 1, end: 2 },
            },
        };
        const final = assistant('final', [prompt, text('answer', 'Continuing from your chat reply')], 'stop');
        await act(async () => root.render(<Harness record={turn([final])} />));
        expect(container.querySelectorAll('[data-oc-openui-source]').length).toBe(0);
        expect(container.textContent).toContain('Continuing from your chat reply');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.querySelectorAll('[data-oc-openui-source]').length).toBe(1);
        expect(container.querySelector('[data-live-activity-content] [data-oc-openui-source]') !== null).toBe(true);
        expect(container.textContent).toContain('Answered in the chat');
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
