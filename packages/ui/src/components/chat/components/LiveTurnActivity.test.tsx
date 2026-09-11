import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Part, type AssistantMessage } from '@opencode-ai/sdk/v2';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { SyncProvider } from '@/sync/sync-context';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnChangedFile, TurnRecord } from '../lib/turns/types';
import { LiveTurnActivity } from './LiveTurnActivity';

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
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
    get tools() { return unavailable(); },
};
const sdk = createOpencodeClient({ baseUrl: 'http://localhost', fetch: async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } }) });
let MessageBody: typeof import('../message/MessageBody').default;

function assistant(id: string, parts: Part[], finish?: string): ChatMessageEntry {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', parentID: 'user', time: { created: 2, completed: finish ? 3 : undefined },
        modelID: 'model', providerID: 'provider', mode: 'build', agent: 'build', path: { cwd: '/project', root: '/project' },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    };
    return { info, parts };
}
function text(id: string, content: string): Part {
    return { type: 'text', id, text: content, sessionID: 'session', messageID: 'message' };
}
const readPart: Part = {
    type: 'tool', tool: 'read', id: 'read', callID: 'read', sessionID: 'session', messageID: 'progress',
    state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: 'code', title: 'Read', metadata: {}, time: { start: 1, end: 2 } },
};
function turn(messages: ChatMessageEntry[]): TurnRecord {
    return projectTurnRecords([{
        info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'provider', modelID: 'model' } },
        parts: [text('request', 'Request')],
    }, ...messages]).turns[0];
}

function Harness({ record, retired = false, changedFiles, isLatestTurn = true }: {
    record: TurnRecord;
    retired?: boolean;
    changedFiles?: TurnChangedFile[];
    isLatestTurn?: boolean;
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
                turnGroupingContext={{
                    turnId: 'user', isFirstAssistantInTurn: message === record.assistantMessages[0],
                    isLastAssistantInTurn: message === record.assistantMessages.at(-1),
                    isLatestTurn, changedFiles, isWorking: false, hasTools: record.hasTools, hasReasoning: record.hasReasoning,
                }}
            />
        </div>
    );
    return <RuntimeAPIContext.Provider value={runtimeApis}>
        <SyncProvider sdk={sdk} directory="/project">
            <I18nProvider>
                <LiveTurnActivity turn={record} hasLaterAssistant={retired} expanded={expanded}
                    onToggle={() => setExpanded((value) => !value)} renderMessage={renderMessage} />
            </I18nProvider>
        </SyncProvider>
    </RuntimeAPIContext.Provider>;
}

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
        useUIStore.setState({ chatRenderMode: 'live', collapsibleThinkingBlocks: false, showSplitAssistantMessageActions: false });
        useDirectoryStore.setState({ currentDirectory: '/project' });
        useI18nStore.getState().setLocale('en');
        MessageBody = (await import('../message/MessageBody')).default;
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        restore();
    });

    test('keeps active prose and tools visible; stop folds history but leaves the answer', async () => {
        const progress = assistant('progress', [text('progress-text', 'Checking the source'), readPart], 'tool-calls');
        await act(async () => root.render(<Harness record={turn([progress])} />));
        expect(container.textContent).toContain('Checking the source');
        expect(container.querySelector('[aria-controls]')).toBeNull();
        expect(container.textContent).not.toContain('Activity');
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
        expect(container.textContent).not.toContain('Activity');
        await act(async () => root.render(<Harness record={record} retired />));
        expect(container.textContent).not.toContain('Still working');
        expect(container.textContent).toContain('Activity');
        await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
        expect(container.textContent).toContain('Still working');
    });

    test('keeps file statistics visible when expanded and uses an ASCII minus', async () => {
        const edit: Part = {
            type: 'tool', tool: 'edit', id: 'edit', callID: 'edit', sessionID: 'session', messageID: 'progress',
            state: { status: 'completed', input: { filePath: '/project/source.ts' }, output: '', title: 'Edit',
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

    test('shows at most four changed files until expanded, including at the threshold', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        for (const count of [0, 1, 3, 4, 5, 100]) {
            const files = Array.from({ length: count }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
            await act(async () => root.render(<Harness record={record} changedFiles={files} />));
            expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(Math.min(count, 4));
            const trigger = container.querySelector<HTMLButtonElement>('[data-fixture-message="final"] button[aria-expanded]');
            if (count <= 4) {
                expect(trigger).toBeNull();
            } else {
                expect(trigger?.textContent).toBe(`Show more (${count - 4})`);
                expect(trigger?.getAttribute('aria-expanded')).toBe('false');
                expect(container.textContent).not.toContain('file-4.ts');
            }
        }
    });

    test('expands in source order, preserves state on updates and locale changes, then collapses with focus intact', async () => {
        const record = turn([assistant('final', [text('answer', 'Done')], 'stop')]);
        const files = Array.from({ length: 100 }, (_, index) => ({ file: `src/file-${index}.ts`, additions: 1, deletions: 0 }));
        await act(async () => root.render(<Harness record={record} changedFiles={files} />));
        const trigger = container.querySelector<HTMLButtonElement>('[data-fixture-message="final"] button[aria-expanded]');
        if (!trigger) throw new Error('Missing changed-file disclosure');
        trigger.focus();
        await act(async () => trigger.click());
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(trigger.textContent).toBe('Collapse');
        expect(Array.from(container.querySelectorAll('button[aria-label^="Open src/file-"]'), (button) => button.getAttribute('title')))
            .toEqual(files.map((file) => file.file));
        expect(document.getElementById(trigger.getAttribute('aria-controls') ?? '')?.textContent).toContain('file-99.ts');
        await act(async () => root.render(<Harness record={record} changedFiles={[...files]} />));
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        await act(async () => {
            useI18nStore.getState().setLocale('uk');
            await import('@/lib/i18n/messages/uk');
        });
        expect(trigger.textContent).toBe('Згорнути');
        await act(async () => trigger.click());
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(trigger.textContent).toBe('Показати ще (96)');
        expect(document.activeElement).toBe(trigger);
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
        await act(async () => container.querySelector<HTMLButtonElement>('[data-fixture-message="final"] button[aria-expanded]')?.click());
        expect(container.textContent).toContain('file-4.ts');
        expect(container.querySelectorAll('button[aria-label^="Open src/file-"]')).toHaveLength(0);
    });
});
